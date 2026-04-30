import { getArg } from "../shared/protocol.js";
import { HostAgent } from "./agent.js";
import { type HostTunnel, startTunnel } from "./tunnel.js";

// Entry point: parse flags, start the agent, optionally bring up a quick
// tunnel, install signal handlers. Kept separate from agent.ts so unit
// tests / library users can import HostAgent without invoking process.exit
// or cloudflared.
export async function main(): Promise<void> {
  const configPath = getArg("--config") ?? "config.json";
  const timeoutRaw = getArg("--timeout") ?? "120000"; // 2min default
  const timeout = Number(timeoutRaw);
  // setTimeout(fn, NaN | <=0) fires immediately, making every MCP request
  // appear to time out. Reject bad input at startup instead of silently
  // breaking the agent.
  if (!Number.isInteger(timeout) || timeout <= 0) {
    console.error(`Invalid --timeout "${timeoutRaw}": must be a positive integer (milliseconds)`);
    process.exit(2);
  }
  const useTunnel = process.argv.includes("--tunnel");
  // In tunnel mode the listener is internal-only — cloudflared is the sole
  // caller — so we ignore config.host/port and force loopback + an
  // OS-assigned port. That removes the foot-gun where a user-provided port
  // collides with another local service, and prevents accidentally
  // exposing the unauthenticated-from-the-LAN listener on a routable
  // interface when the bearer token is meant to ride only over the tunnel.
  const overrides = useTunnel ? { host: "127.0.0.1", port: 0 } : undefined;
  const agent = new HostAgent(configPath, timeout, overrides);
  await agent.start();

  let tunnel: HostTunnel | null = null;
  if (useTunnel) {
    console.log("Starting Cloudflare tunnel...");
    try {
      tunnel = await startTunnel(agent.port, (reason) => {
        // Runtime failure after the tunnel was already serving — keep the
        // local agent alive so loopback clients can still reach it, but
        // make the situation loud so the operator knows the public URL is
        // dead and needs a restart.
        console.error(`Cloudflare tunnel exited unexpectedly: ${reason}`);
        console.error("The public URL is no longer reachable. Restart the host to bring up a new tunnel.");
      });
    } catch (err) {
      // Pre-ready tunnel failure (binary missing, network down, auth
      // failure, startup timeout). Without this the user previously saw
      // only "Starting Cloudflare tunnel..." and an apparently healthy
      // host with no URL. Now we tear the agent down and exit non-zero so
      // the failure is visible to whatever launched us.
      console.error(`Cloudflare tunnel failed to start: ${(err as Error).message}`);
      try { agent.shutdown(); } catch { /* ignore */ }
      process.exit(1);
    }
  }

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}, shutting down...`);
    try {
      agent.shutdown();
    } catch (err) {
      console.error(`Agent shutdown error: ${(err as Error).message}`);
    }
    if (tunnel) {
      try {
        tunnel.stop();
      } catch (err) {
        console.error(`Tunnel stop error: ${(err as Error).message}`);
      }
    }
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}
