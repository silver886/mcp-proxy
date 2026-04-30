import { Tunnel } from "cloudflared";

// Bound how long we wait for cloudflared to advertise the public URL.
// Anything slower than this is almost always a configuration / network /
// account issue we want to surface to the user instead of hanging silently.
const TUNNEL_STARTUP_TIMEOUT_MS = 30_000;

export interface HostTunnel {
  url: string;
  stop: () => void;
}

// Start a quick cloudflared tunnel and resolve once cloudflared advertises
// the public URL. Rejects with a descriptive error if cloudflared:
//   - errors out before becoming ready (binary missing, network unreachable,
//     account auth failure, etc.),
//   - exits before advertising a URL,
//   - or doesn't surface a URL within TUNNEL_STARTUP_TIMEOUT_MS.
//
// `onUnexpectedExit` fires only AFTER the URL was advertised — i.e., a
// runtime failure once the tunnel was healthy. Pre-ready failures already
// reject the start() promise, so the caller learns about those
// synchronously and can decide whether to keep the host running locally or
// shut it down.
export function startTunnel(
  port: number,
  onUnexpectedExit?: (reason: string) => void,
): Promise<HostTunnel> {
  const tunnel = Tunnel.quick(`http://localhost:${port}`);

  // Capture the most recent cloudflared error so a subsequent exit/timeout
  // can include the real cause in the rejection instead of "did not produce
  // a URL".
  let lastErrorMessage: string | null = null;
  tunnel.on("error", (err: Error) => {
    lastErrorMessage = err.message;
    process.stderr.write(`Tunnel error: ${err.message}\n`);
  });

  return new Promise<HostTunnel>((resolveP, rejectP) => {
    let settled = false;
    let urlReady = false;

    const finishStartup = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(startupTimer);
      fn();
    };

    const startupTimer = setTimeout(() => {
      finishStartup(() => {
        try { tunnel.stop(); } catch { /* already gone */ }
        const cause = lastErrorMessage ? ` (last error: ${lastErrorMessage})` : "";
        rejectP(new Error(`Cloudflare tunnel did not produce a URL within ${TUNNEL_STARTUP_TIMEOUT_MS / 1000}s${cause}`));
      });
    }, TUNNEL_STARTUP_TIMEOUT_MS);

    tunnel.once("url", (url: string) => {
      urlReady = true;
      console.log(`Tunnel URL: ${url}`);
      finishStartup(() => {
        resolveP({
          url,
          stop: () => { try { tunnel.stop(); } catch { /* already stopped */ } },
        });
      });
    });

    tunnel.on("exit", (code, signal) => {
      const detail = code !== null
        ? `code ${code}`
        : signal !== null ? `signal ${signal}` : "unknown reason";
      const errBit = lastErrorMessage ? ` (${lastErrorMessage})` : "";
      const reason = `cloudflared exited (${detail})${errBit}`;
      if (!urlReady) {
        finishStartup(() => rejectP(new Error(reason)));
        return;
      }
      // URL was already advertised — this is a runtime failure. Surface
      // through the caller's hook so cli.ts (or whoever owns the lifecycle)
      // can log it and decide what to do.
      process.stderr.write(`Tunnel ${reason}\n`);
      if (onUnexpectedExit) onUnexpectedExit(reason);
    });
  });
}
