// Type definitions shared across proxy submodules. Kept in one place so the
// route map / pairing config / server state contracts are visible without
// chasing imports through every file.

export interface Tool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface Prompt {
  name: string;
  description?: string;
  arguments?: unknown;
}

export interface Resource {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

export interface ResourceTemplate {
  uriTemplate: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

export interface HostConfig {
  id: string;
  tunnelUrl: string;
  authToken: string;
  label?: string;
}

export interface PairingConfig {
  hosts: HostConfig[];
  // Server-level allowlist. undefined = every discovered server is exposed;
  // array = only the listed entries (each `<hostId>__<serverName>`). Drives
  // exposure of tools, prompts, resources, and resource templates uniformly,
  // so unchecking a server in the UI hides every capability it offers — not
  // just its tools.
  selectedServers?: string[];
  // Within an exposed server, an optional tool-level filter. undefined =
  // every tool the server lists; array = only the listed entries (each
  // `<hostId>__<serverName>__<toolName>`). Empty array exposes zero tools
  // but does not hide the server's prompts/resources — that is what
  // `selectedServers` is for.
  selectedTools?: string[];
  sealed: boolean;
}

export interface ServerState {
  sessionId?: string;
  tools: Tool[];
  prompts: Prompt[];
  resources: Resource[];
  resourceTemplates: ResourceTemplate[];
  // Per-capability pending flags. Set true when the corresponding list call
  // failed for a non-METHOD_NOT_FOUND reason (transport blip, JSON-RPC
  // error, malformed body) during initial discovery, so the server is still
  // usable for the capabilities that succeeded but the failed list will be
  // re-fetched on the next discovery pass. METHOD_NOT_FOUND is "feature
  // absent" — returns [] without setting the flag, since there's nothing to
  // retry.
  pendingPrompts: boolean;
  pendingResources: boolean;
  pendingResourceTemplates: boolean;
  // Original (unwrapped) URIs the agent currently has resources/subscribe'd
  // through this server's session. Subscriptions are session-scoped on the
  // upstream, so when stale-session 404 recovery mints a fresh sessionId
  // the proxy must replay these on the new session — otherwise the agent
  // believes it's still subscribed while the upstream has forgotten and
  // notifications/resources/updated silently stop.
  subscriptions: Set<string>;
}

export interface HostState {
  config: HostConfig;
  servers: Map<string, ServerState>;
  sseControllers: Map<string, AbortController>;
  // True once `GET /` returned the host's server list. We don't re-list a
  // host whose listing already succeeded; we just retry the per-server
  // inits below.
  listed: boolean;
  // Server names the listing reported but whose `initialize` round-trip
  // didn't complete (network blip, child spawn race, transient JSON-RPC
  // error). Names are removed as init succeeds; a host is "fully
  // discovered" only once `listed` is true and this set is empty. Each
  // top-level list call retries the residue, so a transient per-server
  // failure no longer pins a host empty until re-pair.
  pendingServers: Set<string>;
}

// Single shape for tool/prompt/resource routing — every namespace maps a
// prefixed (or URI-keyed) entry back to the upstream server that owns it.
export interface ToolRoute {
  hostId: string;
  serverName: string;
  originalName: string;
}
