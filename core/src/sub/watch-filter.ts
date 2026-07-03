// Transport-agnostic ACL filter for watch events.
// Sits between WatchManager and any transport (tRPC, HTTP, WS).
// Ensures users only receive events they're authorized to see.

import { A, isCompKey, isComponent, type NodeData, R } from '#core';
import type { PatchOp, Tree } from '#tree';
import { componentPerm, resolvePermission, stripComponents } from '#security/acl';
import { buildClaims } from '#security/claims';
import type { NodeEvent, WireEvent } from './index';

/** Transport-facing push: carries data events AND the pathless invalidate the
 *  filter synthesizes when a data event is ACL-dropped (core-dm1). */
export type EventPush = (event: WireEvent) => void;

/** WatchManager-facing push: only ever fed CDC data/reconnect events (NodeEvent)
 *  — the invalidate is born inside the filter, never routed in. */
export type FilteredPush = (event: NodeEvent) => void;

/** Deliver the coarse invalidate when a data event is about to be dropped by
 *  the ACL filter (core-dm1/0i3). The dropped event named dirty query views in
 *  `invalidateVps`; the reader still watches those views and must refetch, even
 *  though they can no longer read the node that shifted. Carries the event's
 *  seq so the client's resume watermark advances in lockstep with the ring. */
function invalidateFallback(event: Exclude<NodeEvent, { type: 'reconnect' }>, push: EventPush): void {
  const vps = event.invalidateVps;
  if (vps && vps.length > 0) {
    push({ type: 'invalidate', vps, ...(event.seq === undefined ? {} : { seq: event.seq }) });
  }
}

export type WatchFilterOpts = {
  claimsTtlMs?: number;
};

const DEFAULT_CLAIMS_TTL_MS = 30_000;

/**
 * Filter compact PatchOps, removing ops that target restricted components.
 * PatchOp shape: `[verb, dotPath, value?]` where `dotPath` is dot-separated
 * (e.g. `componentKey.field`). First segment is the node key.
 * `node` is the post-write stored node; `hasNodeA` is the caller's A bit on
 * that node.
 */
export function filterPatches(
  patches: PatchOp[],
  node: NodeData,
  userId: string | null,
  claims: string[],
  hasNodeA: boolean,
): PatchOp[] {
  return patches.filter(op => {
    const path = op[1];
    const dotIdx = path.indexOf('.');
    const seg = dotIdx === -1 ? path : path.slice(0, dotIdx);
    if (!seg) return false; // empty path — drop
    if (seg.startsWith('$')) {
      // Exact $rev replace is a public version bump; anything deeper or any
      // other $-prefixed path ($acl/$owner/$refs/$secret/etc., or $rev.nested)
      // requires A.
      return path === '$rev' || hasNodeA;
    }
    // Strict namespace: bare first segment = node body (data). Node-level R
    // was already checked upstream, and stripComponents never strips body —
    // gating body patches here would hide data the reader can fetch anyway.
    if (!isCompKey(seg)) return true;
    const val = node[seg];
    // Component absent in stored — either removed or never existed. Without an
    // oldNode snapshot we cannot tell if it was restricted; fail closed unless
    // caller has A. Malformed '#'-entry (no $type) fails closed the same way.
    if (val === undefined || !isComponent(val)) return hasNodeA;
    return !!(componentPerm(val, userId, claims, node.$owner) & R);
  });
}

/**
 * Create an ACL-filtered push function for a specific user session.
 * Wraps a raw push channel, dropping/stripping events the user cannot see.
 */
export function createFilteredPush(
  store: Tree,
  userId: string,
  sessionClaims: string[] | null,
  push: EventPush,
  opts?: WatchFilterOpts,
): FilteredPush {
  const claimsTtlMs = opts?.claimsTtlMs ?? DEFAULT_CLAIMS_TTL_MS;

  let dynamicClaims: string[] | null = null;
  let dynamicAt = 0;

  const getClaims = async () => {
    if (sessionClaims) return sessionClaims;
    if (!dynamicClaims || Date.now() - dynamicAt > claimsTtlMs) {
      dynamicClaims = await buildClaims(store, userId);
      dynamicAt = Date.now();
    }
    return dynamicClaims;
  };

  // Per-session delivery is serialized: filterEvent awaits ACL lookups, so
  // without a queue a slow lookup on E1 lets E2 overtake it — out-of-order
  // patches silently corrupt the client's patch-based cache (core-gk8.12).
  // An error drops only its own event; the chain recovers and stays ordered.
  let chain: Promise<void> = Promise.resolve();
  return (event: NodeEvent) => {
    // R4-WATCH-1: filter still fails closed (event silently dropped) for confidentiality —
    // a thrown filter must NEVER push a possibly-leaky event. But the swallow violates
    // "fail loud": log so policy/storage bugs surface in operations.
    chain = chain
      .then(() => filterEvent(store, event, userId, getClaims, push))
      .catch(err => {
        const path = (event as { path?: string }).path ?? '<no-path>';
        console.error('[watch-filter] dropped %s event for user=%s path=%s: %s', event.type, userId, path, (err as Error)?.message ?? err);
      });
  };
}

async function filterEvent(
  store: Tree,
  event: NodeEvent,
  userId: string,
  getClaims: () => Promise<string[]>,
  push: EventPush,
) {
  if (event.type === 'reconnect') { push(event); return; }

  // Remove: node is already deleted — check parent ACL instead.
  // If user can read parent, they see children come and go.
  if (event.type === 'remove') {
    const claims = await getClaims();
    const parent = event.path.slice(0, event.path.lastIndexOf('/')) || '/';
    const perm = await resolvePermission(store, parent, userId, claims);
    if (perm & R) push(event);
    else invalidateFallback(event, push);
    return;
  }

  const claims = await getClaims();
  const perm = await resolvePermission(store, event.path, userId, claims);
  if (!(perm & R)) { invalidateFallback(event, push); return; }

  if (event.type === 'set' && event.node) {
    // ACL must come from stored node, not event payload — writer-supplied $owner/$acl in body would otherwise grant view.
    const stored = await store.get(event.path);
    if (!stored) return;
    const stripped = stripComponents(stored, userId, claims);
    const { $path, ...body } = stripped;
    push({ ...event, node: body });
  } else if (event.type === 'patch' && event.patches.length > 0) {
    // Fail closed if stored node disappeared mid-emit — never push raw writer-supplied patches without filtering.
    const node = await store.get(event.path);
    if (!node) return;
    const hasNodeA = !!(perm & A);
    const filtered = filterPatches(event.patches, node, userId, claims, hasNodeA);
    if (filtered.length === 0) { invalidateFallback(event, push); return; }
    push(filtered.length === event.patches.length ? event : { ...event, patches: filtered });
  } else {
    push(event);
  }
}
