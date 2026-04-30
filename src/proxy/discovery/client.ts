import { MCP_PROTOCOL_VERSION, validateServerName } from "../../shared/protocol.js";
import { DISCOVERY_FETCH_TIMEOUT_MS, SESSION_DELETE_TIMEOUT_MS } from "../core/constants.js";
import { timeoutSignal } from "../core/fetch-timeout.js";
import type { Prompt, Resource, ResourceTemplate, Tool } from "../core/types.js";

// Discovery helpers. Capability list calls (prompts/resources/templates)
// distinguish METHOD_NOT_FOUND ("feature absent" → []) from any other
// failure (transport blip, JSON-RPC error, malformed body → throw). The
// caller decides whether to preserve cached state, mark a per-capability
// retry flag, or fail outright. Every fetch is wrapped in
// DISCOVERY_FETCH_TIMEOUT_MS so a host that accepts the connection then
// hangs can't pin the proxy.

interface InitResponse {
  ok: boolean;
  status: number;
  sessionId?: string;
  body: string;
}

export async function initializeServer(
  targetUrl: string,
  baseHeaders: Record<string, string>,
  name: string,
  clientCapabilities: Record<string, unknown>,
  clientInfo: { name: string; version: string },
): Promise<InitResponse> {
  const resp = await fetch(targetUrl, {
    method: "POST",
    headers: baseHeaders,
    signal: timeoutSignal(DISCOVERY_FETCH_TIMEOUT_MS),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `init-${name}`,
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: clientCapabilities,
        clientInfo,
      },
    }),
  });
  return {
    ok: resp.ok,
    status: resp.status,
    sessionId: resp.headers.get("mcp-session-id") ?? undefined,
    body: await resp.text(),
  };
}

export async function sendInitialized(
  targetUrl: string,
  sessionHeaders: Record<string, string>,
): Promise<void> {
  await fetch(targetUrl, {
    method: "POST",
    headers: sessionHeaders,
    signal: timeoutSignal(DISCOVERY_FETCH_TIMEOUT_MS),
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
  });
}

// Reject malformed envelopes (no `result` object, or expected field is not
// an array) with a thrown error rather than silently returning []. A broken
// upstream that answers a list call with `{}` or `{result: null}` would
// otherwise be indistinguishable from "feature absent" — the runtime proxy
// would mark the capability as healthy-but-empty, and the pairing UI would
// claim the server has zero tools/prompts/resources.
function extractListField<T>(data: unknown, method: string, resultField: string): T[] {
  if (!data || typeof data !== "object") {
    throw new Error(`${method} response is not a JSON object`);
  }
  const result = (data as { result?: unknown }).result;
  if (!result || typeof result !== "object") {
    throw new Error(`${method} response is missing the \`result\` object`);
  }
  const list = (result as Record<string, unknown>)[resultField];
  if (!Array.isArray(list)) {
    throw new Error(`${method} response is missing the \`result.${resultField}\` array`);
  }
  return list as T[];
}

