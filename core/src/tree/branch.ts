import { mapNodeForSift } from '#kernel/store/keys';
// Treenix Branch — Layer 1
// Write-isolated overlay: reads merge upper (delta) over lower (live),
// writes land in upper as wrapper nodes, deletions are whiteouts
// (union-mount lineage). Lower is never written.
//
// Delta wrapper carries the future node NESTED under `node` plus the
// shadowed live $rev as `baseRev` — nesting (instead of a bookkeeping
// component on the node itself) makes field collisions with user data
// structurally impossible. `baseRev` is captured on FIRST touch and kept
// across rewrites — merge (mods/branch) replays it as set($rev=baseRev)
// so storage OCC detects live drift.

import type { NodeData } from '#core';
import { KernelError } from '#errors';
import { createSiftTest } from '#kernel/expr';
import { DEFAULT_LIMITS } from '#kernel/types';
import { type Page, paginate, readWork, type Tree } from '#tree';
import { patchViaSet } from './patch';

export const BRANCH_DELTA_TYPE = 't.branch.delta';
export const BRANCH_WHITEOUT_TYPE = 't.branch.whiteout';

// Literal $type is the union discriminant: without it BranchDelta is a structural
// subtype of BranchWhiteout, and isBranchWhiteout() narrowing collapses the
// false branch to `never`.
export type BranchDelta = NodeData<{ baseRev: number | null; node: NodeData }> & { $type: typeof BRANCH_DELTA_TYPE };
export type BranchWhiteout = NodeData<{ baseRev: number | null }> & { $type: typeof BRANCH_WHITEOUT_TYPE };

export function isBranchDelta(n: NodeData): n is BranchDelta {
  return n.$type === BRANCH_DELTA_TYPE;
}

export function isBranchWhiteout(n: NodeData): n is BranchWhiteout {
  return n.$type === BRANCH_WHITEOUT_TYPE;
}

// Delta subtree is written exclusively by this combinator (ACL: owner+admins)
// — any other shape there is a bug, not user data. Throw, never skip.
function asWrapper(n: NodeData): BranchDelta | BranchWhiteout {
  if (isBranchDelta(n) || isBranchWhiteout(n)) return n;
  throw new KernelError('CONFLICT', `branch: foreign node in delta subtree at ${n.$path} ($type=${n.$type})`);
}

function unwrap(d: BranchDelta): NodeData {
  const inner = d.node;
  // Decode check at the storage boundary — wrapper content round-tripped
  // through an adapter, the type alone proves nothing.
  if (!inner || typeof inner !== 'object' || typeof inner.$type !== 'string') {
    throw new KernelError('CONFLICT', `branch: corrupt delta wrapper at ${d.$path}`);
  }
  // View identity: wrapper's path (already in view coordinates via repath)
  // and wrapper's storage $rev — gives clients a consistent OCC handle.
  return { ...inner, $path: d.$path, $rev: d.$rev };
}

/** Branch view over `lower`, capturing all writes in `upper`.
 *  Both trees MUST already speak view coordinates (repath them first).
 *  Lower MUST be read-only (wrapReadOnlyTree) — this combinator never
 *  writes it, the type system just can't prove it for callers. */
