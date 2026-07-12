// Optimistic Rebase — confirmed + pending + replay
// Applies server patches to pre-optimistic state, replays remaining pending ops.
// Zero React deps, pure logic.

import { getComponent, type NodeData } from '@treenx/core';
import { type Class, predictionCtx } from '@treenx/core/comp';
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
 *  Each op runs against its own candidate clone; the clone commits ONLY on
 *  synchronous, non-thenable success (core-anz4.18). Sync throw (e.g.
 *  CTX_UNAVAILABLE from server-only ctx) → candidate discarded — no
 *  half-executed draft. Thenable return → discarded too: settlement may
 *  still reject after the sync span mutated the candidate, and post-await
 *  continuations would mutate an object already in cache — async
 *  predictions cannot commit atomically, so they never commit; escaped
 *  continuations mutate only the orphaned clone. We still attach .catch()
 *  so a rejection is reported instead of becoming an "Uncaught (in
 *  promise)". Optimistic UX is best-effort; the server result is
 *  authoritative. */
function replayAndPut(path: string, rs: RebaseState) {
  let draft = structuredClone(rs.confirmed);
  for (const op of rs.pending) {
    const candidate = structuredClone(draft);
    try {
      const comp = getComponent(candidate, op.cls, op.key);
      if (!comp) continue;
      const result = op.handler(predictionCtx(candidate, comp), op.data) as unknown;
      if (result && typeof (result as Promise<unknown>).then === 'function') {
        // Promise.resolve wrap: a conforming PromiseLike guarantees only .then —
        // calling .catch on it directly throws and orphans the rejection.
        Promise.resolve(result).catch(err => reportReplayFailure(path, op, err));
        logSkipOnce(op, 'async prediction');
        continue;
      }
      draft = candidate;
    } catch (err) {
      reportReplayFailure(path, op, err);
    }
  }
  cache.put(draft);
}

// Skipped predictions are an EXPECTED lane (server event re-syncs) —
// log once per action+reason, not a warn per replay.
const skipLogged = new Set<string>();

function logSkipOnce(op: PendingOp, reason: string) {
  const key = `${op.type ?? op.cls.name}:${op.action ?? ''}:${reason}`;
  if (skipLogged.has(key)) return;
  skipLogged.add(key);
  console.info(
    `[treenix] optimistic prediction skipped (${reason}) type=${op.type ?? op.cls.name}`
    + `${op.action ? ` action=${op.action}` : ''} — server result will sync`,
  );
}

function reportReplayFailure(path: string, op: PendingOp, err: unknown) {
  if (err instanceof Error && 'code' in err && err.code === 'CTX_UNAVAILABLE') {
    logSkipOnce(op, 'needs server ctx');
    return;
  }
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

/** Drop every overlay — continuity lost (reconnect preserved:false, core-jvfv) or test teardown */
export function clear(): void {
  state.clear();
}
