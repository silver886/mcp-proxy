import { ErrorCode, jsonRpcError, LineBuffer } from "../shared/protocol.js";
import { ProxyState } from "./core/state.js";
import type { HostConfig, Prompt, Resource, ResourceTemplate, Tool } from "./core/types.js";
import { DiscoveryRunner } from "./discovery/runner.js";
import { PairingController } from "./pairing/controller.js";
import { Forwarder } from "./runtime/forwarder.js";
import { RequestHandlers } from "./runtime/handlers.js";
import { SseReader } from "./runtime/sse.js";
import { UpstreamBridge } from "./runtime/upstream-bridge.js";

// Composition root + JSON-RPC line router. Holds no business logic of
// its own — just wires up the modules:
//   ProxyState        — data the rest share
//   SseReader         — upstream→agent notification stream
//   UpstreamBridge    — server-initiated request bridge
//   DiscoveryRunner   — discovery + refresh + per-server init
//   Forwarder         — agent→server forwarding + broadcasting
//   PairingController — pairing flow + atomic config swap
//   RequestHandlers   — per-method JSON-RPC handlers
// stdin-line in, stdout-line out; everything else is module composition.
export class ProxyServer {
  private state = new ProxyState();
  private sse: SseReader;
  private bridge: UpstreamBridge;
  private runner: DiscoveryRunner;
  private forwarder: Forwarder;
  private pairing: PairingController;
  private handlers: RequestHandlers;

  constructor() {
    const writeOut = (line: string): void => { process.stdout.write(line + "\n"); };
    const log = (line: string): void => { process.stderr.write(line + "\n"); };
    const sendResult = (id: string | number | null, result: unknown): void => {
      writeOut(JSON.stringify({ jsonrpc: "2.0", id, result }));
    };
    const sendError = (code: number, detail: string | undefined, id: string | number | null): void => {
      writeOut(jsonRpcError(code, detail, id));
    };
    const sendNotification = (method: string): void => {
      writeOut(JSON.stringify({ jsonrpc: "2.0", method }));
    };

    // Build the SSE/bridge pair first — they expose narrow callback
    // interfaces that DiscoveryRunner / Forwarder need to wire into.
    this.sse = new SseReader({
      isCurrent: (host, name, sessionId) => {
        if (this.state.hosts.get(host.config.id) !== host) return false;
        const server = host.servers.get(name);
        return !!server && server.sessionId === sessionId;
      },
      onUpstreamRequest: (host, name, msg) => this.bridge.bridge(host, name, msg),
      onListChanged: async (host, name, kind) => {
        if (kind === "tools") await this.runner.refreshTools(host, name);
        else if (kind === "prompts") await this.runner.refreshPrompts(host, name);
        else await this.runner.refreshResources(host, name);
      },
      onNotification: (msg) => writeOut(JSON.stringify(msg)),
    });

    this.bridge = new UpstreamBridge(
      (host) => this.state.hostHeaders(host),
      (host, serverName, newId) => {
        const server = host.servers.get(serverName);
        if (server) this.runner.captureSessionId(host, serverName, server, newId);
      },
      writeOut,
    );

    this.runner = new DiscoveryRunner(this.state, this.sse, log);
    this.forwarder = new Forwarder(this.state, this.runner, log, sendError, writeOut);
    this.pairing = new PairingController(this.state, this.runner, this.bridge, log, sendNotification);
    this.handlers = new RequestHandlers(
      this.state,
      this.runner,
      this.forwarder,
      this.pairing,
      this.bridge,
      sendResult,
      sendError,
    );
  }

