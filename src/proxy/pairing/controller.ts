import { randomBytes } from "node:crypto";
import { PACKAGE_NAME, PACKAGE_VERSION, validateServerName } from "../../shared/protocol.js";
import { PAIRING_WINDOW_MS } from "../core/constants.js";
import type { ProxyState } from "../core/state.js";
import type { PairingConfig } from "../core/types.js";
import {
  deleteSession,
  DiscoveryError,
  discoverServerCapabilities,
  listHostServers,
} from "../discovery/client.js";
import type { DiscoveryRunner } from "../discovery/runner.js";
import type { UpstreamBridge } from "../runtime/upstream-bridge.js";
import { validatePairingConfig } from "./config.js";
import {
  type CompleteResult,
  type DiscoverServerRequest,
  type DiscoverServerResult,
  type ListServersRequest,
  type ListServersResult,
  PairingHttpServer,
} from "./http.js";
import { PairingTunnel } from "./tunnel.js";
import { allowedTunnelUrl } from "./validation.js";

// Owns the pairing flow end-to-end: brings up the temporary HTTP server +
// cloudflared tunnel, serves the setup page, mediates discovery on the
// browser's behalf (so pairing-time and runtime use the same client
// capabilities/clientInfo), validates the submitted config, and atomically
// installs it into ProxyState. Also closes any prior pairing's sessions
// before the next pairing's discovery starts.
export class PairingController {
  private pairing: {
    tunnel: PairingTunnel;
    http: PairingHttpServer;
    setupUrl: string;
    expiryTimer: ReturnType<typeof setTimeout>;
  } | null = null;

  constructor(
    private readonly state: ProxyState,
    private readonly runner: DiscoveryRunner,
    private readonly bridge: UpstreamBridge,
    private readonly log: (line: string) => void,
    private readonly sendNotification: (method: string) => void,
  ) {}

  async handleConfigure(): Promise<string> {
    this.teardownPairing();

    const bearer = randomBytes(32).toString("base64url");
    const http = new PairingHttpServer(bearer, {
      listServers: (req) => this.handleListServers(req),
      discover: (req) => this.handleDiscover(req),
      complete: (cfg) => this.handleComplete(cfg),
      // Surface the existing PairingConfig so a reconfigure flow can
      // pre-fill the setup page. The endpoint is already gated by the
      // pairing bearer token, so disclosing the auth tokens here is
      // bounded by the same trust boundary as a fresh pairing.
      info: () => ({
        name: PACKAGE_NAME,
        version: PACKAGE_VERSION,
        ...(this.state.config ? {
          current: {
            hosts: this.state.config.hosts.map((h) => ({
              id: h.id,
              tunnelUrl: h.tunnelUrl,
              authToken: h.authToken,
              ...(h.label ? { label: h.label } : {}),
            })),
            ...(this.state.config.selectedServers ? { selectedServers: [...this.state.config.selectedServers] } : {}),
            ...(this.state.config.selectedTools ? { selectedTools: [...this.state.config.selectedTools] } : {}),
          },
        } : {}),
      }),
    });

    const port = await http.listen();

    const tunnel = new PairingTunnel();
    let tunnelUrl: string;
    try {
      tunnelUrl = await tunnel.start(port, (reason) => {
        // cloudflared/wrapper died after advertising a URL. The setup link
        // we already returned points at a dead tunnel; tear pairing down so
        // a subsequent `configure` call can re-bootstrap instead of waiting
        // out PAIRING_WINDOW_MS. The reason carries whatever cloudflared
        // last reported so the operator knows whether to retry or
        // investigate.
        this.log(`  Pairing tunnel exited unexpectedly (${reason}); setup URL invalidated`);
        this.teardownPairing();
      });
    } catch (err) {
      http.close();
      tunnel.stop();
      throw new Error(`Failed to start pairing tunnel: ${(err as Error).message}`);
    }

    // Setup page is served from the pairing tunnel itself — same origin as
    // the /pair/* endpoints, so no CORS is involved. Token rides in the
    // URL fragment so it never leaves the browser as Referer / origin log.
    const setupUrl = `${tunnelUrl.replace(/\/+$/, "")}/#token=${bearer}`;

    const expiryTimer = setTimeout(() => {
      this.log(`  Pairing window expired (${PAIRING_WINDOW_MS / 1000}s); tunnel closed`);
      this.teardownPairing();
    }, PAIRING_WINDOW_MS);
    expiryTimer.unref();

    this.pairing = { tunnel, http, setupUrl, expiryTimer };

    this.log(`\n  Configure at: ${setupUrl}\n`);
    return `Open this URL in your browser to set up the MCP Proxy:\n\n${setupUrl}\n\nThe proxy will connect automatically once setup is complete.`;
  }

