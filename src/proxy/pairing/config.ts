import { validateServerName } from "../../shared/protocol.js";
import { TOOL_SEPARATOR } from "../core/constants.js";
import type { HostConfig, PairingConfig } from "../core/types.js";
import { allowedTunnelUrl } from "./validation.js";

export type PairingConfigValidation =
  | { ok: true; hosts: HostConfig[] }
  | { ok: false; error: string };

// Validate a PairingConfig submitted by the setup page. Pure: returns the
// canonicalised host list (tunnelUrl reduced to its origin so query strings
// /paths can't smuggle through) or an error string. Centralised here rather
// than inlined in handleComplete so the rules are reviewable independently
// of the orchestrator. Every failure mode produces a human-readable error
// the setup page surfaces back to the user.
export function validatePairingConfig(cfg: PairingConfig): PairingConfigValidation {
  if (!cfg || cfg.sealed !== true) return { ok: false, error: "config must be sealed" };
  if (!Array.isArray(cfg.hosts) || cfg.hosts.length === 0) {
    return { ok: false, error: "hosts must be a non-empty array" };
  }
  if (cfg.selectedServers !== undefined) {
    if (!Array.isArray(cfg.selectedServers)) {
      return { ok: false, error: "selectedServers must be an array if provided" };
    }
    // `undefined` means "allow all", which is a valid distinct shape. An
    // explicit empty array would seal a config that exposes zero servers —
    // exactly what the UI's "must select at least one" rule prevents on the
    // client. Reject it here so a direct caller of /pair/complete can't
    // bypass that gate and persist a paired-but-empty proxy.
    if (cfg.selectedServers.length === 0) {
      return { ok: false, error: "selectedServers must not be empty if provided" };
    }
  }
  if (cfg.selectedTools !== undefined && !Array.isArray(cfg.selectedTools)) {
    return { ok: false, error: "selectedTools must be an array if provided" };
  }

  const seen = new Set<string>();
  const validatedHosts: HostConfig[] = [];
  for (const h of cfg.hosts) {
    if (!h || typeof h !== "object") return { ok: false, error: "each host must be an object" };
    if (typeof h.id !== "string" || !h.id) return { ok: false, error: "host.id is required" };
    const reason = validateServerName(h.id);
    if (reason) return { ok: false, error: `host.id "${h.id}" ${reason}` };
    if (seen.has(h.id)) return { ok: false, error: `duplicate host.id "${h.id}"` };
    seen.add(h.id);
    if (typeof h.tunnelUrl !== "string" || !h.tunnelUrl) {
      return { ok: false, error: `host "${h.id}".tunnelUrl is required` };
    }
    if (typeof h.authToken !== "string" || !h.authToken) {
      return { ok: false, error: `host "${h.id}".authToken is required` };
    }
    const validatedUrl = allowedTunnelUrl(h.tunnelUrl);
    if (!validatedUrl) {
      return { ok: false, error: `host "${h.id}".tunnelUrl is not on the allowlist (must be https on a Cloudflare tunnel domain)` };
    }
    validatedHosts.push({
      id: h.id,
      tunnelUrl: validatedUrl.origin,
      authToken: h.authToken,
      ...(typeof h.label === "string" && h.label ? { label: h.label } : {}),
    });
  }

  // selectedServers entries must reference hosts we actually know about,
  // otherwise an attacker (or a stale UI) could shape the config so the
  // server-level allow list never triggered. Catching it here keeps the
  // invariant on the way IN to ProxyServer state.
  //
  // Server names may themselves contain `__`, so we don't `split` — we
  // take the prefix before the FIRST `__` as the hostId and require the
  // remainder (the serverName) to be non-empty so a malformed entry like
  // `host__` doesn't sneak through as a valid-looking allowlist line that
  // can never match any real server.
  const validHostIds = new Set(validatedHosts.map((h) => h.id));
  if (cfg.selectedServers) {
    for (const entry of cfg.selectedServers) {
      if (typeof entry !== "string") {
        return { ok: false, error: `selectedServers entries must look like "<hostId>__<serverName>"` };
      }
      const sep = entry.indexOf(TOOL_SEPARATOR);
      if (sep <= 0 || sep + TOOL_SEPARATOR.length >= entry.length) {
        return { ok: false, error: `selectedServers entry "${entry}" must look like "<hostId>__<serverName>"` };
      }
      const hostId = entry.slice(0, sep);
      if (!validHostIds.has(hostId)) {
        return { ok: false, error: `selectedServers references unknown host "${hostId}"` };
      }
    }
  }

  // selectedTools entries are full prefixed tool names
  // `<hostId>__<serverName>__<toolName>`. We can't validate <toolName>
  // here (tools are discovered post-pair), but the prefix MUST point at
  // an exposed server AND the entry must contain enough segments to
  // actually carry a tool name: an entry whose server prefix isn't in
  // selectedServers (when defined) — or whose hostId isn't a known host
  // (when selectedServers is omitted) — is unreachable noise that hides
  // bugs in the UI or stale configs. Tool/server names may themselves
  // contain `__`, so we prefix-match the allowed scope rather than
  // splitting on the separator. Shape is enforced separately by requiring
  // at least two `__` occurrences — the prefix-match alone degraded to a
  // hostId-only check when `selectedServers` was omitted, letting entries
  // like `host__bogus` survive without a tool segment.
  if (cfg.selectedTools) {
    const allowedServerPrefixes = cfg.selectedServers
      ? cfg.selectedServers.map((s) => `${s}${TOOL_SEPARATOR}`)
      : Array.from(validHostIds).map((id) => `${id}${TOOL_SEPARATOR}`);
    const scopeLabel = cfg.selectedServers ? "selectedServers" : "any known host";
    for (const entry of cfg.selectedTools) {
      if (typeof entry !== "string" || !entry) {
        return { ok: false, error: "selectedTools entries must be non-empty strings" };
      }
      const firstSep = entry.indexOf(TOOL_SEPARATOR);
      const secondSep = firstSep < 0 ? -1 : entry.indexOf(TOOL_SEPARATOR, firstSep + TOOL_SEPARATOR.length);
      if (firstSep < 0 || secondSep < 0) {
        return { ok: false, error: `selectedTools entry "${entry}" must look like "<hostId>__<serverName>__<toolName>"` };
      }
      const matchedPrefix = allowedServerPrefixes.find((p) => entry.startsWith(p));
      if (!matchedPrefix) {
        return { ok: false, error: `selectedTools entry "${entry}" does not reference a server in ${scopeLabel}` };
      }
      // Must have at least one character after the matched server prefix
      // — i.e. an actual tool segment, not the prefix on its own.
      if (entry.length <= matchedPrefix.length) {
        return { ok: false, error: `selectedTools entry "${entry}" is missing the tool name` };
      }
    }
  }

  return { ok: true, hosts: validatedHosts };
}