export function createBranchTree(upper: Tree, lower: Tree): Tree {
  const self: Tree = {
    async get(path, ctx) {
      const w = await upper.get(path, ctx);
      if (w) {
        const wrapper = asWrapper(w);
        return isBranchWhiteout(wrapper) ? undefined : unwrap(wrapper);
      }
      return lower.get(path, ctx);
    },

    async getChildren(parent, opts, ctx): Promise<Page<NodeData>> {
      const test = opts?.query ? createSiftTest(opts.query, DEFAULT_LIMITS) : null;
      const depth = opts?.depth;
      const u = await upper.getChildren(parent, { depth }, ctx);
      const wrappers = u.items.map(asWrapper);
      // Anything touched in the branch (rewritten OR whiteouted) shadows lower.
      const shadowed = new Set(wrappers.map(n => n.$path));
      // Query pushes down to lower untouched; upper wrappers can't match the
      // caller's query (future node is nested) — filter after unwrap instead.
      const work = readWork(opts);
      const l = await lower.getChildren(parent, { depth, query: opts?.query, work }, ctx);
      const items = [
        ...l.items.filter(n => !shadowed.has(n.$path)),
        ...wrappers.filter(isBranchDelta).map(unwrap)
          .filter(n => !test || test(mapNodeForSift(n), work)),
      ];
      const result = paginate(items, opts);
      return result;
    },

    // K-way merge by $path (both sides sort ASC — scanFromCollected contract).
    // Upper wins on collision; whiteouts consume the lower entry silently —
    // that's the one sanctioned filter (trust-boundary projection, same class
    // as ACL stripping). Cursor resume is NOT supported: upper/lower cursors
    // live in different inner namespaces (delta vs live) and repath passes
    // them through untranslated — resuming would silently skip or duplicate.
    // Fail loud until cursor layering lands (core-8an).
    async *scanChildren(parent, opts, ctx) {
      if (!upper.scanChildren || !lower.scanChildren) {
        throw new KernelError('INVALID', 'createBranchTree: scanChildren requires both layers to expose it');
      }
      if (opts?.after !== undefined) {
        throw new KernelError('INVALID', 'createBranchTree: cursor resume over a branch view is not supported (core-8an)');
      }
      const uIter = upper.scanChildren(parent, opts, ctx)[Symbol.asyncIterator]();
      const lIter = lower.scanChildren(parent, opts, ctx)[Symbol.asyncIterator]();
      try {
        let u = await uIter.next();
        let l = await lIter.next();
        while (!u.done || !l.done) {
          if (opts?.signal?.aborted) throw opts.signal.reason;
          if (u.done) {
            yield { node: l.value!.node, cursor: l.value!.node.$path };
            l = await lIter.next();
            continue;
          }
          const w = asWrapper(u.value!.node);
          const lp = l.done ? undefined : l.value!.node.$path;
          if (lp !== undefined && lp < w.$path) {
            yield { node: l.value!.node, cursor: lp };
            l = await lIter.next();
            continue;
          }
          if (isBranchDelta(w)) {
            const node = unwrap(w);
            yield { node, cursor: node.$path };
          }
          u = await uIter.next();
          if (lp === w.$path) l = await lIter.next(); // shadowed or whiteouted
        }
      } finally {
        await uIter.return?.();
        await lIter.return?.();
      }
    },

    async set(node, ctx) {
      const found = await upper.get(node.$path, ctx);
      const existing = found ? asWrapper(found) : undefined;
      // First touch reads lower once — both for baseRev capture and for
      // view-level OCC against the live rev.
      const lowerNode = existing ? undefined : await lower.get(node.$path, ctx);

      if (node.$rev != null) {
        const visibleRev = existing
          ? (isBranchWhiteout(existing) ? undefined : existing.$rev)
          : lowerNode?.$rev;
        if (visibleRev !== node.$rev) {
          throw new KernelError('CONFLICT', `branch: node ${node.$path} changed. Expected $rev ${visibleRev}, got ${node.$rev}`);
        }
      }

      const baseRev = existing ? existing.baseRev : (lowerNode?.$rev ?? null);
      const future = { ...node };
      delete future.$rev; // wrapper runs its own $rev lifecycle in delta storage

      const wrapper: BranchDelta = {
        $path: node.$path,
        $type: BRANCH_DELTA_TYPE,
        baseRev,
        node: future,
      };
      if (existing?.$rev != null) wrapper.$rev = existing.$rev;
      const upperReceipt = await upper.set(wrapper, ctx);

      // View-level receipt: the wrapper is a storage detail — report the
      // VIEW's change. before = what the view served pre-write; after = the
      // future node under the view's OCC identity (wrapper's new $rev).
      if (upperReceipt.changes === null) return { changes: null };
      const wrapperAfter = upperReceipt.changes[0]?.after;
      if (!wrapperAfter) throw new KernelError('CONFLICT', `branch: delta store returned no after image for ${node.$path}`);
      const before = existing
        ? (isBranchWhiteout(existing) ? null : unwrap(existing))
        : (lowerNode ?? null);
      return { changes: [{ path: node.$path, before, after: { ...future, $path: node.$path, $rev: wrapperAfter.$rev } }] };
    },

    // Whiteout-always (even for created-in-branch): after remove the path is
    // invisible regardless of what appears in live concurrently. A
    // create-then-delete leaves a baseRev:null whiteout — merge treats it as
    // a no-op, not a conflict.
    async remove(path, ctx) {
      const found = await upper.get(path, ctx);
      const existing = found ? asWrapper(found) : undefined;
      if (existing && isBranchWhiteout(existing)) return { changes: [] };
      const lowerNode = existing ? undefined : await lower.get(path, ctx);
      if (!existing && !lowerNode) return { changes: [] };

      const baseRev = existing ? existing.baseRev : (lowerNode?.$rev ?? null);
      const whiteout: BranchWhiteout = { $path: path, $type: BRANCH_WHITEOUT_TYPE, baseRev };
      if (existing?.$rev != null) whiteout.$rev = existing.$rev;
      // Mirror of set(): an opaque delta store must not become a falsely
      // authoritative view receipt.
      const upperReceipt = await upper.set(whiteout, ctx);
      if (upperReceipt.changes === null) return { changes: null };
      const before = existing ? unwrap(existing) : (lowerNode ?? null);
      return { changes: [{ path, before, after: null }] };
    },

    patch: (path, ops, ctx) => patchViaSet(self, path, ops, ctx),
  };

  return self;
}
