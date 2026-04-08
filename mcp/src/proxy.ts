#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { ErrorCode, LineBuffer, getArg, jsonRpcError } from "./shared/protocol.js";

const POLL_INTERVAL = 2000; // ms
const WORKER_URL_DEFAULT = "https://mcp-proxy.pages.dev";

interface PairingConfig {
  tunnelUrl: string;
  serverName: string;
}

class ProxyServer {
  private config: PairingConfig | null = null;
  private pairingCode: string;
  private workerUrl: string;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private sessionId: string | undefined;

  constructor(workerUrl: string) {
    this.workerUrl = workerUrl.replace(/\/+$/, "");
    this.pairingCode = this.generateCode();
  }

  private generateCode(): string {
    return randomBytes(4).toString("hex").toUpperCase();
  }

  private get setupUrl(): string {
    return `${this.workerUrl}/setup/${this.pairingCode}`;
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
    // Extract id to determine if this is a request or notification
    let id: string | number | null = null;
    try {
      id = JSON.parse(line).id ?? null;
    } catch {
      return;
    }

    if (!this.config) {
      if (id !== null) {
        process.stdout.write(jsonRpcError(ErrorCode.PROXY_NOT_CONFIGURED, `Visit ${this.setupUrl}`, id) + "\n");
      }
      return;
    }

    try {
      const targetUrl = `${this.config.tunnelUrl}/servers/${this.config.serverName}`;

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      };
      if (this.sessionId) {
        headers["Mcp-Session-Id"] = this.sessionId;
      }

      const upstream = await fetch(targetUrl, {
        method: "POST",
        headers,
        body: line,
      });

      this.sessionId = upstream.headers.get("mcp-session-id") ?? this.sessionId;

      const body = await upstream.text();
      if (body) {
        process.stdout.write(body + "\n");
      }
    } catch (err) {
      if (id !== null) {
        process.stdout.write(jsonRpcError(ErrorCode.HOST_UNREACHABLE, (err as Error).message, id) + "\n");
      }
    }
  }

  private startPairing(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pairingCode = this.generateCode();
    this.config = null;
    const url = this.setupUrl;
    process.stderr.write(`\n  Configure at: ${url}\n\n`);
    process.stderr.write(`  Waiting for configuration...\n`);

    this.pollTimer = setInterval(() => this.pollConfig(), POLL_INTERVAL);
  }

  private async pollConfig(): Promise<void> {
    try {
      const resp = await fetch(`${this.workerUrl}/api/config/${this.pairingCode}`);
      if (resp.ok) {
        const data = (await resp.json()) as PairingConfig;
        if (data.tunnelUrl && data.serverName) {
          data.tunnelUrl = data.tunnelUrl.replace(/\/+$/, "");
          this.config = data;
          if (this.pollTimer) clearInterval(this.pollTimer);
          this.pollTimer = null;
          process.stderr.write(`  Connected! tunnel=${data.tunnelUrl} server=${data.serverName}\n\n`);
        }
      }
    } catch {
      // Silently retry
    }
  }
}

function main(): void {
  const workerUrl = getArg("--worker-url") ?? process.env.MCP_PROXY_WORKER_URL ?? WORKER_URL_DEFAULT;
  const proxy = new ProxyServer(workerUrl);
  proxy.start();
}

main();
