import { TOOL_NAME_SEPARATOR } from "../../shared/protocol.js";
import type { Prompt, Tool } from "./types.js";

export const TOOL_SEPARATOR = TOOL_NAME_SEPARATOR;

// Pairing-tunnel + bridging budgets.
export const TUNNEL_STARTUP_TIMEOUT_MS = 30_000; // bring up cloudflared
export const PAIRING_WINDOW_MS = 10 * 60 * 1000; // hard expiry per pairing
export const UPSTREAM_REQUEST_TIMEOUT_MS = 120_000; // server→client bridge

// Per-fetch budgets. Discovery + pairing-forward are short — anything that
// can't answer the MCP handshake in this many milliseconds is broken enough
// to surface to the user. Tool calls / prompt gets / resource reads ride a
// much longer budget because they are user-bound (long shell commands,
// large filesystem reads, etc.).
export const DISCOVERY_FETCH_TIMEOUT_MS = 15_000;
export const TOOL_FORWARD_TIMEOUT_MS = 5 * 60 * 1000;
export const SESSION_DELETE_TIMEOUT_MS = 5_000;

// Pairing HTTP server per-request budgets. Pairing payloads are small JSON
// blobs (host creds, selected servers/tools), so a slow header or body
// phase is broken or hostile rather than legitimate. Bounding both prevents
// a slow upload from outliving PAIRING_WINDOW_MS via Node's defaults
// (headersTimeout 60s, requestTimeout 5min).
export const PAIRING_HEADERS_TIMEOUT_MS = 30_000;
export const PAIRING_REQUEST_TIMEOUT_MS = 60_000;

export const SSE_BACKOFF_INITIAL_MS = 500;
export const SSE_BACKOFF_MAX_MS = 10_000;
// Bound the connect+headers phase only. A blackholed tunnel would otherwise
// leave fetch() waiting on the OS connect timeout (Linux ~127s) before the
// loop could fall through to backoff, freezing list_changed and server-
// initiated requests for that session. The streaming body is NOT bounded
// by this timeout — once headers arrive, the read loop runs under the
// lifecycle signal alone.
export const SSE_CONNECT_TIMEOUT_MS = 15_000;

// Local tool: always advertised so a client can re-pair without a process
// restart, even if discovery returned zero upstream tools.
export const CONFIGURE_TOOL: Tool = {
  name: "configure",
  description: "Set up or reconfigure the MCP proxy connection. Returns the setup URL.",
  inputSchema: { type: "object", properties: {} },
};

// Local prompt counterpart. Surfaced even when no upstream prompts exist so
// an agent can always pull up the setup URL through prompts/get.
export const CONFIGURE_PROMPT: Prompt = {
  name: "configure",
  description: "Set up or reconfigure the MCP proxy connection.",
};
