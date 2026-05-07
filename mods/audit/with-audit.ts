// withAudit — Tree wrapper that records every mutation to /sys/audit/event.
// CONTRACT: synchronous in pipeline tick — if audit append fails, the original
// mutation also fails (loud). Caller sees error; server flips to unhealthy.
//
// Why a wrapper, not a CDC subscriber: subscribers run after tree.set commits,
// so a subscriber failure leaves a committed mutation without an audit record.
// A wrapper performs the write then immediately appends audit; failure of either
// step is loud. Not transactional against crashes (Phase 0 trade-off), but the
// "audit-backend-down → silent loss" mode is closed.

import type { ActorContext } from '@treenx/core/server/actions';
import type { NodeData } from '@treenx/core';
import type { Tree, PatchOp } from '@treenx/core/tree';
import { randomBytes } from 'node:crypto';
import { markUnhealthy } from './health';

const AUDIT_PREFIX = '/sys/audit/event/';

function isAuditWrite(path: string): boolean {
  return path.startsWith(AUDIT_PREFIX);
}

function eventPath(): string {
  // Sortable (lexicographic == temporal) + collision-resistant for parallel writes.
  return `${AUDIT_PREFIX}${Date.now()}-${randomBytes(4).toString('hex')}`;
}

type Op = 'set' | 'remove' | 'patch';

function buildEvent(args: {
  op: Op;
  path: string;
  before: NodeData | null;
  after: NodeData | null;
  ops?: PatchOp[];
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
  if (args.actor) {
    if (args.actor.id) ev.by = args.actor.id;
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

/** Wrap a Tree so every mutation appends an audit.event. Reads pass through.
 *  Direct writes to /sys/audit/event/* are NOT re-audited (recursion guard). */
export function withAudit(tree: Tree): Tree {
  return {
    get: tree.get.bind(tree),
    getChildren: tree.getChildren.bind(tree),

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
  };
}
