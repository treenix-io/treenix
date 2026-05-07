// Server health flag. Sticky: once flipped to unhealthy, stays until process restart.
// Used by withAudit to mark the server when audit append fails — the HTTP middleware
// returns 503 on all non-/health endpoints until the operator restarts after fixing
// the audit backend. Reset is test-only.

let healthy = true;
let reason = '';

export function isHealthy(): boolean {
  return healthy;
}

export function unhealthyReason(): string {
  return reason;
}

export function markUnhealthy(why: string): void {
  if (!healthy) return; // sticky — keep first reason
  healthy = false;
  reason = why;
  console.error(`[audit] SERVER UNHEALTHY: ${why}`);
}

/** Test-only — production code must never call this. */
export function resetHealthForTest(): void {
  healthy = true;
  reason = '';
}
