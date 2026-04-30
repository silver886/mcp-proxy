import { type ChildProcess, spawn } from "node:child_process";
import { resolve } from "node:path";
import { LineBuffer } from "../../shared/protocol.js";
import { TUNNEL_STARTUP_TIMEOUT_MS } from "../core/constants.js";

// Owns the cloudflared child via wrapper.js. The wrapper guarantees that
// cloudflared cannot outlive the proxy: it watches stdin EOF and kills the
// child on either side dying, with 0ms detection latency on every supported
// OS. From the proxy's side we only need to start, await the URL, and stop.
export class PairingTunnel {
  private wrapper: ChildProcess | null = null;
  private url: string | null = null;
  // Most recent cloudflared error, captured from wrapper "ERR" lines. Lets
  // us include the actual cause in any rejection / unexpected-exit log so
  // the user sees something more useful than "exited before becoming
  // ready".
  private lastError: string | null = null;
  private waiters: Array<{
    resolve: (url: string) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  // Fired only when the wrapper dies AFTER the URL was advertised — i.e.,
  // a runtime crash, not a startup failure. Pre-ready exits already reject
  // the start() promise, so the caller learns about those synchronously.
  // The reason string carries whatever cloudflared error we last saw, so
  // the caller can log a meaningful line (e.g., "tunnel: connection
  // refused") instead of a generic "exited unexpectedly".
  private onUnexpectedExit: ((reason: string) => void) | null = null;

  start(port: number, onUnexpectedExit?: (reason: string) => void): Promise<string> {
    if (this.wrapper) return this.urlReady();
    this.onUnexpectedExit = onUnexpectedExit ?? null;

    // dist/proxy/pairing/tunnel.js → ../../wrapper.js. Two `..` segments
    // because tunnel lives two directories below dist/, not one — keep this
    // aligned with the emitted layout if the file ever moves again.
    const wrapperPath = resolve(__dirname, "..", "..", "wrapper.js");
    const child = spawn(process.execPath, [wrapperPath, String(port)], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    this.wrapper = child;

    const buf = new LineBuffer();
    child.stdout!.on("data", (chunk: Buffer) => {
      for (const line of buf.push(chunk.toString("utf-8"))) {
        if (line.startsWith("URL ")) this.handleUrl(line.slice(4).trim());
        else if (line.startsWith("ERR ")) this.lastError = line.slice(4).trim();
      }
    });

    child.on("exit", () => this.handleExit());
    child.on("error", (err) => {
      // The spawn itself failed (binary missing, EPERM, etc.) — capture as
      // the cause so the rejection isn't blank.
      if (!this.lastError) this.lastError = err.message;
      this.failWaiters(new Error(`Pairing tunnel wrapper failed: ${err.message}`));
    });

    return this.urlReady();
  }

  private handleUrl(url: string): void {
    this.url = url;
    for (const w of this.waiters) {
      clearTimeout(w.timer);
      w.resolve(url);
    }
    this.waiters = [];
  }

  private handleExit(): void {
    const wasReady = this.url !== null;
    const reason = this.lastError
      ? `Pairing tunnel exited: ${this.lastError}`
      : "Pairing tunnel exited before becoming ready";
    this.failWaiters(new Error(reason));
    this.wrapper = null;
    this.url = null;
    if (wasReady) {
      const cb = this.onUnexpectedExit;
      this.onUnexpectedExit = null;
      cb?.(this.lastError ?? "exit without error message");
    }
    this.lastError = null;
  }

  private failWaiters(err: Error): void {
    for (const w of this.waiters) {
      clearTimeout(w.timer);
      w.reject(err);
    }
    this.waiters = [];
  }

  private urlReady(): Promise<string> {
    if (this.url) return Promise.resolve(this.url);
    return new Promise<string>((resolveP, rejectP) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.timer !== timer);
        const cause = this.lastError ? ` (last error: ${this.lastError})` : "";
        rejectP(new Error(`Pairing tunnel startup timed out after ${TUNNEL_STARTUP_TIMEOUT_MS / 1000}s${cause}`));
      }, TUNNEL_STARTUP_TIMEOUT_MS);
      this.waiters.push({ resolve: resolveP, reject: rejectP, timer });
    });
  }

  stop(): void {
    const child = this.wrapper;
    if (!child) return;
    this.wrapper = null;
    this.url = null;
    this.lastError = null;
    // Caller-initiated stop; suppress the unexpected-exit callback so a
    // teardownPairing() chain doesn't reenter via the exit handler.
    this.onUnexpectedExit = null;
    try { child.stdin?.write("stop\n"); } catch { /* already closed */ }
    try { child.stdin?.end(); } catch { /* already closed */ }
    // Hard-kill fallback if the wrapper does not exit promptly.
    setTimeout(() => {
      if (!child.killed) {
        try { child.kill("SIGKILL"); } catch { /* already dead */ }
      }
    }, 5000).unref();
  }
}
