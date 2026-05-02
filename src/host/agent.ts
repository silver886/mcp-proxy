import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import {
  createServer,
  DEFAULT_HOST,
  DEFAULT_PORT,
  ErrorCode,
  type HostAgentConfig,
  jsonRpcError,
  normalizeServerConfig,
  readBody,
  type ServerConfig,
  validateServerName,
} from "../shared/protocol.js";
import { SESSION_GC_INTERVAL_MS, SESSION_IDLE_TIMEOUT_MS, SSE_DRAIN_INTERVAL_MS } from "./constants.js";
import { McpSession } from "./session.js";

function sendSessionMismatchError(res: ServerResponse, session: McpSession, serverName: string): void {
  res.writeHead(400, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: `Session belongs to server '${session.serverName}', not '${serverName}'` }));
}

// HTTP-to-stdio bridge. Owns the session map, handles the auth check, and
// dispatches by method:
//   GET /                 — list available servers (proxy discovery)
//   POST /servers/:name   — JSON-RPC request (initialize spawns a session;
//                           anything else against an unknown id is rejected
//                           with 404 + JSON error so the proxy can re-init)
//   GET /servers/:name    — SSE stream for that session's notifications
//   DELETE /servers/:name — explicit session close
export class HostAgent {
  private config: HostAgentConfig;
  private sessions = new Map<string, McpSession>();
  private timeout: number;
  private authToken: string;
  private gcTimer: ReturnType<typeof setInterval> | null = null;
  private server: Server | null = null;
  private boundHost: string;
  private boundPort: number;

  constructor(configPath: string, timeout: number, overrides?: { host?: string; port?: number }) {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as { servers?: unknown; host?: unknown; port?: unknown };
    this.timeout = timeout;
    this.authToken = randomBytes(32).toString("base64url"); // 256-bit token

    // Single boundary-time validation pass: server-name policy, per-entry
    // shape, and top-level host/port. Documented defaults (args=[]) are
    // installed by normalizeServerConfig so downstream consumers can trust
    // the ServerConfig contract instead of re-checking shapes — without
    // this, omitting `args` (legal per README) crashes McpSession deep
    // inside `args.join(" ")`. All reasons are accumulated so a broken
    // file surfaces a complete diff to fix in one error message rather
    // than one-issue-per-restart.
    const invalid: string[] = [];
    const servers: Record<string, ServerConfig> = {};
    if (!parsed.servers || typeof parsed.servers !== "object" || Array.isArray(parsed.servers)) {
      invalid.push(`  - "servers": must be an object map of name to config`);
    } else {
      const rawServers = parsed.servers as Record<string, unknown>;
      if (Object.keys(rawServers).length === 0) {
        invalid.push(`  - "servers": at least one server must be declared`);
      }
      for (const [name, entry] of Object.entries(rawServers)) {
        const nameReason = validateServerName(name);
        if (nameReason) invalid.push(`  - "${name}": ${nameReason}`);
        const result = normalizeServerConfig(entry);
        if (!result.ok) {
          for (const reason of result.reasons) invalid.push(`  - "${name}": ${reason}`);
        } else if (!nameReason) {
          servers[name] = result.config;
        }
      }
    }
    if (parsed.host !== undefined && typeof parsed.host !== "string") {
      invalid.push(`  - "host": must be a string (default: ${DEFAULT_HOST})`);
    }
    if (
      parsed.port !== undefined
      && (typeof parsed.port !== "number"
        || !Number.isInteger(parsed.port)
        || parsed.port < 0
        || parsed.port > 65535)
    ) {
      invalid.push(`  - "port": must be an integer 0–65535 (default: ${DEFAULT_PORT})`);
    }
    if (invalid.length > 0) {
      throw new Error(
        `Invalid host config in ${configPath}:\n${invalid.join("\n")}\n` +
        `Fix the entries in config.json so they match the documented schema.`,
      );
    }

    this.config = {
      servers,
      host: typeof parsed.host === "string" ? parsed.host : undefined,
      port: typeof parsed.port === "number" ? parsed.port : undefined,
    };
    this.boundHost = overrides?.host ?? this.config.host ?? DEFAULT_HOST;
    // port 0 = let the OS pick. Resolved to the real bound port in start().
    this.boundPort = overrides?.port ?? this.config.port ?? DEFAULT_PORT;
  }

  get port(): number {
    return this.boundPort;
  }

