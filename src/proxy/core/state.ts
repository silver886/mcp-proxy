import { PACKAGE_NAME, PACKAGE_VERSION } from "../../shared/protocol.js";
import { ResourceRouter } from "../routing/router.js";
import type {
  HostConfig,
  HostState,
  PairingConfig,
  ToolRoute,
} from "./types.js";

// Mutable proxy-wide state. Holds the paired config, host map, route maps,
// and the captured client identity. All long-running components
// (DiscoveryRunner, Forwarder, RequestHandlers, PairingController) read
// and write through this single object so the proxy has exactly one source
// of truth for "what is paired right now". Mutating helpers
// (`installConfig`, `resetAfterClose`) keep the swap atomic — replacing
// every Map at once so an in-flight discovery from a prior pairing can
// detect supersession by comparing identity / generation rather than
// racing in-place mutations.
export class ProxyState {
  config: PairingConfig | null = null;
  hosts: Map<string, HostState> = new Map();
  toolRoute: Map<string, ToolRoute> = new Map();
  promptRoute: Map<string, ToolRoute> = new Map();
  resources: ResourceRouter = new ResourceRouter();
  templateRoutes: Array<{ uriTemplate: string; route: ToolRoute }> = [];

  // Client-declared capabilities + info, captured at initialize and
  // forwarded upstream when we open each MCP session. This is what makes
  // sampling / elicitation / roots actually work end-to-end: the upstream
  // server sees the real client's feature flags, not an empty object.
  // Pairing-time discovery uses these too, so the setup UI sees the same
  // capability set the runtime path will see.
  clientCapabilities: Record<string, unknown> = {};
  clientInfo: { name: string; version: string } = { name: PACKAGE_NAME, version: PACKAGE_VERSION };

  // Single-flight guard: every caller of discoverServers awaits the same
  // run. Two passes racing would double-spawn upstream sessions and let
  // their session-id rotations clobber each other's toolRoute writes.
  discoveryInflight: Promise<void> | null = null;

  // Supersession token for config/hosts. handleComplete is the sole writer
  // and bumps this on every swap; long-running readers (discovery, etc.)
  // snapshot it at the start and refuse to write back to shared state if
  // the value has moved on.
  configGeneration: number = 0;

  // requestId → route for in-flight agent→server requests. Used to route
  // notifications/cancelled to the originating session.
  inflight: Map<string | number, ToolRoute> = new Map();
  // progressToken → route. Populated when the agent issues a request whose
  // params._meta carries a progressToken; consulted on
  // notifications/progress so the proxy forwards the update to the right
  // upstream session instead of dropping or broadcasting it.
  progressTokens: Map<string | number, ToolRoute> = new Map();

  hostHeaders(host: HostConfig): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${host.authToken}`,
    };
  }

  // Atomic swap on re-pair. Bumps the generation token, then replaces the
  // host map with brand-new Maps so any in-flight discovery from a prior
  // pairing can detect it has been superseded by comparing identity /
  // token rather than racing in-place mutations. discoveryInflight is
  // nulled too, otherwise the next discoverServers() call would reuse the
  // prior pairing's promise and skip its own run.
  installConfig(config: PairingConfig, hosts: HostConfig[]): void {
    this.configGeneration++;
    this.config = config;
    const newHosts = new Map<string, HostState>();
    for (const h of hosts) {
      newHosts.set(h.id, {
        config: h,
        servers: new Map(),
        sseControllers: new Map(),
        listed: false,
        pendingServers: new Set(),
      });
    }
    this.hosts = newHosts;
    this.toolRoute = new Map();
    this.promptRoute = new Map();
    this.resources.clear();
    this.templateRoutes = [];
    this.discoveryInflight = null;
  }

  // Drop every host/route after sessions have been closed. Called from
  // PairingController.closeAllSessions on its way out of an old pairing.
  resetAfterClose(): void {
    this.hosts = new Map();
    this.toolRoute = new Map();
    this.promptRoute = new Map();
    this.resources.clear();
    this.templateRoutes = [];
  }
}
