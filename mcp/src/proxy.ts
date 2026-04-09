#!/usr/bin/env node
import { randomBytes, webcrypto } from "node:crypto";
import { PACKAGE_NAME, PACKAGE_VERSION, MCP_PROTOCOL_VERSION, DEFAULT_PAGES_URL, ErrorCode, LineBuffer, getArg, jsonRpcError } from "./shared/protocol.js";

const POLL_INTERVAL = 2000; // ms
const TOOL_SEPARATOR = "__";

const subtle = webcrypto.subtle;

interface Tool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

interface PairingConfig {
  tunnelUrl: string;
  authToken: string;
  serverName: string;
  selectedTools: string[];
  sealed: boolean;
}

interface ServerState {
  sessionId?: string;
  tools: Tool[];
}

// --- Crypto helpers (AES-256-GCM + SHA-256 + HMAC) ---

async function importAesKey(keyB64: string): Promise<CryptoKey> {
  const raw = Buffer.from(keyB64, "base64url");
  return subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function importHmacKey(keyB64: string): Promise<CryptoKey> {
  const raw = Buffer.from(keyB64, "base64url");
  return subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

async function deriveCodeId(code: string): Promise<string> {
  const hash = await subtle.digest("SHA-256", new TextEncoder().encode(code));
  return Buffer.from(hash).toString("base64url");
}

async function deriveAuthHash(keyB64: string, code: string): Promise<string> {
  const hmacKey = await importHmacKey(keyB64);
  const sig = await subtle.sign("HMAC", hmacKey, new TextEncoder().encode(code));
  return Buffer.from(sig).toString("base64url");
}

async function encrypt(key: CryptoKey, plaintext: string): Promise<string> {
  const iv = randomBytes(12);
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv }, key, encoded));
  const combined = new Uint8Array(iv.length + ciphertext.length);
  combined.set(iv);
  combined.set(ciphertext, iv.length);
  return Buffer.from(combined).toString("base64url");
}

async function decrypt(key: CryptoKey, data: string): Promise<string> {
  const combined = Buffer.from(data, "base64url");
  const iv = combined.subarray(0, 12);
  const ciphertext = combined.subarray(12);
  const plaintext = await subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return new TextDecoder().decode(plaintext);
}

// --- RPC client ---

