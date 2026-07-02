// Optimistic Rebase — confirmed + pending + replay
// Applies server patches to pre-optimistic state, replays remaining pending ops.
// Zero React deps, pure logic.

import { getComponent, type NodeData } from '@treenx/core';
import type { Class } from '@treenx/core/comp';
import { applyOps, type PatchOp } from '@treenx/core/tree';
import * as cache from './cache';

interface PendingOp {
  opId: string;
  cls: Class<any>;
  key?: string;
  handler: Function;
  data: unknown;
  type?: string;
  action?: string;
}

interface RebaseState {
  confirmed: NodeData;
  pending: PendingOp[];
}

const state = new Map<string, RebaseState>();

/** Replay all pending ops on confirmed and put result in cache.
 *  Handlers may be async — sync try/catch only catches sync throws, so we also
 *  attach .catch() to any returned promise to report async rejections.
 *  Without this, one failing optimistic op (e.g. action calling server-only
 *  tree.set on the client) becomes an "Uncaught (in promise)" and cascades
 *  through every subsequent replay. Optimistic UX is best-effort; the server
 *  result is authoritative. */
function replayAndPut(path: string, rs: RebaseState) {
  const draft = structuredClone(rs.confirmed);
  for (const op of rs.pending) {
    try {
      const comp = getComponent(draft, op.cls, op.key);
      if (!comp) continue;
      const result = op.handler({ comp, node: draft }, op.data) as unknown;
      if (result && typeof (result as Promise<unknown>).then === 'function') {
        (result as Promise<unknown>).catch(err => warnReplayFailure(path, op, err));
      }
    } catch (err) {
      warnReplayFailure(path, op, err);
    }
  }
  cache.put(draft);
}

function warnReplayFailure(path: string, op: PendingOp, err: unknown) {
  console.warn(
    `[treenix] optimistic replay failed path=${path} type=${op.type ?? op.cls.name}`
    + `${op.key ? ` key=${op.key}` : ''}`
    + `${op.action ? ` action=${op.action}` : ''}`,
    err,
  );
}

function cleanup(path: string, rs: RebaseState) {
  cache.put(rs.confirmed);
  state.delete(path);
}

// State exists only while pending is non-empty (settle deletes it at zero), so
// a live rs always carries at least one pending op.
function settle(path: string, rs: RebaseState) {
  if (rs.pending.length === 0) cleanup(path, rs);
  else replayAndPut(path, rs);
}

/** Consume the pending op this server event acknowledges (core-gk8.1).
 *  `by` = the opId the client stamped on its mutation, echoed back on the
 *  resulting event. A write we did NOT originate (another user, a server job)
 *  carries no `by` — it advances confirmed but must never eat a local pending
 *  slot. Blind FIFO shift did exactly that (cnr.6): a foreign patch on the same
 *  path stole an in-flight optimistic op's ack. Match by id, not position.
 *  An action that persists nothing emits no event, so its op is never acked —
 *  predicting a local change for a non-persisting action is a handler bug;
 *  mark such actions noOptimistic. */
function consumeAck(rs: RebaseState, by: string | undefined) {
  if (by === undefined) return;
  const idx = rs.pending.findIndex(op => op.opId === by);
  if (idx !== -1) rs.pending.splice(idx, 1);
}

/** Push an optimistic action — snapshot confirmed on first call, replay all pending */
export function pushOptimistic<T extends object>(
  path: string, cls: Class<T>, key: string | undefined,
  handler: Function, data: unknown, opId: string,
  meta?: { type?: string; action?: string },
): void {
  const cached = cache.get(path);
  if (!cached) return;

  let rs = state.get(path);
  if (!rs) {
    rs = { confirmed: structuredClone(cached), pending: [] };
    state.set(path, rs);
  }
  rs.pending.push({ opId, cls, key, handler, data, type: meta?.type, action: meta?.action });
  replayAndPut(path, rs);
}

/** Apply server patch to confirmed state. Returns true if rebase handled it. */
export function applyServerPatch(path: string, patches: PatchOp[], rev?: number, by?: string): boolean {
  const rs = state.get(path);
  if (!rs) return false;

  applyOps(rs.confirmed, patches);
  // Patches don't carry $rev; without this, confirmed state stays at pre-patch rev
  // and next optimistic op sends stale $rev → OptimisticConcurrencyError storm.
  // Guard against wire-level garbage (NaN, null disguised as number).
  if (typeof rev === 'number' && Number.isFinite(rev)) rs.confirmed.$rev = rev;
  consumeAck(rs, by);
  settle(path, rs);
  return true;
}

/** Apply server set (full node) to confirmed state. Returns true if rebase handled it. */
export function applyServerSet(path: string, node: NodeData, by?: string): boolean {
  const rs = state.get(path);
  if (!rs) return false;

  rs.confirmed = node;
  consumeAck(rs, by);
  settle(path, rs);
  return true;
}

/** Rollback the pending op that failed on the server, by its opId (core-gk8.1).
 *  Blind pop() rolled back the LAST op regardless of which one erred (cnr.6);
 *  out-of-order failures corrupted the queue. Idempotent — a no-op if the op
 *  was already consumed by an ack that raced the rejection. */
export function rollback(path: string, opId: string): void {
  const rs = state.get(path);
  if (!rs) return;

  const idx = rs.pending.findIndex(op => op.opId === opId);
  if (idx === -1) return;
  rs.pending.splice(idx, 1);
  settle(path, rs);
}

/** Check if path has rebase state (for testing) */
export function hasPending(path: string): boolean {
  return state.has(path);
}

/** Clear all rebase state (for testing) */
export function clear(): void {
  state.clear();
}
