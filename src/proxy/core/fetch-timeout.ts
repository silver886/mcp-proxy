// Combine a per-request timeout with an optional caller signal (e.g., a
// session-scoped AbortController). AbortSignal.any() is the floor (Node
// 20.3+); package.json's engines.node enforces it at install time so we
// don't need a polyfill or a runtime guard here.
//
// We use this for every upstream fetch so a wedged tunnel can't pin the
// proxy indefinitely. Discovery uses DISCOVERY_FETCH_TIMEOUT_MS (15s),
// runtime tool forwards use TOOL_FORWARD_TIMEOUT_MS (5min); see constants.ts.
export function timeoutSignal(ms: number, parent?: AbortSignal): AbortSignal {
  const t = AbortSignal.timeout(ms);
  return parent ? AbortSignal.any([parent, t]) : t;
}
