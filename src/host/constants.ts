// Cap on queued notifications per session. Drains happen each time the
// proxy's SSE reader polls (every 100ms in handleSse). With a sane upstream
// this stays at a handful of entries; the cap is here to bound memory when
// the SSE reader is dead/slow and the child is chatty. On overflow we drop
// the oldest entries — the lost notifications are progress/log noise; any
// id-bearing response is matched to a pending request before it ever reaches
// this queue, so request correctness is unaffected.
export const MAX_QUEUED_NOTIFICATIONS = 1000;

// Idle session GC: close sessions that haven't been used in this many ms.
export const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
export const SESSION_GC_INTERVAL_MS = 60 * 1000; // sweep every minute

// SSE poll interval — how often handleSse drains queued notifications.
export const SSE_DRAIN_INTERVAL_MS = 100;
