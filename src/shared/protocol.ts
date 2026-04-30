import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer as nodeCreateServer } from "node:http";
import { resolve } from "node:path";

// dist/shared/protocol.js → ../../package.json (project root, same as the
// installed npm package's root). package.json is always shipped in the
// tarball regardless of the `files` whitelist, so this works in both
// local dev and installed contexts.
const pkg = JSON.parse(
  readFileSync(resolve(__dirname, "..", "..", "package.json"), "utf-8"),
) as { name: string; version: string };
export const PACKAGE_NAME = pkg.name;
export const PACKAGE_VERSION = pkg.version;

export const MCP_PROTOCOL_VERSION = "2024-11-05";
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 6270;

// Cap on the size of any single inbound HTTP request body. Both the
// pairing endpoints and the host agent sit behind a Cloudflare tunnel
// gated by a bearer token; without a cap, a leaked token gives an
// attacker a trivial memory-DoS by streaming an arbitrarily large body.
// 4 MiB is comfortably above any plausible MCP JSON-RPC request (tool
// args, init handshakes) while keeping worst-case memory bounded.
export const MAX_BODY_BYTES = 4 * 1024 * 1024;

export class BodyTooLargeError extends Error {
  constructor(public readonly limit: number) {
    super(`request body exceeds ${limit} bytes`);
    this.name = "BodyTooLargeError";
  }
}

// JSON-RPC error codes: -32700/-32600..-32603 = spec-defined, -32000..-32099 = server-defined
export const ErrorCode = {
  PARSE_ERROR:          -32700, // JSON-RPC spec: invalid JSON received
  INVALID_REQUEST:      -32600, // JSON-RPC spec: malformed request envelope
  METHOD_NOT_FOUND:     -32601, // JSON-RPC spec: method not found
  INVALID_PARAMS:       -32602, // JSON-RPC spec: invalid params
  INTERNAL:             -32603, // JSON-RPC spec: internal error
  PROXY_NOT_CONFIGURED: -32001, // Proxy has not been paired yet
  HOST_UNREACHABLE:     -32002, // Cannot reach the host agent via tunnel
  PROCESS_EXITED:       -32003, // MCP server child process exited unexpectedly
  PROCESS_NOT_RUNNING:  -32004, // MCP server child process is not running
  REQUEST_TIMEOUT:      -32005, // MCP server did not respond in time
} as const;

export const ErrorMessage = {
  [ErrorCode.PARSE_ERROR]:          "Parse error",
  [ErrorCode.INVALID_REQUEST]:      "Invalid request",
  [ErrorCode.METHOD_NOT_FOUND]:     "Method not found",
  [ErrorCode.INVALID_PARAMS]:       "Invalid params",
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

// Read full request body as string, rejecting with BodyTooLargeError once
// the running total exceeds maxBytes. We pause the request once over the
// limit so we stop accumulating into memory; the socket is torn down by
// createServer's 413 path after the response flushes (destroying it here
// races the response and the client never sees the 413).
//
// Settles on the first of: end (resolve), error (reject), close-without-end
// (reject as ECONNRESET-style), or oversize (reject as BodyTooLargeError).
// All four listeners are torn down on settle so a paused/aborted upload
// can't leave the closure (and the accumulated chunks) pinned in memory.
export function readBody(req: IncomingMessage, maxBytes: number = MAX_BODY_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const cleanup = (): void => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("close", onClose);
    };
    const settleResolve = (value: string): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const settleReject = (err: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const onData = (c: Buffer): void => {
      if (settled) return;
      total += c.length;
      if (total > maxBytes) {
        // Pause so we stop accumulating; rejection runs the 413 path in
        // createServer, which destroys the socket after the response flushes.
        req.pause();
        settleReject(new BodyTooLargeError(maxBytes));
        return;
      }
      chunks.push(c);
    };
    const onEnd = (): void => settleResolve(Buffer.concat(chunks).toString("utf-8"));
    const onError = (err: Error): void => settleReject(err);
    // 'close' fires after end OR after an abort. If end ran first we're
    // already settled and this is a no-op; otherwise the client disconnected
    // mid-upload and we must reject so the handler doesn't hang forever.
    const onClose = (): void => settleReject(new Error("client closed connection before request body completed"));

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    req.on("close", onClose);
  });
}

// Parse CLI argument by name: --flag value
export function getArg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  return idx !== -1 && idx + 1 < process.argv.length ? process.argv[idx + 1] : undefined;
}

// Create HTTP server with async handler and error catching. BodyTooLargeError
// is special-cased to 413 + Connection: close so the client sees a clean
// "payload too large" instead of the catch-all 500. After the response
// flushes we destroy the socket so an attacker can't keep streaming bytes
// into the kernel buffer beyond the limit we just enforced.
export function createServer(handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>) {
  return nodeCreateServer((req, res) => {
    handler(req, res).catch((err) => {
      console.error(`Request handler error: ${(err as Error).message}`);
      if (!res.headersSent) {
        if (err instanceof BodyTooLargeError) {
          res.writeHead(413, { "Content-Type": "application/json", Connection: "close" });
          res.end(JSON.stringify({ error: err.message }), () => {
            req.socket?.destroy();
          });
          return;
        }
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

// Single source of truth for the server-name policy enforced everywhere
// (host config load, proxy discovery filter, and the Pages function path
// allowlist). Keeping these in lockstep prevents valid host config entries
// from silently disappearing during discovery.
export const TOOL_NAME_SEPARATOR = "__";
export const SERVER_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

// Returns null if the name is acceptable, else a human-readable reason.
export function validateServerName(name: string): string | null {
  if (!SERVER_NAME_PATTERN.test(name)) {
    return `must match ${SERVER_NAME_PATTERN} (letters, digits, '.', '_', '-')`;
  }
  if (name.includes(TOOL_NAME_SEPARATOR)) {
    return `must not contain '${TOOL_NAME_SEPARATOR}' (reserved as tool-name separator)`;
  }
  return null;
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
