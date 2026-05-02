import { ErrorCode, MCP_PROTOCOL_VERSION, PACKAGE_NAME, PACKAGE_VERSION } from "../../shared/protocol.js";
import { CONFIGURE_PROMPT, CONFIGURE_TOOL } from "../core/constants.js";
import type { ProxyState } from "../core/state.js";
import type { ToolRoute } from "../core/types.js";
import type { DiscoveryRunner } from "../discovery/runner.js";
import type { PairingController } from "../pairing/controller.js";
import {
  getAggregatedPrompts,
  getAggregatedResources,
  getAggregatedResourceTemplates,
  getFilteredTools,
  isServerSelected,
} from "../routing/filtering.js";
import { unwrapResourceUri } from "../routing/uri.js";
import type { Forwarder } from "./forwarder.js";
import type { UpstreamBridge } from "./upstream-bridge.js";

// One method per JSON-RPC verb the agent can send. Each handler is
// responsible for: parameter validation, looking up the route from the
// (already discovered) state, and either answering locally or delegating
// to Forwarder. Lives here rather than on ProxyServer so the router file
// stays a thin dispatcher and the per-method logic doesn't have to share
// a 1k-line class with discovery, pairing, and forwarding.
export class RequestHandlers {
  constructor(
    private readonly state: ProxyState,
    private readonly runner: DiscoveryRunner,
    private readonly forwarder: Forwarder,
    private readonly pairing: PairingController,
    private readonly bridge: UpstreamBridge,
    private readonly sendResult: (id: string | number | null, result: unknown) => void,
    private readonly sendError: (code: number, detail: string | undefined, id: string | number | null) => void,
  ) {}

  handleInitialize(
    id: string | number,
    params: { capabilities?: Record<string, unknown>; clientInfo?: { name?: string; version?: string } } | undefined,
  ): void {
    this.state.clientCapabilities = params?.capabilities ?? {};
    if (params?.clientInfo?.name) {
      this.state.clientInfo = {
        name: params.clientInfo.name,
        version: params.clientInfo.version ?? "unknown",
      };
    }
    this.sendResult(id, {
      protocolVersion: MCP_PROTOCOL_VERSION,
      // listChanged is honest in both directions: SSE listeners relay
      // notifications/{tools,prompts,resources}/list_changed from each
      // upstream server with a cache refresh in between, so the agent's
      // follow-up list call sees fresh data.
      capabilities: {
        tools: { listChanged: true },
        prompts: { listChanged: true },
        resources: { listChanged: true, subscribe: true },
        logging: {},
        completions: {},
      },
      serverInfo: { name: PACKAGE_NAME, version: PACKAGE_VERSION },
    });
  }

  async handleToolsList(id: string | number): Promise<void> {
    if (!this.state.config) {
      this.sendResult(id, { tools: [CONFIGURE_TOOL] });
      return;
    }
    await this.runner.retryDiscoveryIfNeeded();
    this.sendResult(id, {
      tools: [CONFIGURE_TOOL, ...getFilteredTools(this.state.config, this.state.hosts, this.state.toolRoute)],
    });
  }

  async handlePromptsList(id: string | number): Promise<void> {
    if (!this.state.config) {
      this.sendResult(id, { prompts: [CONFIGURE_PROMPT] });
      return;
    }
    await this.runner.retryDiscoveryIfNeeded();
    // Inject CONFIGURE_PROMPT first so re-pairing is always one prompt away
    // regardless of upstream state.
    this.sendResult(id, {
      prompts: [CONFIGURE_PROMPT, ...getAggregatedPrompts(this.state.config, this.state.hosts, this.state.promptRoute)],
    });
  }

  async handlePromptDispatch(
    id: string | number,
    params: { name?: string; arguments?: Record<string, unknown> } | undefined,
  ): Promise<void> {
    const promptName = params?.name;
    if (promptName === "configure") {
      let text: string;
      try {
        text = await this.pairing.handleConfigure();
      } catch (err) {
        // handleConfigure throws when the pairing tunnel can't come up
        // (cloudflared missing, network unreachable, startup timeout, etc.).
        // Surface the cause as a JSON-RPC error so the agent doesn't hang
        // waiting on a response that never arrives.
        this.sendError(ErrorCode.INTERNAL, (err as Error).message, id);
        return;
      }
      this.sendResult(id, {
        messages: [
          { role: "user", content: { type: "text", text: "Show the MCP Proxy setup URL. Do not add any follow-up — do not ask me to let you know or report back." } },
          { role: "assistant", content: { type: "text", text } },
        ],
      });
      return;
    }
    if (!promptName) {
      this.sendError(ErrorCode.INVALID_PARAMS, "name is required", id);
      return;
    }
    if (!this.state.config) {
      this.sendError(ErrorCode.PROXY_NOT_CONFIGURED, "Call the `configure` tool first.", id);
      return;
    }
    const route = this.state.promptRoute.get(promptName);
    if (!route || !isServerSelected(this.state.config, route.hostId, route.serverName)) {
      this.sendError(ErrorCode.INVALID_PARAMS, `Unknown prompt: ${promptName}`, id);
      return;
    }
    const upstream: Record<string, unknown> = { name: route.originalName };
    if (params?.arguments !== undefined) upstream.arguments = params.arguments;
    const meta = (params as { _meta?: unknown } | undefined)?._meta;
    if (meta !== undefined) upstream._meta = meta;
    await this.forwarder.forwardRoutedRequest(id, route, "prompts/get", upstream);
  }