async function rpc(
  pagesUrl: string,
  codeId: string,
  authHash: string,
  action: "read" | "write" | "delete",
  payload?: string
): Promise<{ ok?: boolean; payload?: string; status?: string; error?: string }> {
  const resp = await fetch(`${pagesUrl}/api/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ codeId, authHash, action, payload }),
  });
  return (await resp.json()) as { ok?: boolean; payload?: string; status?: string; error?: string };
}

// --- Proxy ---

class ProxyServer {
  private config: PairingConfig | null = null;
  private pagesUrl: string;
  private code: string;
  private encKeyB64: string;
  private aesKey: CryptoKey | null = null;
  private codeId: string | null = null;
  private authHash: string | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private servers = new Map<string, ServerState>();
  private toolRoute = new Map<string, string>();
  private initialized = false;

  constructor(pagesUrl: string) {
    this.pagesUrl = pagesUrl.replace(/\/+$/, "");
    this.code = randomBytes(64).toString("base64url");
    this.encKeyB64 = randomBytes(32).toString("base64url");
  }

  private get setupUrl(): string {
    return `${this.pagesUrl}/setup.html#code=${this.code}&key=${this.encKeyB64}`;
  }

  private get hostHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${this.config?.authToken ?? ""}`,
    };
  }

  private async ensureDerivedKeys(): Promise<{ aesKey: CryptoKey; codeId: string; authHash: string }> {
    if (!this.aesKey) this.aesKey = await importAesKey(this.encKeyB64);
    if (!this.codeId) this.codeId = await deriveCodeId(this.code);
    if (!this.authHash) this.authHash = await deriveAuthHash(this.encKeyB64, this.code);
    return { aesKey: this.aesKey, codeId: this.codeId, authHash: this.authHash };
  }

  start(): void {
    this.startPairing();

    const stdinBuffer = new LineBuffer();

    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk: string) => {
      const lines = stdinBuffer.push(chunk);
      for (const line of lines) {
        this.handleLine(line).catch((err) => {
          process.stderr.write(`Proxy error: ${(err as Error).message}\n`);
        });
      }
    });

    process.stdin.on("end", () => {
      process.exit(0);
    });
  }

  private async handleLine(line: string): Promise<void> {
    let parsed: { id?: string | number; method?: string; params?: Record<string, unknown> };
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }

    const id = parsed.id ?? null;

    // Handle client notifications (no id)
    if (id === null) return;

    switch (parsed.method) {
      // initialize always succeeds — proxy is a valid server even before pairing
      case "initialize":
        this.sendResult(id, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: true }, prompts: {}, logging: {} },
          serverInfo: { name: PACKAGE_NAME, version: PACKAGE_VERSION },
        });
        return;

      // tools/list returns configure tool before pairing, real tools after
      case "tools/list":
        if (!this.config) {
          this.sendResult(id, { tools: [{
            name: "configure",
            description: "Set up or reconfigure the MCP proxy connection. Returns the setup URL.",
            inputSchema: { type: "object", properties: {} },
          }] });
          return;
        }
        if (!this.initialized) await this.discoverServers();
        this.sendResult(id, { tools: this.getFilteredTools() });
        return;

      // prompts/list always available
      case "prompts/list":
        this.sendResult(id, { prompts: [{
          name: "configure",
          description: "Set up or reconfigure the MCP proxy connection",
        }] });
        return;

      case "prompts/get": {
        const promptName = (parsed.params as { name?: string })?.name;
        if (promptName === "configure") {
          const text = await this.handleConfigure();
          this.sendResult(id, {
            messages: [
              { role: "user", content: { type: "text", text: "Show the MCP Proxy setup URL. Do not add any follow-up — do not ask me to let you know or report back." } },
              { role: "assistant", content: { type: "text", text } },
            ],
          });
        } else {
          this.sendError(ErrorCode.INVALID_PARAMS, `Unknown prompt: ${promptName}`, id);
        }
        return;
      }

      case "tools/call": {
        const toolName = (parsed.params as { name?: string })?.name;
        if (toolName === "configure") {
          const text = await this.handleConfigure();
          this.sendResult(id, { content: [{ type: "text", text }] });
          return;
        }
        if (!this.config) {
          this.sendError(ErrorCode.PROXY_NOT_CONFIGURED, `Visit ${this.setupUrl}`, id);
          return;
        }
        await this.handleToolCall(id, parsed.params as { name: string; arguments?: Record<string, unknown> });
        return;
      }

      default:
        this.sendError(ErrorCode.METHOD_NOT_FOUND, parsed.method, id);
    }
  }

  private async handleToolCall(id: string | number, params: { name: string; arguments?: Record<string, unknown> }): Promise<void> {
    const prefixedName = params.name;
    const serverName = this.toolRoute.get(prefixedName);

    if (!serverName) {
      this.sendError(ErrorCode.INVALID_PARAMS, `Unknown tool: ${prefixedName}`, id);
      return;
    }

    const originalName = prefixedName.slice(serverName.length + TOOL_SEPARATOR.length);
    const server = this.servers.get(serverName)!;
    const targetUrl = `${this.config!.tunnelUrl}/servers/${serverName}`;

    const headers = { ...this.hostHeaders };
    if (server.sessionId) headers["Mcp-Session-Id"] = server.sessionId;

    try {
      const body = JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: originalName, arguments: params.arguments },
      });

      const upstream = await fetch(targetUrl, { method: "POST", headers, body });
      server.sessionId = upstream.headers.get("mcp-session-id") ?? server.sessionId;

      const responseBody = await upstream.text();
      if (responseBody) process.stdout.write(responseBody + "\n");
    } catch (err) {
      this.sendError(ErrorCode.HOST_UNREACHABLE, (err as Error).message, id);
    }
  }

  private getFilteredTools(): Tool[] {
    const selectedSet = this.config?.selectedTools?.length
      ? new Set(this.config.selectedTools)
      : null;

    const tools: Tool[] = [];
    for (const [serverName, state] of this.servers) {
      for (const tool of state.tools) {
        const prefixed = `${serverName}${TOOL_SEPARATOR}${tool.name}`;
        if (selectedSet && !selectedSet.has(prefixed)) continue;
        tools.push({
          ...tool,
          name: prefixed,
          description: `[${serverName}] ${tool.description ?? ""}`.trim(),
        });
      }
    }
    return tools;
  }

  private async discoverServers(): Promise<void> {
    if (!this.config) return;

    try {
      const listResp = await fetch(`${this.config.tunnelUrl}/`, { headers: this.hostHeaders });
      const listData = (await listResp.json()) as { servers?: string[] };
      const serverNames = listData.servers ?? [];

      // Skip servers whose names contain the tool separator to prevent routing confusion
      const safeNames = serverNames.filter((name) => {
        if (name.includes(TOOL_SEPARATOR)) {
          process.stderr.write(`  [${name}] skipped: name contains '${TOOL_SEPARATOR}'\n`);
          return false;
        }
        return true;
      });

      process.stderr.write(`  Discovered servers: ${safeNames.join(", ")}\n`);

      for (const name of safeNames) {
        await this.initServer(name);
      }

      this.toolRoute.clear();
      for (const [serverName, state] of this.servers) {
        for (const tool of state.tools) {
          this.toolRoute.set(`${serverName}${TOOL_SEPARATOR}${tool.name}`, serverName);
        }
      }

      this.initialized = true;
      process.stderr.write(`  Total tools: ${this.toolRoute.size}\n\n`);
    } catch (err) {
      process.stderr.write(`  Discovery failed: ${(err as Error).message}\n`);
    }
  }

  private async initServer(name: string): Promise<void> {
    const targetUrl = `${this.config!.tunnelUrl}/servers/${name}`;
    const headers = { ...this.hostHeaders };

    try {
      const initResp = await fetch(targetUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: `init-${name}`,
          method: "initialize",
          params: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: PACKAGE_NAME, version: PACKAGE_VERSION },
          },
        }),
      });

      const sessionId = initResp.headers.get("mcp-session-id") ?? undefined;
      if (sessionId) headers["Mcp-Session-Id"] = sessionId;

      await fetch(targetUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
      });

      const toolsResp = await fetch(targetUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: `tools-${name}`, method: "tools/list", params: {} }),
      });

      const toolsData = (await toolsResp.json()) as { result?: { tools?: Tool[] } };
      const tools = toolsData.result?.tools ?? [];

      this.servers.set(name, { sessionId, tools });
      process.stderr.write(`  [${name}] ${tools.length} tools\n`);
    } catch (err) {
      process.stderr.write(`  [${name}] init failed: ${(err as Error).message}\n`);
    }
  }

  private sendResult(id: string | number | null, result: unknown): void {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
  }

  private sendError(code: number, detail: string | undefined, id: string | number | null): void {
    process.stdout.write(jsonRpcError(code, detail, id) + "\n");
  }

  private sendNotification(method: string): void {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
  }

  private async handleConfigure(): Promise<string> {
    if (this.config) {
      await this.startPairing();
      this.sendNotification("notifications/tools/list_changed");
    }
    return `Open this URL in your browser to set up the MCP Proxy:\n\n${this.setupUrl}\n\nThe proxy will connect automatically once setup is complete.`;
  }

  private async startPairing(): Promise<void> {
    if (this.pollTimer) clearInterval(this.pollTimer);
    const previousConfig = this.config;
    this.code = randomBytes(64).toString("base64url");
    this.encKeyB64 = randomBytes(32).toString("base64url");
    this.aesKey = null;
    this.codeId = null;
    this.authHash = null;
    this.config = null;
    this.initialized = false;
    this.servers.clear();
    this.toolRoute.clear();

    // Seed with encrypted previous config (unsealed) — skip on first pairing
    if (previousConfig) {
      try {
        const { aesKey, codeId, authHash } = await this.ensureDerivedKeys();
        const payload = await encrypt(aesKey, JSON.stringify({ ...previousConfig, sealed: false }));
        await rpc(this.pagesUrl, codeId, authHash, "write", payload);
      } catch {
        // Non-critical
      }
    }

    process.stderr.write(`\n  Configure at: ${this.setupUrl}\n\n`);
    process.stderr.write(`  Waiting for configuration...\n`);

    this.pollTimer = setInterval(() => this.pollConfig(), POLL_INTERVAL);
  }

  private async pollConfig(): Promise<void> {
    if (this.config) return; // Already paired — guard against overlapping async polls
    try {
      const { aesKey, codeId, authHash } = await this.ensureDerivedKeys();
      const result = await rpc(this.pagesUrl, codeId, authHash, "read");

      if (result.payload) {
        const plaintext = await decrypt(aesKey, result.payload);
        const data = JSON.parse(plaintext) as PairingConfig;

        if (data.tunnelUrl && data.authToken && data.serverName && data.sealed) {
          data.tunnelUrl = data.tunnelUrl.replace(/\/+$/, "");
          this.config = data;
          if (this.pollTimer) clearInterval(this.pollTimer);
          this.pollTimer = null;
          process.stderr.write(`  Paired! tunnel=${data.tunnelUrl}\n`);
          await this.discoverServers();
          this.sendNotification("notifications/tools/list_changed");
        }
      }
    } catch {
      // Silently retry
    }
  }
}

function main(): void {
  const pagesUrl = getArg("--pages-url") ?? process.env.MCP_PROXY_PAGES_URL ?? DEFAULT_PAGES_URL;
  const proxy = new ProxyServer(pagesUrl);
  proxy.start();
}

main();
