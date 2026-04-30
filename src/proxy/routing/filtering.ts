import { TOOL_SEPARATOR } from "../core/constants.js";
import type {
  HostState,
  PairingConfig,
  Prompt,
  Resource,
  ResourceTemplate,
  Tool,
  ToolRoute,
} from "../core/types.js";
import { wrapResourceUri } from "./uri.js";

// One key per server in `selectedServers`. Centralised so the format never
// drifts between the filter, the setup page, and validation.
export function serverKey(hostId: string, serverName: string): string {
  return `${hostId}${TOOL_SEPARATOR}${serverName}`;
}

// Server-level allow check. undefined = no filter (every server exposed);
// array = only the listed entries (each `<hostId>__<serverName>`). This is
// the single gate that hides ALL of a server's capabilities — tools,
// prompts, resources, templates, and the routed methods that read them.
// Without it a server with all tools deselected still leaked prompts and
// resources through the proxy (CR-01).
export function isServerSelected(config: PairingConfig | null, hostId: string, serverName: string): boolean {
  if (!config) return false;
  if (config.selectedServers === undefined) return true;
  return config.selectedServers.includes(serverKey(hostId, serverName));
}

// Build the agent-facing tools list. Filters by both selectedServers
// (server-level) and selectedTools (tool-level within an allowed server).
// Description is prefixed with origin so two servers with same-named tools
// don't confuse the agent.
export function getFilteredTools(
  config: PairingConfig | null,
  hosts: Map<string, HostState>,
  toolRoute: Map<string, ToolRoute>,
): Tool[] {
  if (!config) return [];
  const selectedToolSet = config.selectedTools !== undefined ? new Set(config.selectedTools) : null;

  const tools: Tool[] = [];
  for (const [prefixed, route] of toolRoute) {
    if (!isServerSelected(config, route.hostId, route.serverName)) continue;
    if (selectedToolSet && !selectedToolSet.has(prefixed)) continue;
    const server = hosts.get(route.hostId)?.servers.get(route.serverName);
    const original = server?.tools.find((t) => t.name === route.originalName);
    if (!original) continue;
    tools.push({
      ...original,
      name: prefixed,
      description: `[${route.hostId}/${route.serverName}] ${original.description ?? ""}`.trim(),
    });
  }
  return tools;
}

// Prompts have no per-prompt filter today — only the server-level gate.
// Description prefixed with origin for the same disambiguation reason as
// tools.
export function getAggregatedPrompts(
  config: PairingConfig | null,
  hosts: Map<string, HostState>,
  promptRoute: Map<string, ToolRoute>,
): Prompt[] {
  if (!config) return [];
  const prompts: Prompt[] = [];
  for (const [prefixed, route] of promptRoute) {
    if (!isServerSelected(config, route.hostId, route.serverName)) continue;
    const server = hosts.get(route.hostId)?.servers.get(route.serverName);
    const original = server?.prompts.find((p) => p.name === route.originalName);
    if (!original) continue;
    prompts.push({
      ...original,
      name: prefixed,
      description: `[${route.hostId}/${route.serverName}] ${original.description ?? ""}`.trim(),
    });
  }
  return prompts;
}

// Resources are namespaced on the way out: every URI is wrapped with the
// owning (hostId, serverName) so two upstream servers exposing the same
// raw URI (or overlapping templates) are unambiguous to the agent and to
// the routing path. Server-level gate hides every URI from a deselected
// server. Round-trip is symmetric — handleResourceMethod unwraps on the
// way back in.
export function getAggregatedResources(
  config: PairingConfig | null,
  hosts: Map<string, HostState>,
  exact: Array<{ uri: string; route: ToolRoute }>,
): Resource[] {
  if (!config) return [];
  const out: Resource[] = [];
  for (const { uri, route } of exact) {
    if (!isServerSelected(config, route.hostId, route.serverName)) continue;
    const server = hosts.get(route.hostId)?.servers.get(route.serverName);
    const original = server?.resources.find((r) => r.uri === uri);
    if (!original) continue;
    out.push({ ...original, uri: wrapResourceUri(route.hostId, route.serverName, original.uri) });
  }
  return out;
}

export function getAggregatedResourceTemplates(
  config: PairingConfig | null,
  hosts: Map<string, HostState>,
  templates: Array<{ uriTemplate: string; route: ToolRoute }>,
): ResourceTemplate[] {
  if (!config) return [];
  const out: ResourceTemplate[] = [];
  for (const { uriTemplate, route } of templates) {
    if (!isServerSelected(config, route.hostId, route.serverName)) continue;
    const server = hosts.get(route.hostId)?.servers.get(route.serverName);
    const original = server?.resourceTemplates.find((t) => t.uriTemplate === uriTemplate);
    if (!original) continue;
    // Wrapping the template is safe: RFC 6570 expansion is left-to-right
    // substitution of `{...}` literals, and the prefix has no braces, so
    // an agent expanding the wrapped template yields a URI the proxy can
    // structurally unwrap on the way back.
    out.push({ ...original, uriTemplate: wrapResourceUri(route.hostId, route.serverName, original.uriTemplate) });
  }
  return out;
}
