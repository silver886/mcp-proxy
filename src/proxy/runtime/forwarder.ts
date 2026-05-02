import { ErrorCode } from "../../shared/protocol.js";
import { TOOL_FORWARD_TIMEOUT_MS } from "../core/constants.js";
import { timeoutSignal } from "../core/fetch-timeout.js";
import type { ProxyState } from "../core/state.js";
import type { HostState, ServerState, ToolRoute } from "../core/types.js";
import type { DiscoveryRunner } from "../discovery/runner.js";
import { isUnknownSessionError } from "../pairing/validation.js";
import { wrapResourceUri } from "../routing/uri.js";

// All agent→server (and proxy→server) HTTP traffic flows through this
// class. It owns the request/response shape, stale-session 404 retry,
// resources/read URI wrapping, and the per-request id bookkeeping that
// notifications/cancelled relies on. It does NOT own discovery/init —
// when a session is reaped under us it asks DiscoveryRunner to re-init.
export class Forwarder {
  constructor(
    private readonly state: ProxyState,
    private readonly runner: DiscoveryRunner,
    private readonly log: (line: string) => void,
    private readonly sendError: (code: number, detail: string | undefined, id: string | number | null) => void,
    private readonly writeOut: (line: string) => void,
  ) {}

  async forwardRoutedRequest(
    id: string | number,
    route: ToolRoute,
    method: string,
    upstreamParams: unknown,
  ): Promise<void> {
    const host = this.state.hosts.get(route.hostId);
    const server = host?.servers.get(route.serverName);
    if (!host || !server) {
      this.sendError(ErrorCode.INTERNAL, `route stale: ${route.hostId}/${route.serverName}`, id);
      return;
    }

    const targetUrl = `${host.config.tunnelUrl}/servers/${route.serverName}`;
    const buildHeaders = (sessionId: string | undefined): Record<string, string> => {
      const h = this.state.hostHeaders(host.config);
      if (sessionId) h["Mcp-Session-Id"] = sessionId;
      return h;
    };
    const body = JSON.stringify({ jsonrpc: "2.0", id, method, params: upstreamParams });

    // Snapshot the active pairing so a re-pair landing while this fetch is
    // in flight can be detected before we write a stale response back to the
    // agent. closeAllSessions clears state.inflight, but our local closure
    // still holds the id/route, so without this guard the OLD pairing's
    // response (or its upstream-level error) would be emitted on stdout
    // against a pairing that no longer exists.
    const startGeneration = this.state.configGeneration;

    this.state.inflight.set(id, route);
    const progressToken = ((upstreamParams as { _meta?: { progressToken?: string | number } } | null)?._meta?.progressToken);
    if (progressToken !== undefined) this.state.progressTokens.set(progressToken, route);
    try {
      let upstream = await fetch(targetUrl, {
        method: "POST",
        headers: buildHeaders(server.sessionId),
        signal: timeoutSignal(TOOL_FORWARD_TIMEOUT_MS),
        body,
      });
      this.runner.captureSessionId(host, route.serverName, server, upstream.headers.get("mcp-session-id"));

      let responseBody = await upstream.text();

      // Stale session recovery: the host now refuses unknown ids with 404
      // instead of silently spawning a fresh, uninitialized child. Re-run
      // the MCP handshake for this one server and retry the call exactly
      // once.
      if (upstream.status === 404 && isUnknownSessionError(responseBody)) {
        this.log(`[${route.hostId}/${route.serverName}] session lost, re-initializing`);
        const before = host.servers.get(route.serverName);
        // Snapshot subscriptions BEFORE initServer overwrites the state
        // with a fresh empty set. The new session has no record of any
        // subscribe call the agent made on the old one, so we replay
        // each URI after init lands.
        const priorSubscriptions = before ? Array.from(before.subscriptions) : [];
        await this.runner.initServer(host, route.serverName);
        const refreshed = host.servers.get(route.serverName);
        if (!refreshed || refreshed === before) {
          this.sendError(ErrorCode.HOST_UNREACHABLE, `re-init failed for ${route.hostId}/${route.serverName}`, id);
          return;
        }
        if (priorSubscriptions.length > 0) {
          await this.replaySubscriptions(host, route.serverName, refreshed, priorSubscriptions);
        }
        upstream = await fetch(targetUrl, {
          method: "POST",
          headers: buildHeaders(refreshed.sessionId),
          signal: timeoutSignal(TOOL_FORWARD_TIMEOUT_MS),
          body,
        });
        this.runner.captureSessionId(host, route.serverName, refreshed, upstream.headers.get("mcp-session-id"));
        responseBody = await upstream.text();
      }

      // Pairing changed underneath us between dispatch and response. Reply
      // with a generic error so the request doesn't hang — the agent can
      // retry against the new pairing — but don't write the stale body or
      // its upstream-level error, since neither applies to the new config.
      if (this.state.configGeneration !== startGeneration) {
        this.sendError(ErrorCode.INTERNAL, "request superseded by reconfiguration", id);
        return;
      }

      if (!upstream.ok) {
        this.sendError(ErrorCode.HOST_UNREACHABLE, `host returned ${upstream.status}: ${responseBody.slice(0, 200)}`, id);
        return;
      }

      let parsed: { jsonrpc?: string; id?: string | number | null; result?: unknown; error?: unknown };
      try {
        parsed = JSON.parse(responseBody);
      } catch {
        this.sendError(ErrorCode.INTERNAL, `host returned non-JSON body: ${responseBody.slice(0, 200)}`, id);
        return;
      }

      const isJsonRpc = parsed.jsonrpc === "2.0" && (parsed.result !== undefined || parsed.error !== undefined);
      if (!isJsonRpc) {
        this.sendError(ErrorCode.INTERNAL, "host returned non-JSON-RPC body", id);
        return;
      }

      // Track subscribe/unsubscribe state on success only — a JSON-RPC
      // error means the upstream rejected the call and the subscription
      // state didn't actually change. Use the live `host.servers.get()`
      // result rather than the captured `server` so a re-init mid-call
      // commits to the post-recovery state.
      if (parsed.error === undefined && (method === "resources/subscribe" || method === "resources/unsubscribe")) {
        const uri = (upstreamParams as { uri?: unknown } | null)?.uri;
        if (typeof uri === "string") {
          const live = host.servers.get(route.serverName);
          if (live) {
            if (method === "resources/subscribe") live.subscriptions.add(uri);
            else live.subscriptions.delete(uri);
          }
        }
      }

      // resources/read response carries its own list of `contents[i].uri`,
      // which the upstream emits in its own URI namespace (e.g., reading a
      // directory returns concrete file URIs the agent never saw in
      // resources/list). Wrap each so the agent sees a URI it can route
      // back through the proxy on a subsequent read/subscribe.
      if (method === "resources/read" && parsed.result !== undefined) {
        const result = parsed.result as { contents?: unknown };
        if (Array.isArray(result.contents)) {
          result.contents = result.contents.map((entry) => {
            if (entry && typeof entry === "object" && typeof (entry as { uri?: unknown }).uri === "string") {
              const e = entry as { uri: string };
              return { ...e, uri: wrapResourceUri(route.hostId, route.serverName, e.uri) };
            }
            return entry;
          });
        }
      }

      parsed.id = id;
      this.writeOut(JSON.stringify(parsed));
    } catch (err) {
      // Same supersession guard as the success path: if the abort/error
      // raced a re-pair, the agent should see "superseded" rather than the
      // raw transport error from a pairing that no longer exists.
      if (this.state.configGeneration !== startGeneration) {
        this.sendError(ErrorCode.INTERNAL, "request superseded by reconfiguration", id);
        return;
      }
      this.sendError(ErrorCode.HOST_UNREACHABLE, (err as Error).message, id);
    } finally {
      this.state.inflight.delete(id);
      if (progressToken !== undefined) this.state.progressTokens.delete(progressToken);
    }
  }