  async handleResourcesList(id: string | number): Promise<void> {
    if (!this.state.config) {
      this.sendResult(id, { resources: [] });
      return;
    }
    await this.runner.retryDiscoveryIfNeeded();
    this.sendResult(id, {
      resources: getAggregatedResources(this.state.config, this.state.hosts, this.state.resources.exactEntries()),
    });
  }

  async handleResourceTemplatesList(id: string | number): Promise<void> {
    if (!this.state.config) {
      this.sendResult(id, { resourceTemplates: [] });
      return;
    }
    await this.runner.retryDiscoveryIfNeeded();
    this.sendResult(id, {
      resourceTemplates: getAggregatedResourceTemplates(this.state.config, this.state.hosts, this.state.templateRoutes),
    });
  }

  async handleResourceMethod(
    id: string | number,
    method: string,
    params: { uri?: string } | undefined,
  ): Promise<void> {
    if (!this.state.config) {
      this.sendError(ErrorCode.PROXY_NOT_CONFIGURED, "Call the `configure` tool first.", id);
      return;
    }
    const uri = params?.uri;
    if (!uri) {
      this.sendError(ErrorCode.INVALID_PARAMS, "uri is required", id);
      return;
    }
    const parsed = unwrapResourceUri(uri);
    if (!parsed) {
      this.sendError(ErrorCode.INVALID_PARAMS, `Not a recognised resource URI: ${uri}`, id);
      return;
    }
    if (!isServerSelected(this.state.config, parsed.hostId, parsed.serverName)) {
      this.sendError(ErrorCode.INVALID_PARAMS, `No upstream server owns resource URI: ${uri}`, id);
      return;
    }
    if (!this.state.hosts.get(parsed.hostId)?.servers.has(parsed.serverName)) {
      this.sendError(ErrorCode.INVALID_PARAMS, `No upstream server owns resource URI: ${uri}`, id);
      return;
    }
    // Deliberately NO per-URI allowlist here. The host's authority model is
    // "anyone holding (tunnelUrl, authToken) can call any MCP method on any
    // child server" — there is no resource-level ACL on the host side, no
    // `selectedResources` field on PairingConfig, and no resource picker in
    // the setup UI. The proxy's selection gates (selectedServers,
    // selectedTools) constrain what the agent can reach THROUGH the proxy;
    // a credentialed attacker bypasses the proxy entirely, so adding a
    // proxy-side resource check would not raise the privilege floor. A
    // discovered-set check would also reject legitimate dynamic URIs
    // returned by resources/read on directory-style resources (see
    // forwarder.ts wrapResourceUri block) — false positives with no
    // matching security gain. handleCompletion's ref/resource branch
    // intentionally mirrors this.
    const route: ToolRoute = {
      hostId: parsed.hostId,
      serverName: parsed.serverName,
      originalName: parsed.originalUri,
    };
    await this.forwarder.forwardRoutedRequest(id, route, method, { ...(params ?? {}), uri: parsed.originalUri });
  }

  async handleLoggingSetLevel(id: string | number, params: Record<string, unknown>): Promise<void> {
    if (!this.state.config) {
      this.sendResult(id, {});
      return;
    }
    await this.forwarder.broadcastSetLogLevel(params);
    this.sendResult(id, {});
  }

  async handleCompletion(
    id: string | number,
    params: { ref?: { type?: string; name?: string; uri?: string }; argument?: unknown },
  ): Promise<void> {
    if (!this.state.config) {
      this.sendError(ErrorCode.PROXY_NOT_CONFIGURED, "Call the `configure` tool first.", id);
      return;
    }
    const ref = params.ref;
    if (!ref || typeof ref.type !== "string") {
      this.sendError(ErrorCode.INVALID_PARAMS, "ref.type is required", id);
      return;
    }

    let route: ToolRoute | null = null;
    let upstreamRef: Record<string, unknown> | null = null;

    if (ref.type === "ref/prompt") {
      if (!ref.name) {
        this.sendError(ErrorCode.INVALID_PARAMS, "ref.name is required for ref/prompt", id);
        return;
      }
      route = this.state.promptRoute.get(ref.name) ?? null;
      if (route) upstreamRef = { type: ref.type, name: route.originalName };
    } else if (ref.type === "ref/resource") {
      if (!ref.uri) {
        this.sendError(ErrorCode.INVALID_PARAMS, "ref.uri is required for ref/resource", id);
        return;
      }
      const parsed = unwrapResourceUri(ref.uri);
      // Server-level gate only — no per-URI allowlist. See the comment in
      // handleResourceMethod for the threat-model reasoning.
      if (parsed && this.state.hosts.get(parsed.hostId)?.servers.has(parsed.serverName)) {
        route = {
          hostId: parsed.hostId,
          serverName: parsed.serverName,
          originalName: parsed.originalUri,
        };
        upstreamRef = { type: ref.type, uri: parsed.originalUri };
      }
    } else {
      this.sendError(ErrorCode.INVALID_PARAMS, `Unknown ref.type: ${ref.type}`, id);
      return;
    }

    if (!route || !upstreamRef || !isServerSelected(this.state.config, route.hostId, route.serverName)) {
      this.sendError(ErrorCode.INVALID_PARAMS, `No upstream server matches ref`, id);
      return;
    }

    await this.forwarder.forwardRoutedRequest(id, route, "completion/complete", {
      ref: upstreamRef,
      ...(params.argument !== undefined ? { argument: params.argument } : {}),
    });
  }