export async function fetchTools(
  targetUrl: string,
  headers: Record<string, string>,
  name: string,
): Promise<Tool[]> {
  const resp = await fetch(targetUrl, {
    method: "POST",
    headers,
    signal: timeoutSignal(DISCOVERY_FETCH_TIMEOUT_MS),
    body: JSON.stringify({ jsonrpc: "2.0", id: `tools-${name}`, method: "tools/list", params: {} }),
  });
  if (!resp.ok) throw new Error(`tools/list HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  let data: unknown;
  try {
    data = await resp.json();
  } catch (err) {
    throw new Error(`tools/list returned malformed JSON: ${(err as Error).message}`);
  }
  const error = (data as { error?: { message?: string } }).error;
  if (error) throw new Error(`tools/list error: ${error.message ?? JSON.stringify(error)}`);
  return extractListField<Tool>(data, "tools/list", "tools");
}

// JSON-RPC METHOD_NOT_FOUND — what an MCP server returns when it doesn't
// support a capability. Treated as "feature absent" (empty list), distinct
// from a transport blip which the strict variants surface as a throw.
const METHOD_NOT_FOUND = -32601;

// Run a tools/prompts/resources-style list call against the upstream and
// extract the list field. Throws on any transport, parse, or JSON-RPC
// failure other than METHOD_NOT_FOUND, which collapses to []. Callers
// (initial discovery, capability retry, refresh paths) catch and decide
// what to do — preserve cached state, mark pending, fail outright.
// Centralising the request/response shape here keeps the four list calls
// from drifting from each other.
async function fetchListStrict<T>(
  targetUrl: string,
  headers: Record<string, string>,
  reqId: string,
  method: string,
  resultField: string,
): Promise<T[]> {
  const resp = await fetch(targetUrl, {
    method: "POST",
    headers,
    signal: timeoutSignal(DISCOVERY_FETCH_TIMEOUT_MS),
    body: JSON.stringify({ jsonrpc: "2.0", id: reqId, method, params: {} }),
  });
  if (!resp.ok) throw new Error(`${method} HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  let data: unknown;
  try {
    data = await resp.json();
  } catch (err) {
    throw new Error(`${method} returned malformed JSON: ${(err as Error).message}`);
  }
  const error = (data as { error?: { code?: number; message?: string } }).error;
  if (error) {
    if (error.code === METHOD_NOT_FOUND) return [];
    throw new Error(`${method} error: ${error.message ?? JSON.stringify(error)}`);
  }
  return extractListField<T>(data, method, resultField);
}

// Strict variants: throw on transport / non-METHOD_NOT_FOUND JSON-RPC
// errors so the caller can decide whether to preserve cached state. Used
// by refresh paths that must NOT wipe a server's prompts/resources on a
// transient blip.
export function fetchPromptsStrict(
  targetUrl: string,
  headers: Record<string, string>,
  name: string,
): Promise<Prompt[]> {
  return fetchListStrict<Prompt>(targetUrl, headers, `prompts-${name}`, "prompts/list", "prompts");
}

export function fetchResourcesStrict(
  targetUrl: string,
  headers: Record<string, string>,
  name: string,
): Promise<Resource[]> {
  return fetchListStrict<Resource>(targetUrl, headers, `resources-${name}`, "resources/list", "resources");
}

export function fetchResourceTemplatesStrict(
  targetUrl: string,
  headers: Record<string, string>,
  name: string,
): Promise<ResourceTemplate[]> {
  return fetchListStrict<ResourceTemplate>(
    targetUrl,
    headers,
    `templates-${name}`,
    "resources/templates/list",
    "resourceTemplates",
  );
}

// Result of one full per-server discovery handshake. `sessionId` is the
// host-minted session the caller now owns: keep it alive (runtime path)
// or DELETE it once the result has been consumed (pairing path). The
// `pending*` flags + `capErrors` mirror what runtime discovery records on
// ServerState — pairing surfaces them to the browser so partial-capability
// failures are visible during setup, not silent.
export interface ServerDiscoveryResult {
  sessionId: string | undefined;
  tools: Tool[];
  prompts: Prompt[];
  resources: Resource[];
  resourceTemplates: ResourceTemplate[];
  pendingPrompts: boolean;
  pendingResources: boolean;
  pendingResourceTemplates: boolean;
  capErrors: { prompts?: string; resources?: string; resourceTemplates?: string };
}

// Errors thrown out of the handshake carry the captured session id, if
// any, so the caller can DELETE the orphaned upstream session after a
// post-init failure (sendInitialized / tools/list). Without this, a
// transient JSON-RPC error on tools/list would leak a child process on
// the host until idle GC reaped it ~30 minutes later.
export class DiscoveryError extends Error {
  constructor(message: string, public readonly sessionId: string | undefined) {
    super(message);
    this.name = "DiscoveryError";
  }
}

// Single source of truth for the per-server MCP handshake: initialize →
// notifications/initialized → tools/list (required) → prompts / resources /
// templates (each optional, recorded as pending on failure). Used by both
// the runtime discovery path and the pairing-mediated discovery endpoint
// so the browser sees the same capability set the proxy will see at
// runtime — including using the real MCP client's capabilities/clientInfo
// rather than synthetic browser values.
export async function discoverServerCapabilities(
  targetUrl: string,
  baseHeaders: Record<string, string>,
  name: string,
  clientCapabilities: Record<string, unknown>,
  clientInfo: { name: string; version: string },
  log?: (line: string) => void,
): Promise<ServerDiscoveryResult> {
  let sessionId: string | undefined;
  try {
    const init = await initializeServer(targetUrl, baseHeaders, name, clientCapabilities, clientInfo);
    // Capture the session id BEFORE parsing the body. Once the host returned
    // 200 with a session header it has minted a child process, so the catch
    // path below needs the id to clean it up even if the JSON payload is an
    // error or malformed.
    sessionId = init.sessionId;
    if (!init.ok) {
      throw new Error(`initialize HTTP ${init.status}: ${init.body.slice(0, 200)}`);
    }
    let initData: { error?: { message?: string } };
    try {
      initData = JSON.parse(init.body) as typeof initData;
    } catch (err) {
      throw new Error(`initialize returned malformed JSON: ${(err as Error).message}`);
    }
    if (initData.error) {
      throw new Error(`initialize error: ${initData.error.message ?? JSON.stringify(initData.error)}`);
    }

    const sessionHeaders: Record<string, string> = { ...baseHeaders };
    if (sessionId) sessionHeaders["Mcp-Session-Id"] = sessionId;

    await sendInitialized(targetUrl, sessionHeaders);
    const tools = await fetchTools(targetUrl, sessionHeaders, name);

    // METHOD_NOT_FOUND on a capability is "feature absent" → empty list and
    // no pending flag. Any other failure (transport, JSON-RPC error,
    // malformed body) leaves the capability empty and sets the per-capability
    // pending flag so the caller can either retry (runtime) or surface the
    // failure to the user (pairing).
    const [promptsResult, resourcesResult, templatesResult] = await Promise.allSettled([
      fetchPromptsStrict(targetUrl, sessionHeaders, name),
      fetchResourcesStrict(targetUrl, sessionHeaders, name),
      fetchResourceTemplatesStrict(targetUrl, sessionHeaders, name),
    ]);

    const capErrors: ServerDiscoveryResult["capErrors"] = {};
    const prompts = promptsResult.status === "fulfilled" ? promptsResult.value : [];
    const pendingPrompts = promptsResult.status === "rejected";
    if (pendingPrompts) {
      capErrors.prompts = (promptsResult.reason as Error).message;
      log?.(`    [${name}] prompts/list failed (will retry): ${capErrors.prompts}`);
    }
    const resources = resourcesResult.status === "fulfilled" ? resourcesResult.value : [];
    const pendingResources = resourcesResult.status === "rejected";
    if (pendingResources) {
      capErrors.resources = (resourcesResult.reason as Error).message;
      log?.(`    [${name}] resources/list failed (will retry): ${capErrors.resources}`);
    }
    const resourceTemplates = templatesResult.status === "fulfilled" ? templatesResult.value : [];
    const pendingResourceTemplates = templatesResult.status === "rejected";
    if (pendingResourceTemplates) {
      capErrors.resourceTemplates = (templatesResult.reason as Error).message;
      log?.(`    [${name}] resources/templates/list failed (will retry): ${capErrors.resourceTemplates}`);
    }

    return {
      sessionId,
      tools,
      prompts,
      resources,
      resourceTemplates,
      pendingPrompts,
      pendingResources,
      pendingResourceTemplates,
      capErrors,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new DiscoveryError(message, sessionId);
  }
}

export async function deleteSession(
  targetUrl: string,
  headers: Record<string, string>,
): Promise<void> {
  try {
    await fetch(targetUrl, {
      method: "DELETE",
      headers,
      signal: timeoutSignal(SESSION_DELETE_TIMEOUT_MS),
    });
  } catch {
    /* host unreachable — idle GC will reap eventually */
  }
}

// List the servers a host advertises at GET /. Used by both runtime
// discovery (server.ts) and pairing-mediated discovery (the setup page,
// via the proxy's pairing endpoint). Filters server names through the
// shared validator so an upstream advertising a name the proxy/page
// can't safely route is dropped here rather than failing later in init —
// callers (runtime + pairing UI) get a single, consistent view of what
// the proxy will actually accept. Optional `log` surfaces dropped names
// to the operator on the runtime path; pairing leaves it unset so the
// UI just doesn't render unroutable rows.
export async function listHostServers(
  hostUrl: string,
  headers: Record<string, string>,
  log?: (line: string) => void,
): Promise<string[]> {
  const resp = await fetch(`${hostUrl}/`, {
    method: "GET",
    headers,
    signal: timeoutSignal(DISCOVERY_FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) {
    throw new Error(`list HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  }
  let data: unknown;
  try {
    data = await resp.json();
  } catch (err) {
    throw new Error(`list returned malformed JSON: ${(err as Error).message}`);
  }
  const servers = (data as { servers?: unknown }).servers;
  if (!Array.isArray(servers)) {
    throw new Error("list response is missing the `servers` array");
  }
  const out: string[] = [];
  for (const s of servers) {
    if (typeof s !== "string") continue;
    const reason = validateServerName(s);
    if (reason) {
      log?.(`    [${s}] skipped: ${reason}`);
      continue;
    }
    out.push(s);
  }
  return out;
}
