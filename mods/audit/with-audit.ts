// withAudit — Tree wrapper that records every mutation to /sys/audit/event.
// CONTRACT: synchronous in pipeline tick — if audit append fails, the original
// mutation also fails (loud). Caller sees error; server flips to unhealthy.
//
// Why a wrapper, not a CDC subscriber: subscribers run after tree.set commits,
// so a subscriber failure leaves a committed mutation without an audit record.
// A wrapper performs the write then immediately appends audit; failure of either
// step is loud. Not transactional against crashes (Phase 0 trade-off), but the
// "audit-backend-down → silent loss" mode is closed.

import type { ActorContext, DelegationHooks, DelegationInfo } from '@treenx/core/server/actions';
import type { NodeData } from '@treenx/core';
import { isSetEntry, type PatchManyEntry, type PatchOp, type Tree } from '@treenx/core/tree';
import { randomBytes } from 'node:crypto';
import { markHealthy, markUnhealthy, setRecoveryProbe } from './health';

const AUDIT_PREFIX = '/sys/audit/event/';

function isAuditWrite(path: string): boolean {
  return path.startsWith(AUDIT_PREFIX);
}

let lastTs = 0;
let seq = 0;

// 36^8 same-ms events (~2.8e12) — unreachable; overflow would break lexicographic order, so fail loud.
const SEQ_PAD = 8;
const SEQ_LIMIT = 36 ** SEQ_PAD;

export function eventPath(): string {
  // Sortable (lexicographic == temporal) + collision-resistant for parallel writes.
  // seq breaks same-millisecond ties — without it two appends in one ms sorted by
  // the RANDOM suffix, so a delegate-settled row could sort before its intent row.
  // Logical timestamp: never goes backwards even if Date.now() does (NTP rollback),
  // otherwise a rollback would reset seq and emit paths sorting before earlier rows.
  const ts = Math.max(Date.now(), lastTs);
  seq = ts === lastTs ? seq + 1 : 0;
  lastTs = ts;
  if (seq >= SEQ_LIMIT) throw new Error(`audit eventPath seq overflow at ts=${ts}`);
  return `${AUDIT_PREFIX}${ts}-${seq.toString(36).padStart(SEQ_PAD, '0')}-${randomBytes(4).toString('hex')}`;
}

type Op = 'set' | 'remove' | 'patch' | 'patchMany';

/** Per-member journal row for a patchMany batch — mirrors the PatchManyEntry
 *  union (gk8.10 stage 2): ops-member rows journal the ops, set-member rows
 *  the incoming node. Both carry before/after images (before=null on create). */
type AuditBatchEntry =
  | { path: string; ops: PatchOp[]; before: NodeData | null; after: NodeData | null }
  | { path: string; node: NodeData; before: NodeData | null; after: NodeData | null };

function buildEvent(args: {
  op: Op;
  path: string;
  before: NodeData | null;
  after: NodeData | null;
  ops?: PatchOp[];
  entries?: AuditBatchEntry[];
  actor?: ActorContext;
}): NodeData {
  const ev: NodeData = {
    $path: eventPath(),
    $type: 'audit.event',
    ts: Date.now(),
    op: args.op,
    path: args.path,
    before: args.before,
    after: args.after,
  };
  if (args.ops) ev.ops = args.ops;
  if (args.entries) ev.entries = args.entries;
  if (args.actor) {
    if (args.actor.id) ev.by = args.actor.id;
    if (args.actor.onBehalfOf) ev.onBehalfOf = args.actor.onBehalfOf;
    if (args.actor.taskPath) ev.taskPath = args.actor.taskPath;
    if (args.actor.runPath) ev.runPath = args.actor.runPath;
    if (args.actor.action) ev.action = args.actor.action;
    if (args.actor.requestId) ev.requestId = args.actor.requestId;
  }
  return ev;
}

async function appendOrFailLoud(tree: Tree, event: NodeData): Promise<void> {
  try {
    await tree.set(event);
    markHealthy(); // append works again → auto-heal (core-98jr)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    markUnhealthy(`audit append failed: ${msg}`);
    throw err;
  }
}

function getActor(ctx: unknown): ActorContext | undefined {
  if (ctx && typeof ctx === 'object' && 'actor' in ctx) {
    const a = (ctx as Record<string, unknown>).actor;
    if (a && typeof a === 'object' && 'id' in a) return a as ActorContext;
  }
  return undefined;
}

/** Delegation audit hooks (core-pa3m). A delegated execute (core-pxlu) commits
 *  on the REMOTE authority — the local write path never runs, so the mutation
 *  wrapper below sees nothing. These hooks journal the local user→action link
 *  instead: an intent row BEFORE the remote call (append failure rejects →
 *  withExecute aborts the delegation, fail closed) and a settled row after
 *  (append failure marks unhealthy; withExecute still returns the result — a
 *  remote commit cannot be rolled back). createPipeline calls this with the
 *  pre-wrap (subscribed) tree — same instance withAudit appends into. */
