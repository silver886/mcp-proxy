// Validation for pairing-time inputs: which tunnel hostnames the proxy is
// willing to dial out to from /pair/* endpoints. Centralised here so the
// browser can't trick the proxy into hitting arbitrary URLs even if the
// pairing bearer leaks. Kept structurally identical to the runtime path
// (handleComplete validates host configs through the same predicate) so
// what passes pairing-time discovery is exactly what passes pairing-time
// save.

// Tunnel-URL allowlist for /pair/* discovery endpoints. The bearer token
// alone must not authorize SSRF — without this, anyone holding the token
// (browser extension, XSS, leaked terminal scrollback) could pivot the
// proxy to any URL, including http://127.0.0.1 on the host's LAN.
const DEFAULT_TUNNEL_HOST_SUFFIXES = [".trycloudflare.com", ".cfargotunnel.com"];
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function tunnelHostSuffixes(): string[] {
  const extra = (process.env.MCP_TUNNEL_HOST_SUFFIXES ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.startsWith("."));
  return [...new Set([...DEFAULT_TUNNEL_HOST_SUFFIXES, ...extra])];
}

export function allowedTunnelUrl(raw: string): URL | null {
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.username || url.password) return null;

  const host = url.hostname.toLowerCase();
  const allowLocal = process.env.MCP_ALLOW_LOCAL === "true";

  if (allowLocal && LOCAL_HOSTNAMES.has(host)) {
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url;
  }

  if (url.protocol !== "https:") return null;

  const suffixes = tunnelHostSuffixes();
  const ok = suffixes.some((suffix) => host.endsWith(suffix) && host.length > suffix.length);
  return ok ? url : null;
}

// Host returns 404 + JSON error when a forwarded request points at a session
// it doesn't know about — typically because the host GC'd it after 30 min idle
// or the host process restarted. Matched here so the proxy can re-init + retry
// instead of bubbling the failure up to the client.
export function isUnknownSessionError(body: string): boolean {
  try {
    const e = (JSON.parse(body) as { error?: string }).error;
    if (typeof e !== "string") return false;
    return e.startsWith("Unknown session") || e === "Mcp-Session-Id header required";
  } catch {
    return false;
  }
}