  // Resolves once the listener is bound. Tunnel mode passes port 0 and
  // needs the real port back before it can start cloudflared, so callers
  // must await this rather than racing the synchronous return.
  //
  // On a bind failure (EADDRINUSE, EACCES, …) we tear down everything we
  // installed before rejecting: the GC interval, the listener reference,
  // and any half-open server. Without this cleanup, a caller that catches
  // the rejection and discards the agent leaks a running interval and a
  // dangling server reference until process exit — invisible to the CLI
  // (which just process.exits) but a real leak for library/test usage.
  start(): Promise<void> {
    return new Promise((resolveP, rejectP) => {
      const srv = createServer((req, res) => this.handleRequest(req, res));
      this.server = srv;
      this.gcTimer = setInterval(() => this.sweepIdleSessions(), SESSION_GC_INTERVAL_MS);
      const onError = (err: Error): void => {
        if (this.gcTimer) {
          clearInterval(this.gcTimer);
          this.gcTimer = null;
        }
        this.server = null;
        try { srv.close(); } catch { /* never bound */ }
        rejectP(err);
      };
      srv.once("error", onError);
      srv.listen(this.boundPort, this.boundHost, () => {
        const addr = srv.address();
        if (addr && typeof addr === "object") this.boundPort = addr.port;
        console.log(`MCP Host Agent listening on http://${this.boundHost}:${this.boundPort}`);
        console.log(`Available servers: ${Object.keys(this.config.servers).join(", ")}`);
        console.error(`Auth token: ${this.authToken}`);
        srv.off("error", onError);
        resolveP();
      });
    });
  }

  // Stop the GC timer, tear down every active session, and release the HTTP
  // listener. Safe to call more than once. The listener close is what
  // matters for library users — the CLI path immediately process.exits, but
  // an embedder that re-creates the agent (tests, hot-reload, etc.) would
  // otherwise leak the bound port. closeAllConnections() is required because
  // the SSE handler keeps long-lived responses open; close() alone would
  // wait for them to drain naturally and never resolve.
  shutdown(): void {
    if (this.gcTimer) {
      clearInterval(this.gcTimer);
      this.gcTimer = null;
    }
    for (const [id, session] of this.sessions) {
      session.destroy();
      this.sessions.delete(id);
    }
    if (this.server) {
      const srv = this.server;
      this.server = null;
      srv.closeAllConnections();
      srv.close();
    }
  }

  private sweepIdleSessions(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (!session.isAlive) {
        this.sessions.delete(id);
        continue;
      }
      if (now - session.lastActivity > SESSION_IDLE_TIMEOUT_MS) {
        console.log(`[${session.serverName}] Idle session ${id} closed after ${SESSION_IDLE_TIMEOUT_MS}ms`);
        session.destroy();
        this.sessions.delete(id);
      }
    }
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.authorized(req)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    // Parse once so the route check ignores the query string and we can
    // anchor on pathname — `/servers/foo/extra` must 404, not silently
    // route to `foo` (the proxy's forwarder rejects it, so accepting it
    // here would create a contract mismatch).
    const { pathname } = new URL(req.url ?? "/", "http://h");

