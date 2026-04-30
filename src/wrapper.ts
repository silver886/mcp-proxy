#!/usr/bin/env node
// Cloudflared wrapper. Owns the cloudflared child for the proxy's pairing
// tunnel, and guarantees the child cannot outlive its parent (proxy).
//
// Lifecycle protocol on stdio:
//   parent -> wrapper: writes "stop\n" to request a clean shutdown
//   parent dies      : stdin closes, wrapper sees EOF and tears the child down
//   wrapper -> parent: prints "URL <tunnel-url>\n" once the tunnel is ready
//   wrapper -> parent: prints "ERR <message>\n" for each cloudflared error
//                      so the parent can include the actual cause in any
//                      rejection / unexpected-exit log instead of a generic
//                      "exited before becoming ready"
//   wrapper -> parent: prints "EXIT <code>\n" when cloudflared exits
//
// Detection latency for parent death is 0ms on Linux/macOS/Windows because
// stdin EOF is delivered by the kernel at the moment the parent's pipe FD
// is closed; no polling is needed.
import { Tunnel } from "cloudflared";
import { LineBuffer } from "./shared/protocol.js";

function main(): void {
  const port = parseInt(process.argv[2] ?? "", 10);
  if (!port || Number.isNaN(port)) {
    process.stderr.write("Usage: wrapper.js <port>\n");
    process.exit(2);
  }

  const tunnel = Tunnel.quick(`http://localhost:${port}`);

  let stopping = false;
  const stop = (code = 0): void => {
    if (stopping) return;
    stopping = true;
    try { tunnel.stop(); } catch { /* already stopped */ }
    // Give cloudflared a moment to flush, then exit.
    setTimeout(() => process.exit(code), 250).unref();
  };

  tunnel.once("url", (url: string) => {
    process.stdout.write(`URL ${url}\n`);
  });

  tunnel.on("error", (err: Error) => {
    // Forward to parent on the structured channel (stdout) so PairingTunnel
    // can include the cause in its rejection. Also keep the human-readable
    // line on stderr — stdio is inherited, so operators tailing logs still
    // see the full cloudflared diagnostic context.
    const message = err.message.replace(/\r?\n/g, " ");
    process.stdout.write(`ERR ${message}\n`);
    process.stderr.write(`tunnel error: ${err.message}\n`);
  });

  tunnel.on("exit", (code) => {
    process.stdout.write(`EXIT ${code ?? ""}\n`);
    stop(typeof code === "number" ? code : 0);
  });

  // Detect parent death via stdin EOF; also accept a "stop" line for clean
  // shutdown initiated by the parent after pairing completes.
  const buf = new LineBuffer();
  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", (chunk: string) => {
    for (const line of buf.push(chunk)) {
      if (line.trim() === "stop") stop(0);
    }
  });
  process.stdin.on("end", () => stop(0));
  process.stdin.on("close", () => stop(0));

  process.on("SIGINT", () => stop(0));
  process.on("SIGTERM", () => stop(0));
}

main();
