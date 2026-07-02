// Server health flag — flips to unhealthy when audit append fails, heals when
// an append succeeds again (core-98jr: the old restart-only sticky flag kept the
// server dead after the audit backend recovered). Two heal paths:
//   organic — any successful audit append calls markHealthy();
//   probe   — while unhealthy, checkHealth() (the HTTP gate) runs a throttled
//             real append attempt, so an idle server heals under the very
//             traffic the 503 gate would otherwise reject forever.

let healthy = true;
let reason = '';

// Recovery probe — registered by withAudit (it owns the tree to append into).
let probe: (() => Promise<void>) | null = null;
let lastProbeAt = 0;
const PROBE_MIN_INTERVAL_MS = 5_000;

export function isHealthy(): boolean {
  return healthy;
}

export function unhealthyReason(): string {
  return reason;
}

export function markUnhealthy(why: string): void {
  if (!healthy) return; // keep the first reason — root cause, not cascade
  healthy = false;
  reason = why;
  console.error(`[audit] SERVER UNHEALTHY: ${why}`);
}

export function markHealthy(): void {
  if (healthy) return;
  healthy = true;
  reason = '';
  console.error('[audit] server healthy again — audit append succeeded');
}

/** withAudit registers a real-append probe here at wrap time. */
export function setRecoveryProbe(fn: () => Promise<void>): void {
  probe = fn;
}

/** Health gate hook: current state, with a throttled recovery attempt while
 *  unhealthy. The probe is a REAL audit append — success proves the exact
 *  operation that failed, and its row documents the recovery moment. */
export async function checkHealth(): Promise<{ healthy: boolean; reason: string }> {
  if (!healthy && probe && Date.now() - lastProbeAt >= PROBE_MIN_INTERVAL_MS) {
    lastProbeAt = Date.now();
    try {
      await probe();
      markHealthy();
    } catch (err) {
      // Still down — throttle makes this at most one line per interval.
      console.error('[audit] recovery probe failed:', err instanceof Error ? err.message : err);
    }
  }
  return { healthy, reason };
}

/** Test-only — production code must never call this. */
export function resetHealthForTest(): void {
  healthy = true;
  reason = '';
  probe = null;
  lastProbeAt = 0;
}
