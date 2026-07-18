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
  cache.put(replayDraft(path, rs));
}

/** Pure replay half of replayAndPut — snapshot ingest needs the overlay image
 *  without an extra cache.put per node (pages batch through replaceChildren). */
function replayDraft(path: string, rs: RebaseState): NodeData {
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
  return draft;
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

// ── Ack-via-response (core-anz4.13) ──
// A caller with R+W but no S never receives the `by`-matched event, so its
// overlay would hang forever. execute() confirms the op from its response via
// an authoritative refetch (confirmFromResponse); the {path,opId} is recorded
// here so the event — IF it arrives after all (S callers) — is not applied a
// second time on top of the already-refetched state. Bounded FIFO: entries
// whose event never comes (the no-S case) age out by capacity.
const SUPPRESS_MAX = 1024;
const suppressedAcks = new Set<string>();

const ackKey = (path: string, opId: string) => `${path}\u0000${opId}`;

function recordSuppressedAck(path: string, opId: string) {
  if (suppressedAcks.size >= SUPPRESS_MAX) {
    const oldest = suppressedAcks.values().next().value;
    if (oldest !== undefined) suppressedAcks.delete(oldest);
  }
  suppressedAcks.add(ackKey(path, opId));
}

function consumeSuppressedAck(path: string, by: string): boolean {
  return suppressedAcks.delete(ackKey(path, by));
}

/** Confirm a pending op from the execute response (core-anz4.13): the caller
 *  refetched `path` after the action succeeded and hands us the authoritative
 *  node. `node` undefined = refetch denied (no R on the result) or node gone —
 *  the action still succeeded, but overlay and cache entry are lies now: drop
 *  both. Idempotent vs the event lane: if the `by`-matched event already
 *  consumed the op, this only heals confirmed onto the fresher refetch. */
export function confirmFromResponse(path: string, opId: string, node: NodeData | undefined): void {
  const rs = state.get(path);
  if (!rs) return;

  if (node === undefined) {
    state.delete(path);
    cache.remove(path);
    return;
  }

  const idx = rs.pending.findIndex(op => op.opId === opId);
  if (idx === -1) {
    if (!regresses(rs.confirmed, node)) rs.confirmed = node;
    settle(path, rs);
    return;
  }

  rs.pending.splice(idx, 1);
  // Invariant 18 on the response lane too: a refetch that raced a newer
  // event must not roll the confirmed base back.
  if (!regresses(rs.confirmed, node)) rs.confirmed = node;
  recordSuppressedAck(path, opId);
  settle(path, rs);
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
function consumeAck(rs: RebaseState, by: string | undefined): boolean {
  if (by === undefined) return false;
  const idx = rs.pending.findIndex(op => op.opId === by);
  if (idx === -1) return false;
  rs.pending.splice(idx, 1);
  return true;
}

/** Consume the ack an event carries WITHOUT applying its payload (ns6p.4 §3.3):
 *  the rev machine skipped the event as stale or routed it to refetch — the
 *  op's effect is already inside the cached image (rev ≥ event) or arrives
 *  with the refetch, but the ack must still settle the pending op. */
export function consumeAckOnly(path: string, by: string | undefined): void {
  if (by === undefined) return;
  if (consumeSuppressedAck(path, by)) return;
  const rs = state.get(path);
  if (!rs) return;
  if (consumeAck(rs, by)) settle(path, rs);
}

const finiteRev = (r: unknown): number | undefined =>
  typeof r === 'number' && Number.isFinite(r) ? r : undefined;

/** True when `next` is a provably older image than `cur` (both revs finite). */
function regresses(cur: NodeData | undefined, next: NodeData): boolean {
  if (!cur) return false;
  const a = finiteRev(cur.$rev);
  const b = finiteRev(next.$rev);
  return a !== undefined && b !== undefined && b < a;
}

/** Non-regressing, rebase-aware snapshot ingest (ns6p.4 §3.3, invariants 18/28)
 *  — every node arriving from a READ passes through here. Returns the image to
 *  place in cache: the kept cached image when the read raced a newer event
 *  (known rev > returned rev); the overlay replayed on the adopted confirmed
 *  base when pendings exist; otherwise the returned node itself. */
export function ingestNode(node: NodeData): NodeData {
  const path = node.$path;
  const rs = state.get(path);
  const known = rs ? rs.confirmed : cache.get(path);

  if (known !== undefined && regresses(known, node)) {
    return rs ? cache.get(path) ?? replayDraft(path, rs) : known;
  }

  if (!rs) return node;
  rs.confirmed = node;
  return replayDraft(path, rs);
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
  // Op already confirmed from the execute response — cache is authoritative;
  // re-applying (e.g. an array append) would double-apply (core-anz4.13).
  if (by !== undefined && consumeSuppressedAck(path, by)) return true;

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
  // Response-confirmed op (core-anz4.13): the refetch is at least as fresh as
  // this event's image — replay would regress the newer state.
  if (by !== undefined && consumeSuppressedAck(path, by)) return true;

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

/** Rebase state probe. With opId: is that exact op still unconfirmed — the
 *  ack-via-response gate in execute() (core-anz4.13). Without: any overlay. */
export function hasPending(path: string, opId?: string): boolean {
  const rs = state.get(path);
  if (!rs) return false;
  return opId === undefined || rs.pending.some(op => op.opId === opId);
}

/** Drop every overlay — continuity lost (reconnect preserved:false, core-jvfv) or test teardown */
export function clear(): void {
  state.clear();
  suppressedAcks.clear();
}
