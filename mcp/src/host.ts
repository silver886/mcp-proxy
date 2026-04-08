#!/usr/bin/env node
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { Tunnel } from "cloudflared";
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  LineBuffer,
  ErrorCode,
  createServer,
  readBody,
  getArg,
  jsonRpcError,
  type HostAgentConfig,
  type ServerConfig,
} from "./shared/protocol.js";

// A session manages one MCP server child process + request/response matching
class McpSession {
  private process: ChildProcess;
  private stdoutBuffer = new LineBuffer();
  private pending = new Map<string | number, { resolve: (msg: string) => void; timer: ReturnType<typeof setTimeout> }>();
  private notifications: string[] = [];
  private destroyed = false;

  constructor(
    private name: string,
    config: ServerConfig,
    private timeout: number
  ) {
    console.log(`[${name}] Spawning: ${config.command} ${config.args.join(" ")}`);

    this.process = spawn(config.command, config.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...config.env },
      shell: config.shell ?? false,
    });

    this.process.stdout!.on("data", (chunk: Buffer) => {
      const lines = this.stdoutBuffer.push(chunk.toString("utf-8"));
      for (const line of lines) {
        this.handleLine(line);
      }
    });

    this.process.stderr!.on("data", (chunk: Buffer) => {
      console.error(`[${name}] stderr: ${chunk.toString("utf-8").trimEnd()}`);
    });

    this.process.on("exit", (code) => {
      console.log(`[${name}] Process exited (code=${code})`);
      this.destroyed = true;
      // Reject all pending
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.resolve(jsonRpcError(ErrorCode.PROCESS_EXITED, `code=${code}`));
      }
      this.pending.clear();
    });

    this.process.on("error", (err) => {
      console.error(`[${name}] Process error: ${err.message}`);
      this.destroyed = true;
    });
  }

  private handleLine(line: string): void {
    // Try to extract the id to match with a pending request
    let parsed: { id?: string | number; method?: string };
    try {
      parsed = JSON.parse(line);
    } catch {
      return; // Not valid JSON, skip
    }

    // If it has an id and matches a pending request, resolve it
    if (parsed.id !== undefined && this.pending.has(parsed.id)) {
      const p = this.pending.get(parsed.id)!;
      clearTimeout(p.timer);
      this.pending.delete(parsed.id);
      p.resolve(line);
      return;
    }

    // Otherwise it's a notification — queue it
    this.notifications.push(line);
  }

  sendRequest(jsonRpcLine: string): Promise<string> {
    if (this.destroyed || !this.process.stdin?.writable) {
      return Promise.resolve(jsonRpcError(ErrorCode.PROCESS_NOT_RUNNING));
    }

    // Extract id for matching
    let id: string | number | undefined;
    try {
      id = JSON.parse(jsonRpcLine).id;
    } catch {
      // If we can't parse, just send it and hope for the best
    }

    this.process.stdin.write(jsonRpcLine + "\n");

    if (id === undefined) {
      // It's a notification from client — no response expected
      return Promise.resolve("");
    }

    return new Promise<string>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(jsonRpcError(ErrorCode.REQUEST_TIMEOUT, undefined, id));
      }, this.timeout);

      this.pending.set(id, { resolve, timer });
    });
  }

  drainNotifications(): string[] {
    const n = this.notifications;
    this.notifications = [];
    return n;
  }

  get serverName(): string {
    return this.name;
  }

  get isAlive(): boolean {
    return !this.destroyed;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (!this.process.killed) this.process.kill();
  }
}

function sendSessionMismatchError(res: ServerResponse, session: McpSession, serverName: string): void {
  res.writeHead(400, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: `Session belongs to server '${session.serverName}', not '${serverName}'` }));
}

// Main server
class HostAgent {
  private config: HostAgentConfig;
  private sessions = new Map<string, McpSession>();
  private timeout: number;
  private authToken: string;

  constructor(configPath: string, timeout: number) {
    const raw = readFileSync(configPath, "utf-8");
    this.config = JSON.parse(raw) as HostAgentConfig;
    this.timeout = timeout;
    this.authToken = randomBytes(32).toString("base64url"); // 256-bit token
  }

  get port(): number {
    return this.config.port ?? DEFAULT_PORT;
  }

