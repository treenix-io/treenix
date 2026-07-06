// Read-plan identity (core-hp7). One plan = one hash, regardless of key
// construction order. Consumers: cursor↔plan binding (core-8an: reject a
// cursor replayed against a different plan) and watch execution-group dedup
// (core-9yd: same (actor, planHash, claimsHash) shares one evaluation).
//
// viewPath / mount metadata are deliberately NOT part of identity — two view
// paths resolving to the same {source, wheres} ARE the same read (the MVP keeps
// viewPath in request ctx for audit only). canonicalReadPlan picks identity
// fields explicitly, so any future metadata on ReadPlan stays excluded unless
// added here on purpose.

import { createHash } from 'node:crypto';
import { OpError } from '#errors';
import { stableJson } from '#util/stable-json';
import type { ReadPlan } from './read-runtime';

export type CanonicalPlan = {
  source: string;
  /** MVP reads are depth-1; field is explicit so depth>1 (core-0bl) changes
   *  the hash instead of silently aliasing plans of different depth. */
  depth: number;
  viewWhere?: Record<string, unknown>;
  callerWhere?: Record<string, unknown>;
};

export function canonicalReadPlan(plan: ReadPlan): CanonicalPlan {
  return {
    source: plan.source,
    depth: 1,
    ...(plan.viewWhere ? { viewWhere: plan.viewWhere } : {}),
    ...(plan.callerWhere ? { callerWhere: plan.callerWhere } : {}),
  };
}

/** Collision-resistant (sha256) — callerWhere is attacker-supplied, and a
 *  crafted hash collision must not let one plan's cursor or watch group be
 *  replayed against another. Hex-truncated to 32 chars (128 bits). */
export function planHash(plan: ReadPlan): string {
  return createHash('sha256').update(stableJson(canonicalReadPlan(plan))).digest('hex').slice(0, 32);
}

// ── ReadCursor (core-8an) ──
// StorageCursor (adapter-internal order position) never crosses the API
// boundary raw — executeList wraps it with the plan's hash. A cursor minted
// under plan A resumed against plan B would skip/duplicate rows silently
// (different predicates ⇒ different visible sequence), so replay is refused.
// Wire format: `<planHash>.<base64url(storageCursor)>` — hash is hex and
// base64url has no '.', so the delimiter is unambiguous.

export function encodeReadCursor(hash: string, storageCursor: string): string {
  return `${hash}.${Buffer.from(storageCursor, 'utf8').toString('base64url')}`;
}

export function decodeReadCursor(cursor: string, expectedHash: string): string {
  const [hash, sc, ...extra] = cursor.split('.');
  if (sc === undefined || extra.length > 0 || !/^[A-Za-z0-9_-]*$/.test(sc)) {
    throw new OpError('BAD_REQUEST', 'malformed read cursor');
  }
  if (hash !== expectedHash) {
    throw new OpError('BAD_REQUEST', 'cursor was issued for a different read plan — restart pagination');
  }
  return Buffer.from(sc, 'base64url').toString('utf8');
}