    if (req.method === "GET" && pathname === "/") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        service: "mcp-proxy-host",
        servers: Object.keys(this.config.servers),
      }));
      return;
    }

    const match = pathname.match(/^\/servers\/([^/]+)$/);
    if (!match) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found. Use /servers/<name>" }));
      return;
    }

    const serverName = match[1];
    const serverConfig = this.config.servers[serverName];
    if (!serverConfig) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        error: `Unknown server: ${serverName}`,
        available: Object.keys(this.config.servers),
      }));
      return;
    }

    if (req.method === "POST") {
      await this.handleMcpPost(req, res, serverName, serverConfig);
      return;
    }

    if (req.method === "GET") {
      this.handleSse(req, res, serverName);
      return;
    }

    if (req.method === "DELETE") {
      const sessionId = req.headers["mcp-session-id"] as string;
      if (sessionId && this.sessions.has(sessionId)) {
        const session = this.sessions.get(sessionId)!;
        if (session.serverName !== serverName) {
          sendSessionMismatchError(res, session, serverName);
          return;
        }
        session.destroy();
        this.sessions.delete(sessionId);
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(405);
    res.end();
  }

  private authorized(req: IncomingMessage): boolean {
    const auth = req.headers.authorization ?? "";
    const expected = `Bearer ${this.authToken}`;
    const authBuf = Buffer.from(auth);
    const expectedBuf = Buffer.from(expected);
    return authBuf.length === expectedBuf.length && timingSafeEqual(authBuf, expectedBuf);
  }

  private async handleMcpPost(
    req: IncomingMessage,
    res: ServerResponse,
    serverName: string,
    serverConfig: ServerConfig,
  ): Promise<void> {
    const body = await readBody(req);
    const headerSessionId = req.headers["mcp-session-id"] as string | undefined;

    // Parse once at the HTTP boundary. The host is the JSON-RPC endpoint
    // from the proxy's perspective, so a malformed body must surface as a
    // spec-compliant parse-error response with id:null — not get forwarded
    // to the child as a notification. Without this gate the body falls
    // through sendRequest's `id === undefined` branch (notification path),
    // garbage hits stdin, the caller gets a misleading 202, and the
    // child's parse-error reply arrives with id:null and is dropped as an
    // orphan — guaranteeing a silent timeout on the proxy.
    let parsedBody: { method?: string };
    try {
      parsedBody = JSON.parse(body) as { method?: string };
    } catch {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(jsonRpcError(ErrorCode.PARSE_ERROR, undefined, null));
      return;
    }
    // Only `initialize` may run without an existing session — anything
    // else against an unknown id is stale (post-GC, post-restart) or
    // wrong, and silently spawning a fresh uninitialized child for it
    // would violate the MCP handshake.
    const isInitialize = parsedBody.method === "initialize";

    let existing: McpSession | undefined;
    if (headerSessionId) {
      existing = this.sessions.get(headerSessionId);
      if (existing) {
        if (existing.serverName !== serverName) {
          sendSessionMismatchError(res, existing, serverName);
          return;
        }
        if (!existing.isAlive) {
          // Reaped under us — drop the dead entry; treat as no session.
          this.sessions.delete(headerSessionId);
          existing = undefined;
        }
      }
    }

    let session: McpSession;
    let activeSessionId: string;
    if (existing && headerSessionId) {
      session = existing;
      activeSessionId = headerSessionId;
    } else {
      if (!isInitialize) {
        // Mirror handleSse: refuse to bind work to an id we don't know.
        // The proxy is expected to re-`initialize` and retry on this 404.
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          error: headerSessionId
            ? `Unknown session: ${headerSessionId}`
            : "Mcp-Session-Id header required",
        }));
        return;
      }
      activeSessionId = randomBytes(16).toString("hex");
      session = new McpSession(serverName, serverConfig, this.timeout);
      this.sessions.set(activeSessionId, session);
    }

    const response = await session.sendRequest(body);

    if (!response) {
      // Client notification — no response body
      res.writeHead(202, { "Mcp-Session-Id": activeSessionId });
      res.end();
      return;
    }

    res.writeHead(200, {
      "Content-Type": "application/json",
      "Mcp-Session-Id": activeSessionId,
    });
    res.end(response);
  }

  private handleSse(req: IncomingMessage, res: ServerResponse, serverName: string): void {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const session = sessionId ? this.sessions.get(sessionId) : undefined;

    // Reject SSE attaches that do not point at a live session for this
    // server. Returning 200 with an empty stream would let the proxy sit
    // on a dead pipe forever instead of reconnecting to a fresh session
    // id — the drain interval below would close the stream on its first
    // tick once it noticed `session.isAlive === false`, but by then the
    // 200 has already convinced the proxy that the session is good and
    // it won't re-initialize on its own. The 404 here is the signal the
    // proxy needs to throw the stale id away and start a fresh session.
    if (sessionId && session && !session.isAlive) {
      // Clear the dead entry on the way out so the next attach sees a
      // clean miss instead of repeating this dance.
      this.sessions.delete(sessionId);
    }
    if (!sessionId || !session || !session.isAlive) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        error: sessionId ? `Unknown session: ${sessionId}` : "Mcp-Session-Id header required",
      }));
      return;
    }
    if (session.serverName !== serverName) {
      sendSessionMismatchError(res, session, serverName);
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Mcp-Session-Id": sessionId,
    });
    res.write(": connected\n\n");

    const interval = setInterval(() => {
      if (!session.isAlive) {
        clearInterval(interval);
        res.end();
        return;
      }
      const notifications = session.drainNotifications();
      for (const n of notifications) {
        res.write(`data: ${n}\n\n`);
      }
    }, SSE_DRAIN_INTERVAL_MS);

    req.on("close", () => clearInterval(interval));
  }
}
