import { ErrorCode } from "../../shared/protocol.js";
import { DISCOVERY_FETCH_TIMEOUT_MS, TOOL_SEPARATOR } from "../core/constants.js";
import { timeoutSignal } from "../core/fetch-timeout.js";
import type { ProxyState } from "../core/state.js";

// Typed error so the handlers layer can map a thrown failure straight to a
// JSON-RPC error code without a second taxonomy. Anything thrown out of
// RestartHandler.run carries one of ErrorCode.INVALID_PARAMS,
// HOST_UNREACHABLE, or INTERNAL.
export class RestartError extends Error {
  constructor(public readonly code: number, message: string) {
    super(message);
    this.name = "RestartError";
  }
}

// Owns the restart_server pipeline shared between the tool and prompt
// dispatch paths in RequestHandlers. Pure orchestrator — owns no state of
// its own; consults ProxyState for host resolution and POSTs the host's
// admin endpoint.
export class RestartHandler {
  constructor(private readonly state: ProxyState) {}

  // Parse the (tool? | host+server) input shape. Returns the resolved
  // (host, server) pair or throws RestartError(INVALID_PARAMS) with a
  // message the LLM can self-correct on.
  parse(args: Record<string, unknown> | undefined): { host: string; server: string } {
    const tool = typeof args?.tool === "string" ? args.tool : undefined;
    const host = typeof args?.host === "string" ? args.host : undefined;
    const server = typeof args?.server === "string" ? args.server : undefined;

    const hasTool = tool !== undefined && tool.length > 0;
    const hasPair = host !== undefined && host.length > 0 && server !== undefined && server.length > 0;
    const hasHalfPair = (host !== undefined && host.length > 0) !== (server !== undefined && server.length > 0);

    if (hasTool && (host !== undefined || server !== undefined)) {
      throw new RestartError(ErrorCode.INVALID_PARAMS, "exactly one of `tool` or `(host, server)` is required");
    }
    if (!hasTool && !hasPair) {
      if (hasHalfPair) {
        throw new RestartError(ErrorCode.INVALID_PARAMS, "both `host` and `server` are required when `tool` is not provided");
      }
      throw new RestartError(ErrorCode.INVALID_PARAMS, "exactly one of `tool` or `(host, server)` is required");
    }
    if (hasPair) return { host: host!, server: server! };

    // Parse `<host>__<server>[__<tool…>]`. host id and server name both
    // pass validateServerName at ingress (forbids `__`), so two indexOf
    // calls is sound — tool name segment may itself contain `__` and is
    // discarded.
    const sep = TOOL_SEPARATOR;
    const firstSep = tool!.indexOf(sep);
    if (firstSep < 0) {
      throw new RestartError(
        ErrorCode.INVALID_PARAMS,
        `tool must be <host>__<server> or <host>__<server>__<tool>; if your client shows it as mcp__<alias>__..., strip that prefix first`,
      );
    }
    const parsedHost = tool!.slice(0, firstSep);
    if (parsedHost.length === 0) {
      throw new RestartError(ErrorCode.INVALID_PARAMS, "tool has empty host segment");
    }
    const afterHost = tool!.slice(firstSep + sep.length);
    const secondSep = afterHost.indexOf(sep);
    const parsedServer = secondSep < 0 ? afterHost : afterHost.slice(0, secondSep);
    if (parsedServer.length === 0) {
      throw new RestartError(ErrorCode.INVALID_PARAMS, "tool has empty server segment");
    }
    return { host: parsedHost, server: parsedServer };
  }

  // Resolve, dispatch, return the resolved pair on success. The proxy does
  // NOT mutate `server.sessionId`, `subscriptions`, or `sseControllers`
  // here — the existing 404 recovery in forwarder.ts handles re-init
  // naturally on the next forward, so all three triggers (idle GC, host
  // restart, restart_server) flow through one path.
  async run(args: Record<string, unknown> | undefined): Promise<{ host: string; server: string }> {
    const { host: hostId, server: serverName } = this.parse(args);

    const host = this.state.hosts.get(hostId);
    if (!host) {
      const available = Array.from(this.state.hosts.keys()).join(", ") || "(none paired)";
      throw new RestartError(ErrorCode.INVALID_PARAMS, `Unknown host: ${hostId} (available: ${available})`);
    }

    const url = `${host.config.tunnelUrl}/admin/restart`;
    let resp: Response;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: this.state.hostHeaders(host.config),
        signal: timeoutSignal(DISCOVERY_FETCH_TIMEOUT_MS),
        body: JSON.stringify({ server: serverName }),
      });
    } catch (err) {
      throw new RestartError(ErrorCode.HOST_UNREACHABLE, `Host unreachable: ${(err as Error).message}`);
    }

    const text = await resp.text();
    if (resp.status === 404) {
      // Host returned the same shape as /servers/:name miss; surface its
      // `available` list so the LLM can self-correct without another
      // discovery round-trip.
      let available = "(unknown)";
      try {
        const body = JSON.parse(text) as { available?: unknown };
        if (Array.isArray(body.available)) available = body.available.join(", ");
      } catch { /* fall through with placeholder */ }
      throw new RestartError(
        ErrorCode.INVALID_PARAMS,
        `Unknown server: ${serverName} on ${hostId} (available: ${available})`,
      );
    }
    if (resp.status === 401) {
      throw new RestartError(ErrorCode.HOST_UNREACHABLE, `Host rejected admin bearer (401) for ${hostId}`);
    }
    if (!resp.ok) {
      throw new RestartError(
        ErrorCode.HOST_UNREACHABLE,
        `Host returned ${resp.status} for ${hostId}: ${text.slice(0, 200)}`,
      );
    }
    return { host: hostId, server: serverName };
  }
}