  teardownPairing(): void {
    if (!this.pairing) return;
    const { tunnel, http, expiryTimer } = this.pairing;
    this.pairing = null;
    clearTimeout(expiryTimer);
    try { http.close(); } catch { /* already closed */ }
    try { tunnel.stop(); } catch { /* already stopped */ }
  }

  // Validate the host credentials the browser submitted on a /pair/* call.
  // Single source of truth so list-servers and discover share the same
  // gating rules — without this the two endpoints could disagree about
  // what counts as a valid tunnel URL or what the canonicalised origin is.
  private validateHostCreds(
    req: { tunnelUrl?: string; authToken?: string },
  ): { ok: true; origin: string; headers: Record<string, string> } | { ok: false; error: string } {
    if (!req.tunnelUrl || !req.authToken) {
      return { ok: false, error: "tunnelUrl and authToken are required" };
    }
    const url = allowedTunnelUrl(req.tunnelUrl);
    if (!url) {
      return {
        ok: false,
        error:
          "tunnelUrl is not on the allowlist. Use an https URL on a Cloudflare tunnel domain (.trycloudflare.com / .cfargotunnel.com), or extend MCP_TUNNEL_HOST_SUFFIXES / MCP_ALLOW_LOCAL on the proxy environment.",
      };
    }
    return {
      ok: true,
      origin: url.origin,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${req.authToken}`,
      },
    };
  }

  // GET / on the host agent — list of advertised server names. Surfaces
  // an explicit 401 status to the browser so the setup page can show
  // "invalid auth token" rather than a generic upstream error.
  private async handleListServers(req: ListServersRequest): Promise<ListServersResult> {
    const v = this.validateHostCreds(req);
    if (!v.ok) return { ok: false, error: v.error, status: 400 };
    try {
      const servers = await listHostServers(v.origin, v.headers);
      return { ok: true, servers };
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.startsWith("list HTTP 401")) {
        return { ok: false, error: "invalid auth token", status: 401 };
      }
      return { ok: false, error: msg };
    }
  }

  // Per-server discovery on behalf of the setup page. Uses the captured
  // clientCapabilities/clientInfo from the live MCP session — same values
  // the runtime path will use — so capability-gated upstreams cannot look
  // empty here and rich at runtime (or vice versa). Always closes the
  // host-side session afterwards: pairing is read-only inspection, not
  // an active session.
  private async handleDiscover(req: DiscoverServerRequest): Promise<DiscoverServerResult> {
    // Local validation failures must surface as HTTP 400, matching
    // handleListServers — without `status` the http layer defaults to 502,
    // which mislabels caller input errors as upstream failures and makes
    // the two pairing endpoints disagree about the same class of problem.
    const v = this.validateHostCreds(req);
    if (!v.ok) return { ok: false, error: v.error, status: 400 };
    if (!req.serverName) return { ok: false, error: "serverName is required", status: 400 };
    const reason = validateServerName(req.serverName);
    if (reason) return { ok: false, error: `serverName ${reason}`, status: 400 };

    const targetUrl = `${v.origin}/servers/${req.serverName}`;
    let sessionId: string | undefined;
    try {
      const result = await discoverServerCapabilities(
        targetUrl,
        v.headers,
        req.serverName,
        this.state.clientCapabilities,
        this.state.clientInfo,
      );
      sessionId = result.sessionId;
      const out: DiscoverServerResult = {
        ok: true,
        tools: result.tools,
        prompts: result.prompts,
        resources: result.resources,
        resourceTemplates: result.resourceTemplates,
      };
      if (Object.keys(result.capErrors).length > 0) out.capErrors = result.capErrors;
      return out;
    } catch (err) {
      const dErr = err as DiscoveryError;
      sessionId = dErr.sessionId;
      // Propagate auth failures the same way list-servers does so the UI
      // can show "invalid auth token" instead of a generic 502. Discovery
      // errors come from initialize / tools/list / prompts/list / etc and
      // all spell their HTTP status as "<method> HTTP <status>: …".
      if (/HTTP 401\b/.test(dErr.message ?? "")) {
        return { ok: false, error: "invalid auth token", status: 401 };
      }
      return { ok: false, error: dErr.message };
    } finally {
      if (sessionId) {
        void deleteSession(targetUrl, { ...v.headers, "Mcp-Session-Id": sessionId });
      }
    }
  }

  private async handleComplete(cfg: PairingConfig): Promise<CompleteResult> {
    const validation = validatePairingConfig(cfg);
    if (!validation.ok) return { ok: false, error: validation.error };

    // Snapshot the active pairing before tearing it down so we can roll
    // back if the new pairing fails to land any server. closeAllSessions
    // is unconditional, so without this snapshot a bad submit would leave
    // the proxy paired-but-empty with no path back to the prior config.
    const previousConfig = this.state.config;
    const previousHosts = previousConfig?.hosts ?? null;

    await this.closeAllSessions();

    this.state.installConfig(
      {
        hosts: validation.hosts,
        selectedServers: cfg.selectedServers,
        selectedTools: cfg.selectedTools,
        sealed: true,
      },
      validation.hosts,
    );

    // Wait for discovery to settle before responding so the operator
    // gets a real success/failure signal instead of a cheerful ok on a
    // paired-but-empty proxy. Discovery is bounded by per-host fetch
    // timeouts; the browser is fine to wait that long.
    await this.runner.discoverServers();

    // Strict completion check — same rule the UI enforces at submit:
    // every selectedServers entry must have ended up in state.hosts after
    // discovery, otherwise we'd persist a partially broken pairing that
    // the browser path would have rejected. Without this, a direct caller
    // of the bearer-auth endpoint (UI gates client-side, but /pair/complete
    // is callable directly) ends up paired with missing servers and the
    // proxy reports `ok: true`. Mirror it server-side so behaviour is the
    // same whichever path lands the config.
    //
    // selectedServers is optional in PairingConfig (allow-all). When it's
    // omitted we can't enumerate which servers were "expected" — fall back
    // to "every advertised host must land at least one server".
    const missing: string[] = [];
    if (cfg.selectedServers) {
      // Server names may contain `__`, so prefix-match on the FIRST `__`
      // — same parsing rule used in validatePairingConfig.
      for (const key of cfg.selectedServers) {
        const sep = key.indexOf("__");
        if (sep <= 0) continue; // shape already gated by validatePairingConfig
        const hostId = key.slice(0, sep);
        const serverName = key.slice(sep + 2);
        if (!this.state.hosts.get(hostId)?.servers.has(serverName)) {
          missing.push(key);
        }
      }
    } else {
      for (const host of this.state.hosts.values()) {
        if (host.servers.size === 0) missing.push(`${host.config.id} (no servers)`);
      }
    }

    if (missing.length > 0) {
      // Cap the detail string so a wildly broken submit doesn't produce a
      // multi-kilobyte error body; the operator only needs a few names to
      // know which host to investigate.
      const detail = missing.length > 5
        ? `${missing.slice(0, 5).join(", ")}, and ${missing.length - 5} more`
        : missing.join(", ");
      await this.closeAllSessions();
      if (previousConfig && previousHosts) {
        this.log(`  New pairing missing servers (${detail}); restoring previous pairing`);
        this.state.installConfig(previousConfig, previousHosts);
        await this.runner.discoverServers();
        return {
          ok: false,
          error: `Discovery did not complete for: ${detail}. The previous pairing has been restored — verify host reachability and retry.`,
        };
      }
      // First-time pairing missed servers: drop back to unconfigured
      // (closeAllSessions cleared hosts/routes already; null the config
      // so the next configure call starts fresh).
      this.log(`  New pairing missing servers (${detail}) and no prior config to restore; reverting to unconfigured`);
      this.state.config = null;
      return {
        ok: false,
        error: `Discovery did not complete for: ${detail}. Verify host reachability and retry.`,
      };
    }

    const summary = validation.hosts.map((h) => `${h.id}=${h.tunnelUrl}`).join(", ");
    this.log(`  Paired! hosts: ${summary}`);

    // Discovery already populated the aggregated lists. Notify the agent
    // so it re-fetches tools/prompts/resources instead of trusting any
    // cached empty lists from before pairing.
    this.sendNotification("notifications/tools/list_changed");
    this.sendNotification("notifications/prompts/list_changed");
    this.sendNotification("notifications/resources/list_changed");

    // Defer pairing teardown until /pair/complete's response body has
    // actually drained to the client — a fixed timer races slow clients
    // (mobile data, congested tunnel) and they see a dropped connection
    // on a successful pair.
    return { ok: true, afterFlush: () => this.teardownPairing() };
  }

  async closeAllSessions(): Promise<void> {
    // Tear down SSE listeners first so loops don't reconnect after DELETE.
    for (const host of this.state.hosts.values()) {
      for (const ctrl of host.sseControllers.values()) ctrl.abort();
      host.sseControllers.clear();
    }
    this.state.inflight.clear();
    this.state.progressTokens.clear();
    // Drain bridged requests BEFORE the DELETEs below so each upstream
    // child gets a JSON-RPC error answer. The DELETE will then reap the
    // session, but the upstream side has already stopped waiting.
    await this.bridge.clear(this.state.hosts);

    const closes: Promise<unknown>[] = [];
    for (const host of this.state.hosts.values()) {
      for (const [serverName, state] of host.servers) {
        if (!state.sessionId) continue;
        const headers = { ...this.state.hostHeaders(host.config), "Mcp-Session-Id": state.sessionId };
        closes.push(deleteSession(`${host.config.tunnelUrl}/servers/${serverName}`, headers));
      }
    }
    await Promise.allSettled(closes);

    this.state.resetAfterClose();
  }
}
