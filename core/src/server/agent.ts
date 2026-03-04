// Agent Port — TOFU (Trust On First Use) connection system
// Utilities for agent key hashing and session management.

import { createHash, timingSafeEqual } from 'node:crypto';

export const AGENT_SESSION_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days

/** SHA-256 hex hash — fast, sufficient for high-entropy agent keys */
export function hashAgentKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/** Constant-time comparison of two hex hashes */
export function timingSafeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}
