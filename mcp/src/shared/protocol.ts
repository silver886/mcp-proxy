import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer as nodeCreateServer } from "node:http";

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 6270;
export const DEFAULT_PAGES_URL = "https://mcp-proxy.pages.dev";

// JSON-RPC error codes (-32000 to -32099 = server-defined, -32603 = spec internal error)
export const ErrorCode = {
  INTERNAL:             -32603, // JSON-RPC spec: internal error
  PROXY_NOT_CONFIGURED: -32001, // Proxy has not been paired yet
  HOST_UNREACHABLE:     -32002, // Cannot reach the host agent via tunnel
  PROCESS_EXITED:       -32003, // MCP server child process exited unexpectedly
  PROCESS_NOT_RUNNING:  -32004, // MCP server child process is not running
  REQUEST_TIMEOUT:      -32005, // MCP server did not respond in time
} as const;

export const ErrorMessage = {
  [ErrorCode.INTERNAL]:             "Internal error",
  [ErrorCode.PROXY_NOT_CONFIGURED]: "Proxy not configured",
  [ErrorCode.HOST_UNREACHABLE]:     "Host agent unreachable",
  [ErrorCode.PROCESS_EXITED]:       "Server process exited",
  [ErrorCode.PROCESS_NOT_RUNNING]:  "Server process not running",
  [ErrorCode.REQUEST_TIMEOUT]:      "Request timed out",
} as const;

// JSON-RPC error response helper
export function jsonRpcError(code: number, detail?: string, id: string | number | null = null): string {
  const base = ErrorMessage[code as keyof typeof ErrorMessage] ?? "Unknown error";
  const message = detail ? `${base}: ${detail}` : base;
  return JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id });
}

// Read full request body as string
export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

// Parse CLI argument by name: --flag value
export function getArg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  return idx !== -1 && idx + 1 < process.argv.length ? process.argv[idx + 1] : undefined;
}

// Create HTTP server with async handler and error catching
export function createServer(handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>) {
  return nodeCreateServer((req, res) => {
    handler(req, res).catch((err) => {
      console.error(`Request handler error: ${(err as Error).message}`);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(jsonRpcError(ErrorCode.INTERNAL));
      }
    });
  });
}

// Line-buffered reader: accumulates chunks and yields complete lines
export class LineBuffer {
  private buffer = "";

  push(chunk: string): string[] {
    this.buffer += chunk;
    const parts = this.buffer.split("\n");
    this.buffer = parts.pop()!; // Keep incomplete trailing segment
    return parts.filter((line) => line.trim().length > 0);
  }
}

// Server configuration (used by host)
export interface ServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
  shell?: boolean; // default false — set true for commands needing shell resolution
}

export interface HostAgentConfig {
  servers: Record<string, ServerConfig>;
  host?: string; // default DEFAULT_HOST
  port?: number; // default DEFAULT_PORT
}