  start(): void {
    const host = this.config.host ?? DEFAULT_HOST;

    const server = createServer((req, res) => this.handleRequest(req, res));
    server.listen(this.port, host, () => {
      console.log(`MCP Host Agent listening on http://${host}:${this.port}`);
      console.log(`Available servers: ${Object.keys(this.config.servers).join(", ")}`);
      console.error(`Auth token: ${this.authToken}`);
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Auth: validate Bearer token (constant-time comparison)
    const auth = req.headers.authorization ?? "";
    const expected = `Bearer ${this.authToken}`;
    const authBuf = Buffer.from(auth);
    const expectedBuf = Buffer.from(expected);
    const authorized = authBuf.length === expectedBuf.length && timingSafeEqual(authBuf, expectedBuf);
    if (!authorized) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    // GET / — list available servers
    if (req.method === "GET" && req.url === "/") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        service: "mcp-proxy-host",
        servers: Object.keys(this.config.servers),
      }));
      return;
    }

    // Route: /servers/:name
    const match = req.url?.match(/^\/servers\/([^/?]+)/);
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

    // POST /servers/:name — MCP request
    if (req.method === "POST") {
      await this.handleMcpPost(req, res, serverName, serverConfig);
      return;
    }

    // GET /servers/:name — SSE for server notifications
    if (req.method === "GET") {
      this.handleSse(req, res, serverName);
      return;
    }

    // DELETE /servers/:name — close session
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

  private async handleMcpPost(
    req: IncomingMessage,
    res: ServerResponse,
    serverName: string,
    serverConfig: ServerConfig
  ): Promise<void> {
    const body = await readBody(req);
    let sessionId = req.headers["mcp-session-id"] as string | undefined;

    // Get or create session
    let session: McpSession;
    if (sessionId && this.sessions.has(sessionId)) {
      session = this.sessions.get(sessionId)!;
      if (session.serverName !== serverName) {
        sendSessionMismatchError(res, session, serverName);
        return;
      }
      if (!session.isAlive) {
        // Session dead — clean up and create new
        this.sessions.delete(sessionId);
        sessionId = undefined;
      }
    }

    if (!sessionId || !this.sessions.has(sessionId)) {
      sessionId = randomBytes(16).toString("hex");
      session = new McpSession(serverName, serverConfig, this.timeout);
      this.sessions.set(sessionId, session);
    } else {
      session = this.sessions.get(sessionId)!;
    }

    // Forward request
    const response = await session.sendRequest(body);

    if (!response) {
      // Client notification — no response body
      res.writeHead(202, { "Mcp-Session-Id": sessionId });
      res.end();
      return;
    }

    res.writeHead(200, {
      "Content-Type": "application/json",
      "Mcp-Session-Id": sessionId,
    });
    res.end(response);
  }

  private handleSse(req: IncomingMessage, res: ServerResponse, serverName: string): void {
    const sessionId = req.headers["mcp-session-id"] as string;
    const session = sessionId ? this.sessions.get(sessionId) : undefined;

    if (session && session.serverName !== serverName) {
      sendSessionMismatchError(res, session, serverName);
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
    });
    res.write(": connected\n\n");

    if (!session) {
      req.on("close", () => {});
      return;
    }

    // Poll for notifications and send them
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
    }, 100);

    req.on("close", () => clearInterval(interval));
  }
}

function startTunnel(port: number): void {
  const tunnel = Tunnel.quick(`http://localhost:${port}`);

  tunnel.once("url", (url: string) => {
    console.log(`\n  Tunnel URL: ${url}`);
    console.log(`\n  Enter this URL in the setup page when configuring the proxy.\n`);
  });

  tunnel.on("error", (err: Error) => {
    console.error("Tunnel error:", err.message);
  });

  process.on("SIGINT", () => {
    tunnel.stop();
    process.exit(0);
  });
}

function main(): void {
  const configPath = getArg("--config") ?? "config.json";
  const timeout = parseInt(getArg("--timeout") ?? "120000", 10); // 2min default for long tool calls
  const useTunnel = process.argv.includes("--tunnel");
  const agent = new HostAgent(configPath, timeout);
  agent.start();

  if (useTunnel) {
    console.log("Starting Cloudflare tunnel...");
    startTunnel(agent.port);
  }
}

main();
