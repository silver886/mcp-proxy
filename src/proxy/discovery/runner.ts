import { TOOL_SEPARATOR } from "../core/constants.js";
import type { ProxyState } from "../core/state.js";
import type { HostState, ServerState, ToolRoute } from "../core/types.js";
import { isServerSelected } from "../routing/filtering.js";
import type { SseReader } from "../runtime/sse.js";
import {
  deleteSession,
  DiscoveryError,
  discoverServerCapabilities,
  fetchPromptsStrict,
  fetchResourceTemplatesStrict,
  fetchResourcesStrict,
  fetchTools,
  listHostServers,
} from "./client.js";

// Owns the proxy's discovery + refresh + per-server init logic. One pass
// runs at a time (single-flighted via state.discoveryInflight); each
// individual server is initialised through the shared
// discoverServerCapabilities helper so pairing-time and runtime use the
// exact same handshake.
export class DiscoveryRunner {
  constructor(
    private readonly state: ProxyState,
    private readonly sse: SseReader,
    private readonly log: (line: string) => void,
  ) {}

  // After every upstream POST: if the host returned a different session
  // id, restart the SSE notification loop bound to the new id. Without
  // this, notifications go to the old session's queue and are silently
  // lost. Lives here because it owns both the server state mutation and
  // the SSE handle — Forwarder/Bridge call into it through a callback.
  captureSessionId(host: HostState, serverName: string, server: ServerState, newId: string | null): void {
    if (!newId) return;
    if (server.sessionId === newId) return;
    server.sessionId = newId;
    this.sse.start(host, serverName, newId);
  }

  // True if any server stored under this host still has a capability list
  // that needs to be re-fetched. Drives both the discovery host filter
  // and retryDiscoveryIfNeeded's gate.
  private static hasPendingCapabilities(host: HostState): boolean {
    for (const server of host.servers.values()) {
      if (server.pendingPrompts || server.pendingResources || server.pendingResourceTemplates) return true;
    }
    return false;
  }

  // Retry-on-demand: kick another pass if any host hasn't fully settled.
  // "Fully settled" means listing succeeded AND every server it named has
  // an entry in host.servers (pendingServers is empty) AND every stored
  // server has all three capability lists committed (no pending* flags).
  // discoverServers is single-flighted, runDiscovery skips fully-settled
  // hosts, discoverHost only re-runs init for the residual pendingServers,
  // and retryPendingCapabilities only refetches the capability lists that
  // are still pending — so this stays cheap once the system has stabilised.
  async retryDiscoveryIfNeeded(): Promise<void> {
    if (!this.state.config) return;
    if (Array.from(this.state.hosts.values()).some((h) => !h.listed || h.pendingServers.size > 0 || DiscoveryRunner.hasPendingCapabilities(h))) {
      await this.discoverServers();
    }
  }

  discoverServers(): Promise<void> {
    if (this.state.discoveryInflight) return this.state.discoveryInflight;
    if (!this.state.config) return Promise.resolve();
    const run = this.runDiscovery().finally(() => {
      this.state.discoveryInflight = null;
    });
    this.state.discoveryInflight = run;
    return run;
  }

  private async runDiscovery(): Promise<void> {
    if (!this.state.config) return;

    // Snapshot the generation and the host references at the start. If a
    // re-pair swaps in a new pairing while we're awaiting upstream calls,
    // this run is superseded: discoverHost's writes go to detached host
    // objects (harmless), and we skip rebuildToolRoute so we don't
    // clobber the new pairing's state.
    const gen = this.state.configGeneration;
    const hostsSnapshot = Array.from(this.state.hosts.values());

    // Parallel host discovery. One slow host no longer delays the others —
    // each host's failures are caught inside discoverHost so a single
    // rejected promise can't poison the batch (allSettled is still used
    // for defensive symmetry). A host with listing done but lingering
    // pendingServers gets re-entered so its residual inits retry.
    await Promise.allSettled(
      hostsSnapshot
        .filter((h) => !h.listed || h.pendingServers.size > 0 || DiscoveryRunner.hasPendingCapabilities(h))
        .map((h) => this.discoverHost(h)),
    );

    if (gen !== this.state.configGeneration) return;
    this.rebuildToolRoute();
    this.log(`  Total tools: ${this.state.toolRoute.size}\n`);
  }

