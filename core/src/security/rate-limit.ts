// In-memory rate limiter (per key, sliding window).
// Transport-agnostic — throws OpError, not TRPCError.

import { OpError } from '#errors';

const buckets = new Map<string, { count: number; resetAt: number }>();
const WINDOW_MS = 60_000;
const DEFAULT_LIMIT = 10;

export function checkRate(key: string, limit = DEFAULT_LIMIT): void {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || now > bucket.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return;
  }
  if (bucket.count >= limit) throw new OpError('TOO_MANY_REQUESTS', 'Too many requests');
  bucket.count++;
}

// Periodic cleanup (every 5 min)
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of buckets) if (now > v.resetAt) buckets.delete(k);
}, 5 * 60_000).unref();

// Test-only: full bucket clear. Module-level Map persists across tests in one process.
export function _resetRateLimits() { buckets.clear(); }
