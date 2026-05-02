import { ErrorCode } from "../../shared/protocol.js";
import { SESSION_DELETE_TIMEOUT_MS, TOOL_FORWARD_TIMEOUT_MS, UPSTREAM_REQUEST_TIMEOUT_MS } from "../core/constants.js";
import { timeoutSignal } from "../core/fetch-timeout.js";
import type { HostConfig, HostState } from "../core/types.js";

interface BridgedRequest {
  hostId: string;
  serverName: string;
  sessionId: string;
  originalId: string | number;
  timer: ReturnType<typeof setTimeout>;
}

// Bridges server-initiated MCP requests (sampling/createMessage,
// elicitation/create, roots/list, ping, …) from an upstream session out to
// the agent and back. The agent sees a synthetic id (`proxy-srv-N`); the
// upstream sees its original id. Maintaining a separate id namespace from
// `inflight` (which covers agent→server requests) means a cancellation can
// always identify the correct half of the bridge.
export class UpstreamBridge {
  private requests = new Map<string | number, BridgedRequest>();
  private counter = 0;

  constructor(
    private readonly hostHeaders: (host: HostConfig) => Record<string, string>,
    private readonly captureSessionId: (host: HostState, serverName: string, newId: string | null) => void,
    private readonly writeToAgent: (line: string) => void,
  ) {}

  // Register an upstream request and forward its synthetic-id form to the
  // agent. UPSTREAM_REQUEST_TIMEOUT_MS later (default 120s) we tell the
  // upstream we never got an answer so its child stops waiting.
  bridge(
    host: HostState,
    serverName: string,
    msg: { id: string | number; method: string; params?: unknown },
  ): void {
    const server = host.servers.get(serverName);
    if (!server || !server.sessionId) return;

    const newId = `proxy-srv-${++this.counter}`;
    // Snapshot the originating session id. server.sessionId can rotate via
    // captureSessionId between bridge() and the timeout firing; the timeout
    // response must go to the session that asked, not whatever the host has
    // most recently issued for this server.
    const sessionId = server.sessionId;
    const timer = setTimeout(() => {
      this.requests.delete(newId);
      void this.postResponse(host, serverName, sessionId, {
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: ErrorCode.REQUEST_TIMEOUT, message: "Client did not respond in time" },
      });
    }, UPSTREAM_REQUEST_TIMEOUT_MS);
    timer.unref();

    this.requests.set(newId, {
      hostId: host.config.id,
      serverName,
      sessionId,
      originalId: msg.id,
      timer,
    });

    this.writeToAgent(JSON.stringify({
      jsonrpc: "2.0",
      id: newId,
      method: msg.method,
      params: msg.params,
    }));
  }

  // Agent's response arrives with our synthetic id; restore the original id
  // and post it to the upstream session that asked.
  routeResponse(
    hosts: Map<string, HostState>,
    id: string | number,
    msg: { jsonrpc?: string; id?: string | number | null; result?: unknown; error?: unknown },
  ): void {
    const ctx = this.requests.get(id);
    if (!ctx) return;
    clearTimeout(ctx.timer);
    this.requests.delete(id);

    const host = hosts.get(ctx.hostId);
    if (!host) return;

    const body: Record<string, unknown> = { jsonrpc: "2.0", id: ctx.originalId };
    if (msg.error !== undefined) body.error = msg.error;
    else body.result = msg.result ?? null;

    void this.postResponse(host, ctx.serverName, ctx.sessionId, body);
  }

  // Used by handleClientNotification when the agent cancels a bridged
  // request: clear our tracking, return the original id so the caller can
  // forward `notifications/cancelled` upstream with the upstream's own id.
  consumeForCancel(id: string | number): { hostId: string; serverName: string; originalId: string | number } | null {
    const ctx = this.requests.get(id);
    if (!ctx) return null;
    clearTimeout(ctx.timer);
    this.requests.delete(id);
    return { hostId: ctx.hostId, serverName: ctx.serverName, originalId: ctx.originalId };
  }

  // Tear down on session close / re-pair. Two responsibilities:
  //   1) cancel timers so the event loop can exit and so a stale timer
  //      doesn't post a REQUEST_TIMEOUT response after we've already
  //      answered with INTERNAL below;
  //   2) proactively answer each pending upstream request with a JSON-RPC
  //      error so the upstream child stops waiting on its own
  //      UPSTREAM_REQUEST_TIMEOUT_MS (120s). closeAllSessions DELETEs the
  //      session right after, but DELETE is fired-and-forgotten — without
  //      this, a network blip on the DELETE leaves the child stalled until
  //      its own timeout. Map is cleared first so a late routeResponse
  //      becomes a no-op rather than a duplicate post.
  async clear(hosts: Map<string, HostState>): Promise<void> {
    const pending = Array.from(this.requests.values());
    this.requests.clear();
    for (const ctx of pending) clearTimeout(ctx.timer);
    await Promise.allSettled(pending.map((ctx) => {
      const host = hosts.get(ctx.hostId);
      if (!host) return;
      // Teardown courtesy — share the DELETE budget, not the 5-min tool
      // budget. A blackholed host would otherwise stall closeAllSessions
      // (re-pair, rollback, SIGTERM shutdown) until TOOL_FORWARD_TIMEOUT_MS.
      // The DELETE that follows reaps the session anyway; if this courtesy
      // doesn't land quickly the upstream's own UPSTREAM_REQUEST_TIMEOUT_MS
      // catches the orphaned child.
      return this.postResponse(host, ctx.serverName, ctx.sessionId, {
        jsonrpc: "2.0",
        id: ctx.originalId,
        error: { code: ErrorCode.INTERNAL, message: "proxy reconfigured before client responded" },
      }, SESSION_DELETE_TIMEOUT_MS);
    }));
  }

  private async postResponse(
    host: HostState,
    serverName: string,
    sessionId: string,
    body: Record<string, unknown>,
    timeoutMs: number = TOOL_FORWARD_TIMEOUT_MS,
  ): Promise<void> {
    const target = `${host.config.tunnelUrl}/servers/${serverName}`;
    const headers = { ...this.hostHeaders(host.config), "Mcp-Session-Id": sessionId };
    try {
      const resp = await fetch(target, {
        method: "POST",
        headers,
        signal: timeoutSignal(timeoutMs),
        body: JSON.stringify(body),
      });
      this.captureSessionId(host, serverName, resp.headers.get("mcp-session-id"));
    } catch {
      // Upstream unreachable — server will time out on its end.
    }
  }
}