  private async discoverHost(host: HostState): Promise<void> {
    this.log(`  Host [${host.config.id}] ${host.config.tunnelUrl}`);

    if (!host.listed) {
      let serverNames: string[];
      try {
        // listHostServers itself runs each advertised name through the
        // shared validator and logs anything dropped, so the result is
        // already safe to route — no second filter needed here.
        serverNames = await listHostServers(host.config.tunnelUrl, this.state.hostHeaders(host.config), this.log);
      } catch (err) {
        this.log(`    Discovery failed: ${(err as Error).message}`);
        return;
      }

      // Drop deselected servers BEFORE we ever open a session. Without this
      // the proxy spawns a child for every advertised server, forwards the
      // real client capabilities upstream, and leaves an SSE loop attached
      // — even for servers the user explicitly unchecked. selectedServers
      // is a least-privilege boundary, so it has to gate side-effects, not
      // just the agent-facing surface.
      const selected = serverNames.filter((name) => {
        if (isServerSelected(this.state.config, host.config.id, name)) return true;
        this.log(`    [${name}] skipped: not in selectedServers`);
        return false;
      });

      this.log(`    discovered: ${selected.join(", ") || "(none)"}`);
      for (const name of selected) host.pendingServers.add(name);
      host.listed = true;
    } else if (host.pendingServers.size > 0) {
      this.log(`    retrying inits: ${Array.from(host.pendingServers).join(", ")}`);
    }

    // Snapshot first — initServer mutates pendingServers on success, and
    // iterating a Set we're deleting from is footgun-territory. Servers
    // within a host stay sequential: they share a session lifecycle and
    // ordering keeps stderr readable.
    for (const name of Array.from(host.pendingServers)) {
      await this.initServer(host, name);
    }

    await this.retryPendingCapabilities(host);
  }

  // Re-fetch any capability list that failed during init for an
  // already-stored server. Each per-capability flag is independent: a
  // server with healthy tools but a transient prompts/list failure stays
  // online and serves tools, and only the failed list is retried here.
  // Strict variants keep the cached value on failure (preserve-on-failure)
  // so a transient blip on the retry doesn't wipe what we already have.
  private async retryPendingCapabilities(host: HostState): Promise<void> {
    for (const [serverName, server] of host.servers) {
      if (!server.sessionId) continue;
      if (!server.pendingPrompts && !server.pendingResources && !server.pendingResourceTemplates) continue;

      const target = `${host.config.tunnelUrl}/servers/${serverName}`;
      const headers = { ...this.state.hostHeaders(host.config), "Mcp-Session-Id": server.sessionId };

      if (server.pendingPrompts) {
        try {
          server.prompts = await fetchPromptsStrict(target, headers, serverName);
          server.pendingPrompts = false;
          this.log(`    [${host.config.id}/${serverName}] prompts retry ok: ${server.prompts.length}`);
        } catch (err) {
          this.log(`    [${host.config.id}/${serverName}] prompts retry failed: ${(err as Error).message}`);
        }
      }
      if (server.pendingResources) {
        try {
          server.resources = await fetchResourcesStrict(target, headers, serverName);
          server.pendingResources = false;
          this.log(`    [${host.config.id}/${serverName}] resources retry ok: ${server.resources.length}`);
        } catch (err) {
          this.log(`    [${host.config.id}/${serverName}] resources retry failed: ${(err as Error).message}`);
        }
      }
      if (server.pendingResourceTemplates) {
        try {
          server.resourceTemplates = await fetchResourceTemplatesStrict(target, headers, serverName);
          server.pendingResourceTemplates = false;
          this.log(`    [${host.config.id}/${serverName}] templates retry ok: ${server.resourceTemplates.length}`);
        } catch (err) {
          this.log(`    [${host.config.id}/${serverName}] templates retry failed: ${(err as Error).message}`);
        }
      }
    }
  }

  async initServer(host: HostState, name: string): Promise<void> {
    const targetUrl = `${host.config.tunnelUrl}/servers/${name}`;
    const headers = this.state.hostHeaders(host.config);

    let result;
    try {
      result = await discoverServerCapabilities(
        targetUrl,
        headers,
        name,
        this.state.clientCapabilities,
        this.state.clientInfo,
        (line) => this.log(line),
      );
    } catch (err) {
      // Leave name in pendingServers so the next on-demand discovery pass
      // retries the init. The list call already succeeded — only the per-
      // server init is in residue. Best-effort cleanup of any orphaned
      // upstream session the failed handshake left behind.
      const dErr = err as DiscoveryError;
      this.log(`    [${name}] init failed: ${dErr.message}`);
      if (dErr.sessionId) {
        void deleteSession(targetUrl, { ...headers, "Mcp-Session-Id": dErr.sessionId });
      }
      return;
    }

    const state: ServerState = {
      sessionId: result.sessionId,
      tools: result.tools,
      prompts: result.prompts,
      resources: result.resources,
      resourceTemplates: result.resourceTemplates,
      pendingPrompts: result.pendingPrompts,
      pendingResources: result.pendingResources,
      pendingResourceTemplates: result.pendingResourceTemplates,
      // Fresh session starts with no subscriptions. Stale-session recovery
      // in Forwarder snapshots the prior set BEFORE calling initServer and
      // replays it onto the new state, so an init that runs as part of
      // recovery still ends up with the right subscriptions populated.
      subscriptions: new Set(),
    };
    host.servers.set(name, state);
    host.pendingServers.delete(name);
    if (result.sessionId) this.sse.start(host, name, result.sessionId);
    this.log(
      `    [${name}] ${result.tools.length} tools, ${result.prompts.length} prompts, ${result.resources.length} resources, ${result.resourceTemplates.length} templates`,
    );
  }