  start(): void {
    const stdinBuffer = new LineBuffer();
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk: string) => {
      for (const line of stdinBuffer.push(chunk)) {
        this.handleLine(line).catch((err) => {
          process.stderr.write(`Proxy error: ${(err as Error).message}\n`);
        });
      }
    });

    const shutdown = (exitCode: number): void => {
      this.pairing.teardownPairing();
      this.pairing.closeAllSessions().finally(() => process.exit(exitCode));
    };
    process.stdin.on("end", () => shutdown(0));
    process.on("SIGINT", () => shutdown(0));
    process.on("SIGTERM", () => shutdown(0));

    process.stderr.write(`Proxy ready (idle). Call the \`configure\` tool to begin pairing.\n`);
  }

  private async handleLine(line: string): Promise<void> {
    let parsed: { id?: string | number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown };
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      // Per JSON-RPC: parse failure → reply with id:null since we couldn't
      // recover one. Silent drop here would leave the agent waiting on a
      // request it thinks is in flight.
      process.stdout.write(jsonRpcError(ErrorCode.PARSE_ERROR, (err as Error).message, null) + "\n");
      return;
    }

    const hasMethod = typeof parsed.method === "string";
    const hasId = parsed.id !== undefined && parsed.id !== null;
    const isResponse = !hasMethod && hasId && (parsed.result !== undefined || parsed.error !== undefined);

    // Response from the client to a server-initiated request we previously
    // bridged out (sampling, elicitation, roots/list, ping, …). Route it
    // back to the upstream session that asked. Require result/error so a
    // bare `{id:N}` falls into the invalid-request path below instead of
    // being silently swallowed by routeResponse's unknown-id no-op.
    if (isResponse) {
      this.bridge.routeResponse(this.state.hosts, parsed.id!, parsed);
      return;
    }

    if (!hasMethod) {
      // Neither a request (no method), a notification (no method either),
      // nor a well-formed response (no result/error). Reply per spec so
      // the agent doesn't hang; carry parsed.id when we have one.
      process.stdout.write(jsonRpcError(ErrorCode.INVALID_REQUEST, "missing method", parsed.id ?? null) + "\n");
      return;
    }

    // JSON-RPC 2.0 discourages id:null in requests because the spec
    // reserves null for "id couldn't be parsed" in error responses
    // (we use it ourselves at the PARSE_ERROR / missing-method paths).
    // Falling through to the notification branch here would silently
    // drop a request the agent expects an answer to; reject explicitly
    // so the agent sees a real error instead of hanging.
    if (parsed.id === null) {
      process.stdout.write(jsonRpcError(ErrorCode.INVALID_REQUEST, "id must not be null in a request", null) + "\n");
      return;
    }

    if (!hasId) {
      await this.handlers.handleClientNotification(parsed.method!, parsed.params ?? {});
      return;
    }

    const id = parsed.id!;
    switch (parsed.method) {
      case "initialize":
        return this.handlers.handleInitialize(id, parsed.params as { capabilities?: Record<string, unknown>; clientInfo?: { name?: string; version?: string } } | undefined);

      case "ping":
        // MCP `ping` is a connection-liveness no-op between two endpoints.
        // The agent's peer here is the proxy itself, so we answer locally
        // — there is nothing to forward and no upstream to pick when many
        // servers are paired.
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result: {} }) + "\n");
        return;

      case "tools/list":
        return this.handlers.handleToolsList(id);

      case "prompts/list":
        return this.handlers.handlePromptsList(id);

      case "prompts/get":
        return this.handlers.handlePromptDispatch(id, parsed.params as { name?: string; arguments?: Record<string, unknown> } | undefined);

      case "resources/list":
        return this.handlers.handleResourcesList(id);

      case "resources/templates/list":
        return this.handlers.handleResourceTemplatesList(id);

      case "resources/read":
      case "resources/subscribe":
      case "resources/unsubscribe":
        return this.handlers.handleResourceMethod(id, parsed.method!, parsed.params as { uri?: string } | undefined);

      case "logging/setLevel":
        return this.handlers.handleLoggingSetLevel(id, (parsed.params ?? {}) as Record<string, unknown>);

      case "completion/complete":
        return this.handlers.handleCompletion(id, (parsed.params ?? {}) as { ref?: { type?: string; name?: string; uri?: string }; argument?: unknown });

      case "tools/call":
        return this.handlers.handleToolDispatch(id, parsed.params as { name?: string; arguments?: Record<string, unknown>; _meta?: unknown } | undefined);

      default:
        process.stdout.write(jsonRpcError(ErrorCode.METHOD_NOT_FOUND, parsed.method, id) + "\n");
    }
  }
}

export function main(): void {
  const proxy = new ProxyServer();
  proxy.start();
}

// Re-export shapes the orchestrator consumes externally (rare — proxy is
// normally a process boundary).
export type { HostConfig, Prompt, Resource, ResourceTemplate, Tool };
