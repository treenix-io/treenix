// Branch mod — server side: mount adapter, control window, agent scope.
// Split from types.ts: this file pulls @treenx/core/security/* (node:crypto),
// which must never reach the browser bundle — types.ts + view.tsx are the
// client convention entries and stay isomorphic.

import { register, type NodeData } from '@treenx/core';
import { OpError } from '@treenx/core/errors';
import type { MountCtx } from '@treenx/core/mount';
import { buildClaims, withAcl } from '@treenx/core/security';
import { createProjector } from '@treenx/core/security/projector';
import { wrapReadOnlyTree } from '@treenx/core/server/readonly-tree';
import type { Tree } from '@treenx/core/tree';
import { createBranchTree } from '@treenx/core/tree/branch';
import { createRepathTree } from '@treenx/core/tree';
import { addTrashExempt } from '@treenx/core/tree/trash-exempt';
import { type AgentScope, defineAgentScope } from '#harness/capability';
import { BRANCH_SELF, MountBranch } from './types';

// core-anz4.7: the policy trash step judges a remove by its VIEW path — a
// branch-view remove would copy isolated branch content into the real
// /sys/trash. Branch removes hard-delete: the delta whiteout IS the safety copy.
addTrashExempt('/branches');

const parentOf = (p: string) => p.slice(0, p.lastIndexOf('/')) || '/';

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

// ── Mount adapter: the merged view at /branches/<id>/tree ──

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
