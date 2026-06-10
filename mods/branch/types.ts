// Branch mod — write-isolated futures over the live tree.
// Overlay mechanics live in @treenx/core/tree/branch (Layer 1); this mod owns
// the node types, the mount adapter and the lifecycle actions.
// Lifecycle: create → work under /branches/<id>/tree → diff →
// requestMerge (human reviews) → merge | abandon.

import { A, makeNode, type NodeData, R, register, S, W } from '@treenx/core';
import { getCtx, registerType } from '@treenx/core/comp';
import { OpError } from '@treenx/core/errors';
import type { MountCtx } from '@treenx/core/mount';
import type { ActorContext } from '@treenx/core/server/actions';
import { buildClaims, withAcl } from '@treenx/core/security/auth';
import { createProjector } from '@treenx/core/security/projector';
import { wrapReadOnlyTree } from '@treenx/core/server/readonly-tree';
import type { Tree } from '@treenx/core/tree';
import { createBranchTree, isBranchDelta, isBranchWhiteout } from '@treenx/core/tree/branch';
import { createRepathTree } from '@treenx/core/tree/repath';
import { type AgentScope, defineAgentScope } from '#harness/capability';

export type BranchStatus = 'open' | 'review' | 'merged' | 'conflict' | 'abandoned';

export type DiffEntry = {
  /** Live target path (branch base + path inside the view). */
  path: string;
  op: 'create' | 'set' | 'remove' | 'noop';
  baseRev: number | null;
  /** Future node for create/set. */
  node?: NodeData;
};

export type ConflictEntry = { path: string; expectedRev: number | null; actualRev: number | null };

const parentOf = (p: string) => p.slice(0, p.lastIndexOf('/')) || '/';

// Actions invoked through the /.branch control window carry the WINDOW path as
// node identity; delta/live live at the real branch path. (Branch-rooted
// sessions cannot reach the delta at all — their /.branch executes are
// re-targeted to the real path by the MCP layer before they get here.)
const SELF_SUFFIX = '/tree/.branch';

function realBranchPath(nodePath: string): string {
  return nodePath.endsWith(SELF_SUFFIX) ? nodePath.slice(0, -SELF_SUFFIX.length) : nodePath;
}

// Thread the action's actor into tree writes so withAudit records the span
// (one requestId per merge). Structural check + boundary cast — ExecCtx keys
// are untyped (same decode pattern as audit's getActor).
function actorCtxOf(ctx: { [k: string]: unknown }): { actor: ActorContext } | undefined {
  const a = ctx.actor;
  if (a && typeof a === 'object' && 'id' in a) return { actor: a as ActorContext };
  return undefined;
}

// Shared by diff/merge — action methods run on an Immer draft of node DATA
// (class methods are not callable via `this` there).
async function collectDiff(tree: Tree, branchPath: string, base: string): Promise<DiffEntry[]> {
  const deltaRoot = `${branchPath}/delta`;
  if (!tree.scanChildren) {
    throw new OpError('BAD_REQUEST', 'branch.diff requires a tree with scanChildren');
  }

  const entries: DiffEntry[] = [];
  for await (const { node: w } of tree.scanChildren(deltaRoot, { depth: -1 })) {
    const rest = w.$path.slice(deltaRoot.length);
    const livePath = base === '/' ? (rest || '/') : base + rest;
    if (isBranchWhiteout(w)) {
      entries.push({ path: livePath, op: w.baseRev === null ? 'noop' : 'remove', baseRev: w.baseRev });
    } else if (isBranchDelta(w)) {
      entries.push({
        path: livePath,
        op: w.baseRev === null ? 'create' : 'set',
        baseRev: w.baseRev,
        node: { ...w.node, $path: livePath },
      });
    } else {
      throw new OpError('CONFLICT', `branch: foreign node in delta subtree at ${w.$path} ($type=${w.$type})`);
    }
  }
  return entries;
}

