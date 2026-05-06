import { type ChildProcess, spawn } from "node:child_process";
import treeKill from "tree-kill";
import { ErrorCode, jsonRpcError, LineBuffer, type ServerConfig } from "../shared/protocol.js";
import { MAX_QUEUED_NOTIFICATIONS } from "./constants.js";

// One McpSession owns a single MCP server child process and matches its
// JSON-RPC stdout responses to outstanding requests. Notifications (no id)
// are queued for the SSE poller in HostAgent. Lifetime is tied to the host's
// session map: HostAgent.sweepIdleSessions reaps after SESSION_IDLE_TIMEOUT_MS,
// shutdown destroys all entries, and stdin/process errors fail every pending
// request so callers don't sit through their per-request timeout.
export class McpSession {
  private process: ChildProcess;
  private stdoutBuffer = new LineBuffer();
  private pending = new Map<string | number, { resolve: (msg: string) => void; timer: ReturnType<typeof setTimeout> }>();
  private notifications: string[] = [];
  private notificationsDropped = 0;
  // Late responses to already-timed-out requests: counted separately so the
  // drain log can attribute "child answered after we gave up" distinctly
  // from notification-queue overflow.
  private orphansDropped = 0;
  private destroyed = false;
  lastActivity = Date.now();

  constructor(
    private name: string,
    config: ServerConfig,
    private timeout: number,
  ) {
    console.log(`[${name}] Spawning: ${config.command} ${config.args.join(" ")}`);

    this.process = spawn(config.command, config.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...config.env },
      shell: config.shell ?? false,
    });

    this.process.stdout!.on("data", (chunk: Buffer) => {
      const lines = this.stdoutBuffer.push(chunk.toString("utf-8"));
      for (const line of lines) {
        this.handleLine(line);
      }
    });

    this.process.stderr!.on("data", (chunk: Buffer) => {
      console.error(`[${name}] stderr: ${chunk.toString("utf-8").trimEnd()}`);
    });

    this.process.on("exit", (code) => {
      console.log(`[${name}] Process exited (code=${code})`);
      this.destroyed = true;
      this.failPending(ErrorCode.PROCESS_EXITED, `code=${code}`);
    });

    this.process.on("error", (err) => {
      console.error(`[${name}] Process error: ${err.message}`);
      this.destroyed = true;
      // Spawn failures (ENOENT, EACCES, …) emit 'error' and may emit
      // 'exit' only later or not at all. Without failing pending here,
      // any in-flight request blocks until its per-request timeout.
      this.failPending(ErrorCode.PROCESS_NOT_RUNNING, err.message);
    });

    // EPIPE / write-after-close on the child's stdin shows up as an 'error'
    // on the stream itself, distinct from the process error.
    this.process.stdin?.on("error", (err) => {
      console.error(`[${name}] stdin error: ${err.message}`);
      this.destroyed = true;
      this.failPending(ErrorCode.PROCESS_NOT_RUNNING, `stdin: ${err.message}`);
    });
  }

  private failPending(code: number, detail?: string): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve(jsonRpcError(code, detail, id));
    }
    this.pending.clear();
  }

  private handleLine(line: string): void {
    let parsed: { id?: string | number; method?: string };
    try {
      parsed = JSON.parse(line);
    } catch {
      return; // Not valid JSON, skip
    }

    // Response shape: id present, no method. (Server-initiated requests
    // also have an id, but they carry a method too and belong on the
    // notification path so the SSE reader can route them to the bridge.)
    const isResponse = parsed.id !== undefined && typeof parsed.method !== "string";
    if (isResponse) {
      const p = this.pending.get(parsed.id!);
      if (p) {
        // Matched delivery is real activity, so refresh lastActivity. We
        // deliberately do NOT refresh it for queued notifications below —
        // if the SSE reader is gone, an upstream that chatters
        // notifications would otherwise keep this session alive forever
        // AND grow the notifications queue. Streams with an active reader
        // still bump lastActivity via drainNotifications().
        this.lastActivity = Date.now();
        clearTimeout(p.timer);
        this.pending.delete(parsed.id!);
        p.resolve(line);
        return;
      }
      // Orphan: a response that arrived after the request already timed
      // out (and was answered with REQUEST_TIMEOUT) or carries an id we
      // don't know. Dropping is the only correct action — without this
      // it would be queued as a notification, evicting real progress/log
      // notifications from the bounded ring buffer and adding spurious
      // SSE traffic. Counted so the next drain can log a single line.
      this.orphansDropped++;
      return;
    }

    // Notification (no id) or server-initiated request (id + method) —
    // both belong on the SSE drain path. Bounded ring buffer so a dead/
    // slow SSE reader can't grow this without limit; drop the oldest
    // entry (FIFO discipline) and account for the loss.
    if (this.notifications.length >= MAX_QUEUED_NOTIFICATIONS) {
      this.notifications.shift();
      this.notificationsDropped++;
    }
    this.notifications.push(line);
  }

  sendRequest(jsonRpcLine: string): Promise<string> {
    if (this.destroyed || !this.process.stdin?.writable) {
      return Promise.resolve(jsonRpcError(ErrorCode.PROCESS_NOT_RUNNING));
    }

    this.lastActivity = Date.now();

    // Inspect the JSON-RPC shape to decide how to handle the body.
    let parsed: { id?: string | number; method?: unknown; result?: unknown; error?: unknown } = {};
    try {
      parsed = JSON.parse(jsonRpcLine);
    } catch {
      // Not parseable — fall through and forward verbatim, no matching.
    }

    // Notification: no id. Response from client for a server-initiated
    // request: has id but no method (and result/error). Both are
    // fire-and-forget from the host's perspective.
    const isNotification = parsed.id === undefined;
    const isResponse = !isNotification && typeof parsed.method !== "string";
    if (isNotification || isResponse) {
      try {
        this.process.stdin.write(jsonRpcLine + "\n");
      } catch (err) {
        // Best effort — no caller is waiting on a result here.
        console.error(`[${this.name}] stdin write failed: ${(err as Error).message}`);
      }
      return Promise.resolve("");
    }

    const id = parsed.id!;
    return new Promise<string>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(jsonRpcError(ErrorCode.REQUEST_TIMEOUT, undefined, id));
      }, this.timeout);

      // Register pending FIRST so a 'error' / stdin 'error' handler that
      // fires synchronously during stdin.write() can find this entry via
      // failPending() and resolve it. Writing first would leave a tiny
      // window where the entry isn't yet registered when the listener
      // drains this.pending, leading to a hung promise.
      this.pending.set(id, { resolve, timer });

      try {
        this.process.stdin!.write(jsonRpcLine + "\n");
      } catch (err) {
        // Synchronous EPIPE on a half-dead child. The async stdin 'error'
        // listener may or may not fire for this — fail this entry now so
        // the caller doesn't sit through the full request timeout.
        if (this.pending.get(id)?.timer === timer) {
          clearTimeout(timer);
          this.pending.delete(id);
          resolve(jsonRpcError(ErrorCode.PROCESS_NOT_RUNNING, (err as Error).message, id));
        }
      }
    });
  }

  drainNotifications(): string[] {
    const n = this.notifications;
    this.notifications = [];
    // SSE listener actively reading — also a sign of life.
    if (n.length > 0) this.lastActivity = Date.now();
    if (this.notificationsDropped > 0) {
      console.error(`[${this.name}] dropped ${this.notificationsDropped} queued notification(s) (cap=${MAX_QUEUED_NOTIFICATIONS}); SSE reader was behind`);
      this.notificationsDropped = 0;
    }
    if (this.orphansDropped > 0) {
      console.error(`[${this.name}] dropped ${this.orphansDropped} late/unmatched response(s); requests already timed out`);
      this.orphansDropped = 0;
    }
    return n;
  }

  get serverName(): string {
    return this.name;
  }

  get isAlive(): boolean {
    return !this.destroyed;
  }

  // Idempotent. Three steps, in order:
  //
  //   1. Mark destroyed BEFORE failing pending so any synchronous
  //      sendRequest racing on another tick short-circuits to
  //      PROCESS_NOT_RUNNING instead of registering into a map we're
  //      about to drain.
  //   2. failPending synchronously: don't wait for the child's 'exit'
  //      handler. A child that ignores SIGTERM (or a shell wrapper that
  //      swallows it) would otherwise leave callers waiting the full
  //      per-request timeout. The 'exit' handler's later failPending
  //      becomes a no-op against the now-empty map.
  //   3. tree-kill the WHOLE process group, not just the direct child.
  //      Documented configs use `shell: true` / `npx`, where the real MCP
  //      server is a grandchild of /bin/sh; a bare process.kill() leaves
  //      it alive after the shell exits, which would silently break
  //      restart_server's contract ("session destroyed" but the wedged
  //      child is still answering on stdin somewhere).
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.failPending(ErrorCode.PROCESS_EXITED, "session destroyed");
    if (!this.process.killed && this.process.pid !== undefined) {
      // Default signal is SIGTERM; tree-kill walks ps/taskkill on
      // POSIX/Windows and signals every descendant. Errors here mean the
      // tree is already gone (race with natural exit) — best-effort.
      treeKill(this.process.pid, (err) => {
        if (err) console.error(`[${this.name}] tree-kill failed: ${err.message}`);
      });
    }
  }
}
