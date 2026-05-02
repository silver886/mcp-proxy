import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer, readBody } from "../../shared/protocol.js";
import { PAIRING_HEADERS_TIMEOUT_MS, PAIRING_REQUEST_TIMEOUT_MS } from "../core/constants.js";
import type { PairingConfig, Prompt, Resource, ResourceTemplate, Tool } from "../core/types.js";
import { SETUP_CSS, SETUP_HTML, SETUP_JS, SETUP_PAGE_CSS } from "./static-assets.js";

// Pairing-time discovery is proxy-mediated: the browser POSTs the host
// credentials it just collected, the proxy runs the same MCP handshake it
// would at runtime (with the real client's captured capabilities/clientInfo),
// and returns the discovered capabilities. This keeps a single source of
// truth for discovery — what the setup UI sees is exactly what the proxy
// will see at runtime, including capability-gated upstreams that respond
// to clientCapabilities/clientInfo.

export interface ListServersRequest {
  tunnelUrl: string;
  authToken: string;
}

export interface ListServersResult {
  ok: boolean;
  servers?: string[];
  error?: string;
  // Status code the browser should display for unauthorized hosts so the
  // existing "invalid auth token" message keeps working.
  status?: number;
}

export interface DiscoverServerRequest {
  tunnelUrl: string;
  authToken: string;
  serverName: string;
}

export interface DiscoverServerResult {
  ok: boolean;
  // Present on success, including when caps had partial failures.
  tools?: Tool[];
  prompts?: Prompt[];
  resources?: Resource[];
  resourceTemplates?: ResourceTemplate[];
  // Per-capability error map. Mirrors the runtime proxy's pending* flags —
  // tools/list always succeeds for an `ok` result; prompts/resources/
  // templates may individually fail without taking the server down.
  capErrors?: { prompts?: string; resources?: string; resourceTemplates?: string };
  error?: string;
  // Status code the browser should display for unauthorized hosts so the
  // existing "invalid auth token" message keeps working — same shape as
  // ListServersResult. Falls back to 200 / 502 when omitted.
  status?: number;
}

// `afterFlush` runs only after /pair/complete's response body has actually
// drained to the client. Used so the pairing tunnel teardown waits for the
// success body to reach the browser instead of racing it on a fixed timer.
export type CompleteResult =
  | { ok: true; afterFlush?: () => void }
  | { ok: false; error: string };

// `current` is populated when the proxy is already paired. It lets the
// setup page pre-fill the host inputs and prior selections instead of
// asking the user to retype everything during a reconfigure. Omitted on
// first-time setup.
export interface PairingHandlers {
  listServers: (req: ListServersRequest) => Promise<ListServersResult>;
  discover: (req: DiscoverServerRequest) => Promise<DiscoverServerResult>;
  complete: (cfg: PairingConfig) => Promise<CompleteResult>;
  info: () => {
    name: string;
    version: string;
    current?: {
      hosts: Array<{ id: string; tunnelUrl: string; authToken: string; label?: string }>;
      selectedServers?: string[];
      selectedTools?: string[];
    };
  };
}

export class PairingHttpServer {
  private server: Server | null = null;
  private bearerExpected: Buffer;

  constructor(
    private readonly bearer: string,
    private readonly handlers: PairingHandlers,
  ) {
    this.bearerExpected = Buffer.from(`Bearer ${bearer}`);
  }

  listen(): Promise<number> {
    return new Promise((resolveP, rejectP) => {
      const srv = createServer((req, res) => this.handle(req, res));
      // Bound the header + body phases so a slow upload can't drag past
      // PAIRING_WINDOW_MS. Node defaults (60s / 5min) are too generous for
      // small JSON pairing payloads.
      srv.headersTimeout = PAIRING_HEADERS_TIMEOUT_MS;
      srv.requestTimeout = PAIRING_REQUEST_TIMEOUT_MS;
      srv.once("error", rejectP);
      srv.listen(0, "127.0.0.1", () => {
        const addr = srv.address();
        if (typeof addr !== "object" || !addr) {
          rejectP(new Error("Could not bind pairing HTTP server"));
          return;
        }
        this.server = srv;
        resolveP(addr.port);
      });
    });
  }

