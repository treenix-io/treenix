// Branch mod — write-isolated futures over the live tree.
// Overlay mechanics live in @treenx/core/tree/branch (Layer 1); this mod owns
// the node types, the mount adapter and the lifecycle actions.
// Lifecycle: create → work under /branches/<id>/tree → diff → abandon
// (merge + requestMerge land in S3, core-wm6.3).

import { A, makeNode, type NodeData, R, register, S, W } from '@treenx/core';
import { getCtx, registerType } from '@treenx/core/comp';
import { OpError } from '@treenx/core/errors';
import type { MountCtx } from '@treenx/core/mount';
import { buildClaims, withAcl } from '@treenx/core/security/auth';
import { createProjector } from '@treenx/core/security/projector';
import { wrapReadOnlyTree } from '@treenx/core/server/readonly-tree';
import type { Tree } from '@treenx/core/tree';
import { createBranchTree, isBranchDelta, isBranchWhiteout } from '@treenx/core/tree/branch';
import { createRepathTree } from '@treenx/core/tree/repath';

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
      mount: { $type: 't.mount.branch' },
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
    const deltaRoot = `${ctx.node.$path}/delta`;
    if (!ctx.tree.scanChildren) {
      throw new OpError('BAD_REQUEST', 'branch.diff requires a tree with scanChildren');
    }

    const entries: DiffEntry[] = [];
    for await (const { node: w } of ctx.tree.scanChildren(deltaRoot, { depth: -1 })) {
      const rest = w.$path.slice(deltaRoot.length);
      const livePath = this.base === '/' ? (rest || '/') : this.base + rest;
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
    return { entries };
  }

  /** @description Close the branch without merging. Delta stays as the record. */
  abandon() {
    if (this.status === 'merged') throw new OpError('CONFLICT', 'cannot abandon a merged branch');
    this.status = 'abandoned';
  }
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
  return createBranchTree(upper, lower);
});