  async handleToolDispatch(
    id: string | number,
    params: { name?: string; arguments?: Record<string, unknown>; _meta?: unknown } | undefined,
  ): Promise<void> {
    if (!params || typeof params.name !== "string") {
      this.sendError(ErrorCode.INVALID_PARAMS, "name is required", id);
      return;
    }
    const toolName = params.name;
    if (toolName === "configure") {
      let text: string;
      try {
        text = await this.pairing.handleConfigure();
      } catch (err) {
        this.sendError(ErrorCode.INTERNAL, (err as Error).message, id);
        return;
      }
      this.sendResult(id, { content: [{ type: "text", text }] });
      return;
    }
    if (!this.state.config) {
      this.sendError(ErrorCode.PROXY_NOT_CONFIGURED, "Call the `configure` tool first.", id);
      return;
    }
    const route = this.state.toolRoute.get(toolName);
    if (!route || !isServerSelected(this.state.config, route.hostId, route.serverName)) {
      this.sendError(ErrorCode.INVALID_PARAMS, `Unknown tool: ${toolName}`, id);
      return;
    }
    // selectedTools is a tool-level filter on top of the server-level gate.
    if (this.state.config.selectedTools !== undefined && !this.state.config.selectedTools.includes(toolName)) {
      this.sendError(ErrorCode.INVALID_PARAMS, `Unknown tool: ${toolName}`, id);
      return;
    }
    // Preserve `_meta` so the upstream server still sees the agent's
    // progressToken and can emit notifications/progress against it.
    const upstream: Record<string, unknown> = { name: route.originalName, arguments: params.arguments };
    if (params._meta !== undefined) upstream._meta = params._meta;
    await this.forwarder.forwardRoutedRequest(id, route, "tools/call", upstream);
  }

  async handleClientNotification(method: string, params: Record<string, unknown>): Promise<void> {
    // Sent during initServer for each upstream session — never re-broadcast.
    if (method === "notifications/initialized") return;

    if (method === "notifications/cancelled") {
      const reqId = (params as { requestId?: string | number }).requestId;
      if (reqId === undefined) return;

      // Two id namespaces. `inflight` covers requests we sent upstream
      // (tools/call, prompts/get, resources/*). `bridge` covers
      // server→client requests we forwarded out (sampling, elicitation,
      // roots/list, ping): the client sees our synthetic id and cancels
      // using that, so we translate it back to the upstream's original id
      // before forwarding. Without this branch the upstream child waited
      // the full UPSTREAM_REQUEST_TIMEOUT_MS for a response the client had
      // already abandoned.
      const route = this.state.inflight.get(reqId);
      if (route) {
        this.forwarder.forwardNotification(route, method, params).catch(() => { /* best effort */ });
        return;
      }
      const ctx = this.bridge.consumeForCancel(reqId);
      if (ctx) {
        const translated = { ...(params as Record<string, unknown>), requestId: ctx.originalId };
        this.forwarder.forwardNotification(
          { hostId: ctx.hostId, serverName: ctx.serverName, originalName: "" },
          method,
          translated,
        ).catch(() => { /* best effort */ });
      }
      return;
    }

    if (method === "notifications/roots/list_changed") {
      const targets: ToolRoute[] = [];
      for (const host of this.state.hosts.values()) {
        for (const serverName of host.servers.keys()) {
          if (!isServerSelected(this.state.config, host.config.id, serverName)) continue;
          targets.push({ hostId: host.config.id, serverName, originalName: "" });
        }
      }
      await Promise.all(targets.map((t) =>
        this.forwarder.forwardNotification(t, method, params).catch(() => { /* best effort */ })
      ));
      return;
    }

    if (method === "notifications/progress") {
      const progressToken = (params as { progressToken?: string | number }).progressToken;
      if (progressToken === undefined) return;
      const route = this.state.progressTokens.get(progressToken);
      if (!route) return;
      this.forwarder.forwardNotification(route, method, params).catch(() => { /* best effort */ });
      return;
    }
  }
}
