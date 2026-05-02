import { createParser, type EventSourceParser } from "eventsource-parser";
import { SSE_BACKOFF_INITIAL_MS, SSE_BACKOFF_MAX_MS, SSE_CONNECT_TIMEOUT_MS } from "../core/constants.js";
import type { HostState } from "../core/types.js";
import { wrapResourceUri } from "../routing/uri.js";

function sleepCancellable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolveP) => {
    if (signal.aborted) return resolveP();
    const timer = setTimeout(resolveP, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolveP();
    }, { once: true });
  });
}

// Callbacks the SSE loop invokes on the orchestrator. Kept narrow so
// sse.ts doesn't reach into ProxyServer internals — every cross-module
// interaction is one of these hooks.
export interface SseCallbacks {
  // Identity check the caller does on every retry. Returns false if a
  // re-pair has installed a new HostState under the same id; the loop then
  // exits without reconnecting.
  isCurrent: (host: HostState, name: string, sessionId: string) => boolean;
  // SSE frames map to one of three things:
  //   - id + method: server-initiated request, bridge to the agent
  //   - method, no id: notification, forward (with per-method side-effects)
  //   - other: ignored
  onUpstreamRequest: (host: HostState, name: string, msg: { id: string | number; method: string; params?: unknown }) => void;
  onListChanged: (host: HostState, name: string, kind: "tools" | "prompts" | "resources") => Promise<void>;
  onNotification: (msg: unknown) => void;
}

export class SseReader {
  constructor(private readonly cb: SseCallbacks) {}

  // Owner-side entry: ensure exactly one loop is active per (host, server)
  // session id. Aborting the previous controller torpedoes a stale loop
  // before its retry chain reconnects to a session id that's been rotated.
  start(host: HostState, name: string, sessionId: string): void {
    const prev = host.sseControllers.get(name);
    if (prev) prev.abort();
    const ctrl = new AbortController();
    host.sseControllers.set(name, ctrl);
    void this.loop(host, name, sessionId, ctrl).finally(() => {
      if (host.sseControllers.get(name) === ctrl) host.sseControllers.delete(name);
    });
  }

  private async loop(host: HostState, name: string, sessionId: string, ctrl: AbortController): Promise<void> {
    let backoff = SSE_BACKOFF_INITIAL_MS;
    while (!ctrl.signal.aborted) {
      if (!this.cb.isCurrent(host, name, sessionId)) return;

      const url = `${host.config.tunnelUrl}/servers/${name}`;
      // Connect-phase abort wiring: a separate inner controller fires when
      // EITHER the lifecycle signal aborts OR the connect budget elapses.
      // We can't pass `AbortSignal.any([ctrl.signal, AbortSignal.timeout(N)])`
      // straight to fetch(), because the same signal is then attached to
      // the response body — meaning a 15 s timeout would also kill a
      // healthy long-lived stream after 15 s. Instead we tear down the
      // timer / lifecycle relay the moment fetch() resolves, leaving the
      // body cancellation path in consume() to use ctrl.signal directly.
      const connectCtrl = new AbortController();
      const lifecycleRelay = (): void => connectCtrl.abort();
      ctrl.signal.addEventListener("abort", lifecycleRelay, { once: true });
      const connectTimer = setTimeout(() => connectCtrl.abort(), SSE_CONNECT_TIMEOUT_MS);
      try {
        const resp = await fetch(url, {
          method: "GET",
          headers: {
            Accept: "text/event-stream",
            Authorization: `Bearer ${host.config.authToken}`,
            "Mcp-Session-Id": sessionId,
          },
          signal: connectCtrl.signal,
        });
        clearTimeout(connectTimer);
        ctrl.signal.removeEventListener("abort", lifecycleRelay);
        if (resp.ok && resp.body) {
          backoff = SSE_BACKOFF_INITIAL_MS;
          await this.consume(host, name, resp.body, ctrl.signal);
        } else if (resp.status === 401 || resp.status === 404) {
          // Auth changed or session vanished — no point retrying this loop.
          // The next upstream POST will rotate the session id and start a
          // fresh loop via the orchestrator's captureSessionId.
          return;
        }
      } catch {
        if (ctrl.signal.aborted) return;
        // Transient — fall through to backoff.
      } finally {
        clearTimeout(connectTimer);
        ctrl.signal.removeEventListener("abort", lifecycleRelay);
      }
      if (ctrl.signal.aborted) return;
      await sleepCancellable(backoff, ctrl.signal);
      backoff = Math.min(backoff * 2, SSE_BACKOFF_MAX_MS);
    }
  }