  rebuildToolRoute(): void {
    this.state.toolRoute.clear();
    this.state.promptRoute.clear();
    this.state.resources.clear();
    for (const host of this.state.hosts.values()) {
      for (const [serverName, state] of host.servers) {
        const route = (originalName: string): ToolRoute => ({ hostId: host.config.id, serverName, originalName });

        for (const tool of state.tools) {
          const prefixed = `${host.config.id}${TOOL_SEPARATOR}${serverName}${TOOL_SEPARATOR}${tool.name}`;
          this.state.toolRoute.set(prefixed, route(tool.name));
        }
        for (const prompt of state.prompts) {
          const prefixed = `${host.config.id}${TOOL_SEPARATOR}${serverName}${TOOL_SEPARATOR}${prompt.name}`;
          this.state.promptRoute.set(prefixed, route(prompt.name));
        }
        const collisions = this.state.resources.add(host.config.id, serverName, state.resources, state.resourceTemplates);
        for (const line of collisions) this.log(`  ${line}`);
      }
    }
    this.state.templateRoutes = this.state.resources.templateEntries();
  }

  // --- Refresh on list_changed ---

  async refreshTools(host: HostState, serverName: string): Promise<void> {
    const server = host.servers.get(serverName);
    if (!server || !server.sessionId) return;

    const target = `${host.config.tunnelUrl}/servers/${serverName}`;
    const headers = { ...this.state.hostHeaders(host.config), "Mcp-Session-Id": server.sessionId };
    try {
      server.tools = await fetchTools(target, headers, serverName);
    } catch {
      return;
    }
    this.rebuildToolRoute();
    this.log(`  [${host.config.id}/${serverName}] tools refreshed: ${server.tools.length}`);
  }

  async refreshPrompts(host: HostState, serverName: string): Promise<void> {
    const server = host.servers.get(serverName);
    if (!server || !server.sessionId) return;

    const target = `${host.config.tunnelUrl}/servers/${serverName}`;
    const headers = { ...this.state.hostHeaders(host.config), "Mcp-Session-Id": server.sessionId };
    // Strict + preserve-on-failure: a transient HTTP/JSON-RPC blip during
    // refresh used to wipe the cached prompt list and hide prompts until
    // another list_changed arrived. Now we only commit the new list when
    // the fetch actually succeeds.
    let next: typeof server.prompts;
    try {
      next = await fetchPromptsStrict(target, headers, serverName);
    } catch (err) {
      this.log(`  [${host.config.id}/${serverName}] prompts refresh failed (keeping cached ${server.prompts.length}): ${(err as Error).message}`);
      return;
    }
    server.prompts = next;
    this.rebuildToolRoute();
    this.log(`  [${host.config.id}/${serverName}] prompts refreshed: ${server.prompts.length}`);
  }

  async refreshResources(host: HostState, serverName: string): Promise<void> {
    const server = host.servers.get(serverName);
    if (!server || !server.sessionId) return;

    const target = `${host.config.tunnelUrl}/servers/${serverName}`;
    const headers = { ...this.state.hostHeaders(host.config), "Mcp-Session-Id": server.sessionId };
    // Refresh both lists in parallel — the SSE notification only says
    // "something changed", not whether it's the concrete list or the
    // templates. At this scale a double-fetch is cheaper than waiting on
    // a sequential chain. Each side is strict + preserve-on-failure so a
    // transient failure on one list doesn't take the other down with it.
    const [resourcesResult, templatesResult] = await Promise.allSettled([
      fetchResourcesStrict(target, headers, serverName),
      fetchResourceTemplatesStrict(target, headers, serverName),
    ]);

    let resourcesChanged = false;
    let templatesChanged = false;
    if (resourcesResult.status === "fulfilled") {
      server.resources = resourcesResult.value;
      resourcesChanged = true;
    } else {
      this.log(`  [${host.config.id}/${serverName}] resources refresh failed (keeping cached ${server.resources.length}): ${(resourcesResult.reason as Error).message}`);
    }
    if (templatesResult.status === "fulfilled") {
      server.resourceTemplates = templatesResult.value;
      templatesChanged = true;
    } else {
      this.log(`  [${host.config.id}/${serverName}] templates refresh failed (keeping cached ${server.resourceTemplates.length}): ${(templatesResult.reason as Error).message}`);
    }
    if (!resourcesChanged && !templatesChanged) return;
    this.rebuildToolRoute();
    this.log(`  [${host.config.id}/${serverName}] resources refreshed: ${server.resources.length} concrete, ${server.resourceTemplates.length} templates`);
  }
}
