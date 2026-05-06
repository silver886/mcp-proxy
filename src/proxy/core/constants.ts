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

// Local tool: kill the host's child process for a wedged MCP server so the
// next forward re-spawns it. The description teaches the LLM how to format
// the `tool` argument, since the form it sees in its catalog (wrapped by
// its MCP client as `mcp__<alias>__...`) is NOT the form the proxy parses.
export const RESTART_SERVER_TOOL: Tool = {
  name: "restart_server",
  description:
    "Restart a wedged MCP server (kills the host's child process; next call respawns it). "
    + "Pass `tool` as the proxy-internal name `<host>__<server>__<tool>`. "
    + "If your tool catalog shows it as `mcp__<alias>__<host>__<server>__<tool>`, strip the `mcp__<alias>__` prefix first. "
    + "Or pass `host` and `server` directly (visible in every tool's description as `[<host>/<server>]`).",
  inputSchema: {
    type: "object",
    properties: {
      tool: {
        type: "string",
        description: "Proxy-internal tool name <host>__<server>__<tool>. Strip any mcp__<alias>__ wrapper your client adds.",
      },
      host: { type: "string", description: "Host id (alternative to tool)." },
      server: { type: "string", description: "Server name (alternative to tool)." },
    },
  },
};

// Local prompt counterpart. Same handler, same parser — the prompt is just
// another entry point so an operator can drive a restart from the picker
// without round-tripping through the LLM's planner.
export const RESTART_SERVER_PROMPT: Prompt = {
  name: "restart_server",
  description: "Restart a wedged MCP server (kills the host's child; next call respawns).",
  arguments: [
    {
      name: "tool",
      description: "Proxy-internal tool name <host>__<server>__<tool>. Strip any mcp__<alias>__ wrapper your client adds.",
      required: false,
    },
    { name: "host", description: "Host id (alternative to tool).", required: false },
    { name: "server", description: "Server name (alternative to tool).", required: false },
  ],
};