  private async consume(
    host: HostState,
    name: string,
    body: ReadableStream<Uint8Array>,
    signal: AbortSignal,
  ): Promise<void> {
    const reader = body.getReader();
    const onAbort = (): void => { reader.cancel().catch(() => { /* already torn down */ }); };
    signal.addEventListener("abort", onAbort, { once: true });
    const decoder = new TextDecoder();
    // Hand the byte→event split to eventsource-parser. It correctly handles
    // CRLF, BOM, retry: directives, comment lines, and event types — none
    // of which we'd otherwise be reasoning about ourselves. Our only job
    // here is to JSON-parse `data` and dispatch.
    const parser: EventSourceParser = createParser({
      onEvent: (evt) => this.dispatchData(host, name, evt.data),
    });
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        parser.feed(decoder.decode(value, { stream: true }));
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  private dispatchData(host: HostState, name: string, payload: string): void {
    let msg: { jsonrpc?: string; id?: unknown; method?: string; params?: unknown };
    try {
      msg = JSON.parse(payload);
    } catch {
      return;
    }
    if (msg.jsonrpc !== "2.0") return;

    const hasMethod = typeof msg.method === "string";
    const hasId = msg.id !== undefined && msg.id !== null;

    // Server-initiated request: bridge to the client and let the orchestrator
    // remember enough to route the response back to this session.
    if (hasMethod && hasId) {
      this.cb.onUpstreamRequest(host, name, msg as { id: string | number; method: string; params?: unknown });
      return;
    }

    // Symmetric with server.ts: an upstream "request" with id:null can't
    // be answered (the bridge keys responses by id), so drop rather than
    // forwarding it to the agent as if it were a notification — that
    // would silently re-cast a request the upstream expects a response to.
    if (hasMethod && msg.id === null) return;

    if (!hasMethod) return; // stray response — not expected on this stream

    // Notifications: list_changed events trigger a cache refresh BEFORE
    // forwarding so the agent's follow-up list call sees fresh data.
    // resources/updated carries the upstream's raw URI; we wrap it in the
    // proxy's `mcp+host://` envelope so the agent sees the same namespaced
    // URI it subscribed under. Other notifications (logging, progress,
    // cancelled, roots/list_changed) don't carry resource URIs.
    if (msg.method === "notifications/tools/list_changed") {
      this.cb.onListChanged(host, name, "tools").catch(() => { /* best effort */ })
        .finally(() => this.cb.onNotification(msg));
      return;
    }
    if (msg.method === "notifications/prompts/list_changed") {
      this.cb.onListChanged(host, name, "prompts").catch(() => { /* best effort */ })
        .finally(() => this.cb.onNotification(msg));
      return;
    }
    if (msg.method === "notifications/resources/list_changed") {
      this.cb.onListChanged(host, name, "resources").catch(() => { /* best effort */ })
        .finally(() => this.cb.onNotification(msg));
      return;
    }
    if (msg.method === "notifications/resources/updated") {
      const params = (msg.params ?? {}) as { uri?: unknown };
      if (typeof params.uri === "string") {
        const wrapped = wrapResourceUri(host.config.id, name, params.uri);
        this.cb.onNotification({ ...msg, params: { ...params, uri: wrapped } });
        return;
      }
    }
    this.cb.onNotification(msg);
  }
}