export function auditExecHooks(tree: Tree): DelegationHooks {
  function delegationEvent(op: 'delegate' | 'delegate-settled', info: DelegationInfo): NodeData {
    const ev: NodeData = {
      $path: eventPath(),
      $type: 'audit.event',
      ts: Date.now(),
      op,
      path: info.path,
      action: info.action,
      before: null,
      after: null,
    };
    if (info.userId) ev.by = info.userId;
    if (info.opId) ev.requestId = info.opId;
    return ev;
  }

  return {
    onDelegating: (info) => appendOrFailLoud(tree, delegationEvent('delegate', info)),
    onDelegatedSettled: (info) => {
      const ev = delegationEvent('delegate-settled', info);
      ev.ok = info.ok;
      if (!info.ok) ev.error = info.error instanceof Error ? info.error.message : String(info.error);
      return appendOrFailLoud(tree, ev);
    },
  };
}

/** Wrap a Tree so every mutation appends an audit.event. Reads pass through.
 *  Direct writes to /sys/audit/event/* are NOT re-audited (recursion guard). */
export function withAudit(tree: Tree): Tree {
  // Recovery probe (core-98jr): while unhealthy the 503 gate blocks the client
  // mutations whose appends would heal organically — so the gate probes with a
  // REAL append. A probe row lands only on success (~one per recovery), and
  // documents the outage end in the journal itself.
  setRecoveryProbe(() => tree.set({
    $path: eventPath(),
    $type: 'audit.event',
    ts: Date.now(),
    op: 'probe',
    path: '/sys/audit',
    before: null,
    after: null,
  }));
  // Spread forwards every read/traversal method untouched — get, getChildren,
  // and the OPTIONAL scanChildren/watch the read runtime depends on. Hand-listing
  // methods here previously dropped scanChildren, so asTreeSource threw for every
  // service reading through this wrap. Only the three mutating ops are overridden.
  return {
    ...tree,

    async set(node, ctx) {
      if (isAuditWrite(node.$path)) return tree.set(node, ctx);
      const before = (await tree.get(node.$path, ctx)) ?? null;
      await tree.set(node, ctx);
      const event = buildEvent({ op: 'set', path: node.$path, before, after: node, actor: getActor(ctx) });
      await appendOrFailLoud(tree, event);
    },

    async remove(path, ctx) {
      if (isAuditWrite(path)) return tree.remove(path, ctx);
      const before = (await tree.get(path, ctx)) ?? null;
      const ok = await tree.remove(path, ctx);
      if (ok) {
        const event = buildEvent({ op: 'remove', path, before, after: null, actor: getActor(ctx) });
        await appendOrFailLoud(tree, event);
      }
      return ok;
    },

    async patch(path, ops: PatchOp[], ctx) {
      if (isAuditWrite(path)) return tree.patch(path, ops, ctx);
      const before = (await tree.get(path, ctx)) ?? null;
      await tree.patch(path, ops, ctx);
      const after = (await tree.get(path, ctx)) ?? null;
      const event = buildEvent({ op: 'patch', path, before, after, ops, actor: getActor(ctx) });
      await appendOrFailLoud(tree, event);
    },

    // patchMany (core-gk8.15): explicit interception — the `...tree` spread
    // would forward this mutation class UN-journaled otherwise. ONE row covers
    // the whole batch: op 'patchMany' at the ancestor, per-member ops +
    // before/after images under `entries`. Batch containment means an
    // audit-subtree ancestor covers every member — recursion guard on it.
    ...(tree.patchMany ? {
      async patchMany(ancestor: string, entries: PatchManyEntry[], ctx?: unknown) {
        if (isAuditWrite(ancestor)) return tree.patchMany!(ancestor, entries, ctx);

        const befores: (NodeData | null)[] = [];
        for (const e of entries) befores.push((await tree.get(e.path, ctx)) ?? null);

        await tree.patchMany!(ancestor, entries, ctx);

        const rows: AuditBatchEntry[] = [];
        for (let i = 0; i < entries.length; i++) {
          const entry = entries[i];
          const before = befores[i];
          const after = (await tree.get(entry.path, ctx)) ?? null;
          rows.push(isSetEntry(entry)
            ? { path: entry.path, node: entry.node, before, after }
            : { path: entry.path, ops: entry.ops, before, after });
        }
        const event = buildEvent({ op: 'patchMany', path: ancestor, before: null, after: null, entries: rows, actor: getActor(ctx) });
        await appendOrFailLoud(tree, event);
      },
    } : {}),
  };
}