/** Container at /branches — branches are created through it, never by hand. */
export class Branches {
  /** @description Create a branch: t.branch node + delta store + mounted view */
  async create(data?: { title?: string; owner?: string; base?: string }) {
    const ctx = getCtx();
    const callerUserId = typeof ctx.userId === 'string' ? ctx.userId : undefined;
    const owner = data?.owner ?? callerUserId;
    if (!owner) throw new OpError('BAD_REQUEST', 'branch owner required (no session user and no explicit owner)');

    const id = `b-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const path = `${ctx.node.$path}/${id}`;

    const branchNode = makeNode(path, 't.branch', {
      base: data?.base ?? '/',
      owner,
      status: 'open' as const,
      title: data?.title ?? '',
      createdAt: Date.now(),
      mergedAt: 0,
      conflicts: [] as ConflictEntry[],
    });
    branchNode.$acl = [
      { g: 'admins', p: R | W | A | S },
      { g: `u:${owner}`, p: R | W | A | S },
    ];
    await ctx.tree.set(branchNode);
    await ctx.tree.set(makeNode(`${path}/delta`, 'dir'));
    await ctx.tree.set(makeNode(`${path}/tree`, 'dir', undefined, {
      '#mount': { $type: 't.mount.branch' },
    }));
    return { path };
  }
}

/** A write-isolated future. Work happens under `<path>/tree`; every write is
 *  captured under `<path>/delta` and the live tree stays untouched until merge. */
export class Branch {
  base = '/';
  owner = '';
  status: BranchStatus = 'open';
  title = '';
  createdAt = 0;
  mergedAt = 0;
  conflicts: ConflictEntry[] = [];

  /** @description List the branch's changes against live (does not mutate) */
  async diff(): Promise<{ entries: DiffEntry[] }> {
    const ctx = getCtx();
    return { entries: await collectDiff(ctx.tree, realBranchPath(ctx.node.$path), this.base) };
  }

  /** @description Close the branch without merging. Delta stays as the record. */
  abandon() {
    if (this.status === 'merged') throw new OpError('CONFLICT', 'cannot abandon a merged branch');
    this.status = 'abandoned';
  }

  /** @description Mark the branch ready for human review and merge.
   *  Status is the source of truth; the approval inbox entry is filed by the
   *  orchestrator watcher (fileMergeApprovals) as a REACTION to status=review —
   *  a dual write from here would land in the branch's own delta when invoked
   *  through a branch-rooted session (/.branch). */
  requestMerge(data?: { note?: string }) {
    if (this.status !== 'open') {
      throw new OpError('CONFLICT', `cannot request merge in status "${this.status}"`);
    }
    if (data?.note) this.title = this.title ? `${this.title} — ${data.note}` : data.note;
    this.status = 'review';
    return { status: 'review' as const };
  }

  /** @description Merge the branch into live. Run by an approver — agents hold
   *  no live W, so the human invoking this IS the gate. Preflight checks every
   *  entry against its captured baseRev; any mismatch reports conflicts and
   *  applies NOTHING. */
  async merge() {
    if (this.status !== 'open' && this.status !== 'review') {
      throw new OpError('CONFLICT', `cannot merge branch in status "${this.status}"`);
    }
    const ctx = getCtx();
    const entries = await collectDiff(ctx.tree, realBranchPath(ctx.node.$path), this.base);

    const conflicts: ConflictEntry[] = [];
    for (const e of entries) {
      const live = await ctx.tree.get(e.path);
      const actualRev = live?.$rev ?? null;
      const ok = (e.op === 'create' || e.op === 'noop')
        ? live === undefined
        : actualRev === e.baseRev;
      if (!ok) conflicts.push({ path: e.path, expectedRev: e.baseRev, actualRev });
    }
    if (conflicts.length) {
      this.status = 'conflict';
      this.conflicts = conflicts;
      return { merged: 0, applied: [] as string[], conflicts };
    }

    // Apply with $rev = baseRev so storage OCC re-checks each set. A writer can
    // still slip between preflight and apply (single-process window, see
    // branches-plan.md) — that surfaces as CONFLICT mid-apply below.
    const applied: string[] = [];
    let current: DiffEntry | undefined;
    const writeCtx = actorCtxOf(ctx); // one requestId across the whole span
    try {
      for (const e of entries) {
        if (e.op === 'noop') continue;
        current = e;
        if (e.op === 'remove') {
          await ctx.tree.remove(e.path, writeCtx);
        } else {
          const future = e.node;
          if (!future) throw new OpError('CONFLICT', `merge: entry ${e.path} is missing its node`);
          const node: NodeData = { ...future, $path: e.path };
          if (e.baseRev !== null) node.$rev = e.baseRev;
          await ctx.tree.set(node, writeCtx);
        }
        applied.push(e.path);
      }
    } catch (err) {
      // OCC slip is the expected race — report it; applied entries stay live
      // and journaled, re-merge re-preflights the remainder. Anything else is
      // a real failure and rethrows.
      if (err instanceof OpError && err.code === 'CONFLICT' && current) {
        const live = await ctx.tree.get(current.path);
        this.status = 'conflict';
        this.conflicts = [{ path: current.path, expectedRev: current.baseRev, actualRev: live?.$rev ?? null }];
        return { merged: applied.length, applied, conflicts: this.conflicts };
      }
      throw err;
    }

    this.status = 'merged';
    this.mergedAt = Date.now();
    this.conflicts = [];
    return { merged: applied.length, applied, conflicts: [] as ConflictEntry[] };
  }
}

/** Workload scope bound to a branch: plan = read-only live, work = full speed
 *  inside the branch. allowedExec '*' is safe here — writePaths bind every
 *  action target AND the handler's ctx.tree to the branch (confused-deputy
 *  guard in executeWithCapability), so even `merge` invoked by the owner dies
 *  on its first live write. */
export function branchScope(branchPath: string): AgentScope {
  return defineAgentScope({
    plan: { read: ['*'], write: [], exec: [] },
    work: { read: ['*'], write: [branchPath, `${branchPath}/*`], exec: ['*'] },
  });
}

registerType('t.branches', Branches);
registerType('t.branch', Branch);

// ── Mount adapter: the merged view at /branches/<id>/tree ──

export class MountBranch {}
registerType('t.mount.branch', MountBranch);

// Recursion + privacy guard: /branches must not exist inside a branch view —
// otherwise view paths nest (/tree/branches/<id>/tree/...) and branches read
// each other. Namespace shaping at a trust boundary (same sanctioned class as
// ACL stripping); documented here precisely because we never filter elsewhere.
function guardSubtree(inner: Tree, deniedRoot: string): Tree {
  const denied = (p: string) => p === deniedRoot || p.startsWith(deniedRoot + '/');
  const deny = (p: string): never => {
    throw new OpError('FORBIDDEN', `branch view: ${p} is outside the branch namespace`);
  };
  return {
    ...inner,
    async get(path, ctx) {
      if (denied(path)) deny(path);
      return inner.get(path, ctx);
    },
    async getChildren(path, opts, ctx) {
      if (denied(path)) deny(path);
      const page = await inner.getChildren(path, opts, ctx);
      const items = page.items.filter(n => !denied(n.$path));
      return { ...page, items, total: items.length };
    },
    ...(inner.scanChildren ? {
      async *scanChildren(path: string, opts?: Parameters<NonNullable<Tree['scanChildren']>>[1], ctx?: unknown) {
        if (denied(path)) deny(path);
        for await (const e of inner.scanChildren!(path, opts, ctx)) {
          if (!denied(e.node.$path)) yield e;
        }
      },
    } : {}),
  };
}

// ── /.branch — the branch's own control window (Plan9 /proc/self) ──
// Data plane (overlay) and control plane (branch lifecycle) are different
// planes: a requestMerge routed through the overlay would change status only
// inside the branch's own delta. The window proxies the reserved view path
// <mount>/.branch to the REAL t.branch node, bypassing the overlay, so a
// branch-rooted agent can read its status and run diff/requestMerge/abandon.
export const BRANCH_SELF = '.branch';

function withControlWindow(view: Tree, store: Tree, branchPath: string, mountPath: string): Tree {
  const SELF = `${mountPath}/${BRANCH_SELF}`;

  async function selfNode(c?: unknown): Promise<NodeData | undefined> {
    const real = await store.get(branchPath, c);
    return real ? { ...real, $path: SELF } : undefined;
  }

  return {
    ...view,
    async get(path, c) {
      if (path === SELF) return selfNode(c);
      return view.get(path, c);
    },
    async getChildren(path, opts, c) {
      const page = await view.getChildren(path, opts, c);
      if (path === mountPath) {
        const self = await selfNode(c);
        if (self) {
          page.items = [self, ...page.items];
          page.total += 1;
        }
      }
      return page;
    },
    ...(view.scanChildren ? {
      async *scanChildren(path: string, opts?: Parameters<NonNullable<Tree['scanChildren']>>[1], c?: unknown) {
        // '.' (0x2e) sorts before alphanumerics — prepending keeps ASC order.
        if (path === mountPath) {
          const self = await selfNode(c);
          if (self) yield { node: self, cursor: self.$path };
        }
        yield* view.scanChildren!(path, opts, c);
      },
    } : {}),
    async set(node, c) {
      if (node.$path === SELF) return store.set({ ...node, $path: branchPath }, c);
      return view.set(node, c);
    },
    async patch(path, ops, c) {
      if (path === SELF) return store.patch(branchPath, ops, c);
      return view.patch(path, ops, c);
    },
    async remove(path, c) {
      if (path === SELF) throw new OpError('FORBIDDEN', 'the branch control node cannot be removed from inside the view');
      return view.remove(path, c);
    },
  };
}

register(MountBranch, 'mount', async (_mount, ctx: MountCtx) => {
  const branchPath = parentOf(ctx.path);
  const branchesRoot = parentOf(branchPath);
  const store = ctx.globalStore ?? ctx.parentStore;

  const branchNode = await store.get(branchPath);
  if (!branchNode) throw new OpError('NOT_FOUND', `t.mount.branch: no t.branch node at ${branchPath}`);
  const { owner, base } = branchNode;
  if (typeof owner !== 'string' || !owner) {
    throw new OpError('BAD_REQUEST', `t.mount.branch: ${branchPath} has no owner`);
  }
  if (typeof base !== 'string' || !base.startsWith('/')) {
    throw new OpError('BAD_REQUEST', `t.mount.branch: ${branchPath} has invalid base`);
  }

  // Owner-projected lower — load-bearing: mount adapters are caller-blind and
  // the outer per-user ACL checks only VIEW paths, so without projection a
  // branch would read live paths its owner cannot see (privilege escalation).
  // Everyone reviewing the branch sees the owner's projection of live.
  const claims = await buildClaims(store, owner);
  const acl = withAcl(store, owner, claims);
  // AclStore has no scanChildren — add one via the same per-node projector
  // executeList uses (null = no R, skip: sanctioned ACL strip).
  const projector = createProjector(store, { userId: owner, claims });
  const projected: Tree = {
    ...acl,
    async *scanChildren(path, opts, innerCtx) {
      if (!store.scanChildren) {
        throw new OpError('BAD_REQUEST', 't.mount.branch: backing store lacks scanChildren');
      }
      for await (const e of store.scanChildren(path, opts, innerCtx)) {
        const visible = await projector(e.node);
        if (visible) yield { node: visible, cursor: e.cursor };
      }
    },
  };

  const lower = createRepathTree(wrapReadOnlyTree(guardSubtree(projected, branchesRoot)), ctx.path, base);
  const upper = createRepathTree(store, ctx.path, `${branchPath}/delta`);
  return withControlWindow(createBranchTree(upper, lower), store, branchPath, ctx.path);
});