  close(): void {
    if (!this.server) return;
    // server.close() alone only refuses new connections; idle keep-alive
    // sockets and any in-flight request body would otherwise outlive the
    // pairing window. closeAllConnections() (Node ≥18.2) hard-drops them
    // so teardown is bounded by the window, not by the slowest client.
    this.server.closeAllConnections();
    this.server.close();
    this.server = null;
  }

  private authorized(req: IncomingMessage): boolean {
    const got = Buffer.from(req.headers.authorization ?? "");
    if (got.length !== this.bearerExpected.length) return false;
    return timingSafeEqual(got, this.bearerExpected);
  }

  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  }

  private sendStatic(res: ServerResponse, contentType: string, body: Buffer): void {
    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
      "Content-Length": String(body.length),
    });
    res.end(body);
  }

  // Read the request body and JSON.parse it. On failure, write a 400 to the
  // response and return null so the handler can early-return without a
  // separate try/catch ladder. readBody itself is awaited outside so a
  // BodyTooLargeError propagates up to createServer (→ 413) instead of
  // being misreported as "Invalid JSON".
  private async readJson<T>(req: IncomingMessage, res: ServerResponse): Promise<T | null> {
    const raw = await readBody(req);
    try {
      return JSON.parse(raw) as T;
    } catch {
      this.sendJson(res, 400, { error: "Invalid JSON" });
      return null;
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");

    // Static routes are public — they're the setup page itself, served on
    // the same origin as the API so no CORS is involved. The bearer gate
    // only matters for /pair/* endpoints (which the page calls with the
    // token from its URL fragment).
    if (req.method === "GET") {
      if (url.pathname === "/" || url.pathname === "/setup.html") {
        this.sendStatic(res, "text/html; charset=utf-8", SETUP_HTML);
        return;
      }
      if (url.pathname === "/style.css") {
        this.sendStatic(res, "text/css; charset=utf-8", SETUP_CSS);
        return;
      }
      if (url.pathname === "/setup.css") {
        this.sendStatic(res, "text/css; charset=utf-8", SETUP_PAGE_CSS);
        return;
      }
      if (url.pathname === "/setup.js") {
        this.sendStatic(res, "application/javascript; charset=utf-8", SETUP_JS);
        return;
      }
    }

    if (!this.authorized(req)) {
      this.sendJson(res, 401, { error: "Unauthorized" });
      return;
    }

    if (req.method === "GET" && url.pathname === "/pair/info") {
      this.sendJson(res, 200, this.handlers.info());
      return;
    }

    if (req.method === "POST" && url.pathname === "/pair/list-servers") {
      const parsed = await this.readJson<ListServersRequest>(req, res);
      if (!parsed) return;
      try {
        const result = await this.handlers.listServers(parsed);
        const status = result.status ?? (result.ok ? 200 : 502);
        this.sendJson(res, status, result);
      } catch (err) {
        this.sendJson(res, 502, { ok: false, error: `Upstream unreachable: ${(err as Error).message}` });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/pair/discover") {
      const parsed = await this.readJson<DiscoverServerRequest>(req, res);
      if (!parsed) return;
      try {
        const result = await this.handlers.discover(parsed);
        const status = result.status ?? (result.ok ? 200 : 502);
        this.sendJson(res, status, result);
      } catch (err) {
        this.sendJson(res, 502, { ok: false, error: `Upstream unreachable: ${(err as Error).message}` });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/pair/complete") {
      const cfg = await this.readJson<PairingConfig>(req, res);
      if (!cfg) return;
      const out = await this.handlers.complete(cfg);
      if (!out.ok) {
        this.sendJson(res, 400, { error: out.error });
        return;
      }
      // Only run afterFlush once the response body has actually drained.
      // The pairing tunnel teardown rides this callback so a slow client
      // (mobile data, congested tunnel) doesn't lose the success body to
      // a tunnel that closed on a fixed timer.
      const afterFlush = out.afterFlush;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }), () => {
        if (afterFlush) afterFlush();
      });
      return;
    }

    this.sendJson(res, 404, { error: "Not found" });
  }
}