  // Re-issue resources/subscribe for each URI the agent had subscribed on
  // the prior session. Best-effort: a URI that fails to re-subscribe is
  // dropped from the new set so we don't claim a subscription we don't
  // actually hold. Logged for visibility but not surfaced to the agent —
  // the agent never saw the session rotate.
  private async replaySubscriptions(
    host: HostState,
    serverName: string,
    refreshed: ServerState,
    uris: string[],
  ): Promise<void> {
    const targetUrl = `${host.config.tunnelUrl}/servers/${serverName}`;
    const headers = { ...this.state.hostHeaders(host.config), "Mcp-Session-Id": refreshed.sessionId! };
    await Promise.allSettled(uris.map(async (uri) => {
      try {
        const resp = await fetch(targetUrl, {
          method: "POST",
          headers,
          signal: timeoutSignal(TOOL_FORWARD_TIMEOUT_MS),
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: `resub-${host.config.id}-${serverName}-${Date.now()}-${uri}`,
            method: "resources/subscribe",
            params: { uri },
          }),
        });
        this.runner.captureSessionId(host, serverName, refreshed, resp.headers.get("mcp-session-id"));
        if (!resp.ok) {
          this.log(`  [${host.config.id}/${serverName}] resubscribe ${uri} HTTP ${resp.status}`);
          return;
        }
        const text = await resp.text();
        try {
          const payload = JSON.parse(text) as { error?: { message?: string } };
          if (payload.error) {
            this.log(`  [${host.config.id}/${serverName}] resubscribe ${uri} rejected: ${payload.error.message ?? "(no message)"}`);
            return;
          }
        } catch {
          // unparseable body — treat as best-effort success
        }
        refreshed.subscriptions.add(uri);
      } catch (err) {
        this.log(`  [${host.config.id}/${serverName}] resubscribe ${uri} failed: ${(err as Error).message}`);
      }
    }));
  }

  async forwardNotification(route: ToolRoute, method: string, params: unknown): Promise<void> {
    const host = this.state.hosts.get(route.hostId);
    const server = host?.servers.get(route.serverName);
    if (!host || !server || !server.sessionId) return;

    const target = `${host.config.tunnelUrl}/servers/${route.serverName}`;
    const headers = { ...this.state.hostHeaders(host.config), "Mcp-Session-Id": server.sessionId };
    const resp = await fetch(target, {
      method: "POST",
      headers,
      signal: timeoutSignal(TOOL_FORWARD_TIMEOUT_MS),
      body: JSON.stringify({ jsonrpc: "2.0", method, params }),
    });
    this.runner.captureSessionId(host, route.serverName, server, resp.headers.get("mcp-session-id"));
  }

  // logging/setLevel has no per-server addressing in the protocol. Issue
  // the same level to every paired session in parallel; aggregate failures
  // into stderr and return success to the agent — partial setLevel is
  // still a meaningful change.
  async broadcastSetLogLevel(params: Record<string, unknown>): Promise<void> {
    const targets: Array<{ host: HostState; serverName: string; server: ServerState }> = [];
    for (const host of this.state.hosts.values()) {
      for (const [serverName, server] of host.servers) {
        if (!server.sessionId) continue;
        targets.push({ host, serverName, server });
      }
    }
    await Promise.allSettled(targets.map(async ({ host, serverName, server }) => {
      const target = `${host.config.tunnelUrl}/servers/${serverName}`;
      const headers = { ...this.state.hostHeaders(host.config), "Mcp-Session-Id": server.sessionId! };
      try {
        const resp = await fetch(target, {
          method: "POST",
          headers,
          signal: timeoutSignal(TOOL_FORWARD_TIMEOUT_MS),
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: `loglevel-${host.config.id}-${serverName}-${Date.now()}`,
            method: "logging/setLevel",
            params,
          }),
        });
        this.runner.captureSessionId(host, serverName, server, resp.headers.get("mcp-session-id"));
        if (!resp.ok) {
          this.log(`  [${host.config.id}/${serverName}] logging/setLevel HTTP ${resp.status}`);
          return;
        }
        // HTTP 200 can still wrap a JSON-RPC error (invalid level, server
        // rejection). Read the body and surface it — silently ignoring an
        // upstream's "no thanks" makes invalid levels look applied.
        const text = await resp.text();
        if (!text) return;
        let payload: { error?: { code?: number; message?: string } } | undefined;
        try {
          payload = JSON.parse(text) as typeof payload;
        } catch {
          return; // unparseable — not our concern, treat as best-effort success
        }
        if (payload?.error) {
          const code = payload.error.code ?? "?";
          const message = payload.error.message ?? "(no message)";
          this.log(`  [${host.config.id}/${serverName}] logging/setLevel rejected: ${code} ${message}`);
        }
      } catch (err) {
        this.log(`  [${host.config.id}/${serverName}] logging/setLevel failed: ${(err as Error).message}`);
      }
    }));
  }
}
