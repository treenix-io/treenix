// Treenix Tree — Layer 1
// Storage interface + in-memory implementation
// Depends only on core types.

import { isRef, type NodeData, type Ref, toStorageKeys } from '#core';
import { OpError } from '#errors';
import sift from 'sift';
import { scanFromCollected } from './fs-common';
import { applyOps, hasMutationOps, type PatchOp } from './patch';

// ── Pagination ──

export type PageOpts = { limit?: number; offset?: number };
export type Page<T> = { items: T[]; total: number; truncated?: boolean; queryMount?: { source: string, match: Record<string, unknown> } };

export function paginate<T>(items: T[], opts?: PageOpts): Page<T> {
  const total = items.length;
  if (!opts?.limit) return { items, total };
  const offset = opts.offset ?? 0;
  return { items: items.slice(offset, offset + opts.limit), total };
}

// ── Interface ──

export type ChildrenOpts = { depth?: number; query?: Record<string, unknown>; watch?: boolean; watchNew?: boolean } & PageOpts;

export interface Tree {
  get(path: string, ctx?: unknown): Promise<NodeData | undefined>;
  getChildren(path: string, opts?: ChildrenOpts, ctx?: unknown): Promise<Page<NodeData>>;
  set(node: NodeData, ctx?: unknown): Promise<void>;
  remove(path: string, ctx?: unknown): Promise<boolean>;
  patch(path: string, ops: PatchOp[], ctx?: unknown): Promise<void>;
  /** Server-internal traversal primitive. Optional on the public Tree
   *  interface: the wire-facing tRPC remote tree cannot implement it
   *  (no streaming over RPC), but every server-side adapter and wrapper
   *  exposes it. `executeList` throws RESOURCE_EXHAUSTED-style at runtime
   *  if a non-source Tree slips into a server read path. */
  scanChildren?(
    path: string,
    opts?: ScanChildrenOpts,
    ctx?: unknown,
  ): AsyncIterable<ChildEntry>;
}

// ── TreeSource: server-internal traversal primitive ──
// scanChildren is the pull-based alternative to getChildren. It yields one
// ChildEntry per direct/descendant node within `opts.depth`. Used by the
// read-runtime (executeList) to drive ACL projection + caller-query
// filtering with cursor pagination. Never crosses the RPC boundary.

export type ChildEntry = {
  node: NodeData;
  /** Opaque adapter-defined token encoding the entry's position in the
   *  adapter's deterministic total order. Pass back as `opts.after` to
   *  resume strictly after this entry. */
  cursor: string;
};

export type ScanChildrenOpts = {
  depth?: number;
  /** Exclusive cursor. The next yield SHALL be strictly after this entry
   *  in the adapter's total order. */
  after?: string;
  /** Soft hint; runtime decides when to stop. Adapters MAY batch
   *  accordingly but MUST NOT truncate based on it alone. */
  limitHint?: number;
  /** Adapter-specific pushdown plan. Runtime passes whatever
   *  `buildScanPlan(plan, actor)` produced for this adapter. Unknown
   *  shape is ignored by adapters that don't pushdown. */
  scanPlan?: unknown;
  signal?: AbortSignal;
};

/** Tree narrowed to require `scanChildren` — server-internal read runtime
 *  uses this so callers express the dependency at the type level. Obtain
 *  one via `asTreeSource(tree)` or via adapters that always implement it
 *  (memory/fs/mimefs/combinators/pipeline wrappers). */
export type TreeSource = Tree & Required<Pick<Tree, 'scanChildren'>>;

/** Narrow a Tree to TreeSource. Throws if the tree doesn't expose
 *  `scanChildren` — the executeList path is server-side only and would
 *  silently break the no-fallback contract otherwise. */
export function asTreeSource(tree: Tree): TreeSource {
  if (!tree.scanChildren) {
    throw new OpError('BAD_REQUEST', 'Tree does not expose scanChildren — not usable as a source for the read runtime');
  }
  return tree as TreeSource;
}

// ── In-memory implementation ──

// ── Ref resolution ──

export async function resolveRef(tree: Tree, node: NodeData): Promise<NodeData> {
  if (!isRef(node)) return node;
  const target = await tree.get((node as unknown as Ref).$ref);
  if (!target) throw new Error(`Ref not found: ${(node as unknown as Ref).$ref}`);
  return target;
}

// ── Filter tree ──
// Like overlay, but set() routes to upper only when filter matches, else lower.
// Reads merge both layers (upper wins). Remove tries both.
// NOTE: limit/offset pagination is approximate — merging happens after both stores paginate.

export function createFilterTree(
  upper: Tree,
  lower: Tree,
  toUpper: (node: NodeData) => boolean,
): Tree {
  return {
    async get(path, ctx) {
      return (await upper.get(path, ctx)) ?? (await lower.get(path, ctx));
    },
    async getChildren(parent, opts, ctx) {
      const passthrough = opts ? { depth: opts.depth, query: opts.query, watch: opts.watch, watchNew: opts.watchNew } : undefined;
      const [u, l] = await Promise.all([
        upper.getChildren(parent, passthrough, ctx),
        lower.getChildren(parent, passthrough, ctx),
      ]);
      const byPath = new Map<string, NodeData>();
      for (const n of l.items) byPath.set(n.$path, n);
      for (const n of u.items) byPath.set(n.$path, n);
      const result = paginate([...byPath.values()], opts);
      // Forward queryMount from lower tree (mount system → CDC Matrix)
      if (l.queryMount) result.queryMount = l.queryMount;
      return result;
    },
    // Streaming k-way merge by $path cursor. Lazy: only pulls one entry
    // ahead from each side. Upper wins on path collision. Caller's `after`
    // is honored by each side; merger never re-yields.
    // Available only when BOTH sides expose scanChildren — Tree's scanChildren
    // is optional (wire-facing trees lack it), and silently degrading would
    // re-introduce the legacy-getChildren mixed-responsibilities path.
    async *scanChildren(parent, opts, ctx) {
      if (!upper.scanChildren || !lower.scanChildren) {
        throw new OpError('BAD_REQUEST', 'createFilterTree: scanChildren requires both layers to expose it');
      }
      const uIter = upper.scanChildren(parent, opts, ctx)[Symbol.asyncIterator]();
      const lIter = lower.scanChildren(parent, opts, ctx)[Symbol.asyncIterator]();
      let u = await uIter.next();
      let l = await lIter.next();
      while (!u.done || !l.done) {
        if (opts?.signal?.aborted) throw opts.signal.reason;
        if (u.done) { yield l.value!; l = await lIter.next(); continue; }
        if (l.done) { yield u.value!; u = await uIter.next(); continue; }
        const up = u.value!.node.$path;
        const lp = l.value!.node.$path;
        if (up === lp) { yield u.value!; u = await uIter.next(); l = await lIter.next(); }
        else if (up < lp) { yield u.value!; u = await uIter.next(); }
        else { yield l.value!; l = await lIter.next(); }
      }
    },
    async set(node, ctx) {
      if (toUpper(node)) await upper.set(node, ctx);
      else await lower.set(node, ctx);
    },
    async remove(path, ctx) {
      const a = await upper.remove(path, ctx);
      const b = await lower.remove(path, ctx);
      return a || b;
    },
    async patch(path, ops, ctx) {
      const node = await upper.get(path, ctx) ?? await lower.get(path, ctx);
      if (!node) throw new OpError('NOT_FOUND', `Node not found: ${path}`);
      const wasUpper = toUpper(node);

      // Apply ops to a copy to check if routing changes
      const patched = structuredClone(node);
      applyOps(patched, ops);
      const nowUpper = toUpper(patched);

      if (wasUpper === nowUpper) {
        // Same layer — patch in place
        if (wasUpper) await upper.patch(path, ops, ctx);
        else await lower.patch(path, ops, ctx);
      } else {
        // Routing changed — relocate: remove from old layer, set in new
        if (wasUpper) { await upper.remove(path, ctx); await lower.set(patched, ctx); }
        else { await lower.remove(path, ctx); await upper.set(patched, ctx); }
      }
    },
  };
}

// ── Overlay tree ──
// Reads: upper first, fall back to lower. Writes: upper only.
// Like createFilterTree(upper, lower, () => true) but remove only affects upper.

export function createOverlayTree(upper: Tree, lower: Tree): Tree {
  return {
    ...createFilterTree(upper, lower, () => true),
    async remove(path, ctx) {
      return upper.remove(path, ctx);
    },
  };
}

// ── Storage-key view of a node ──
// $-prefixed system keys ($path, $type, $acl, ...) become _-prefixed for
// storage matching (sift queries are pre-mapped by `mapSiftQuery`, so
// nodes must match the same form). Pure Layer-1 helper, no query knowledge.

export function mapNodeForSift(node: NodeData): Record<string, unknown> {
  return toStorageKeys(node);
}

// ── In-memory implementation ──

export type TreeNode<T> = {
  data?: T;
  children: Map<string, TreeNode<T>>;
};

export function treeNavigate<T>(root: TreeNode<T>, path: string): TreeNode<T> | undefined {
  if (path === '/') return root;
  const parts = path.slice(1).split('/');
  let node = root;
  for (const part of parts) {
    const child = node.children.get(part);
    if (!child) return undefined;
    node = child;
  }
  return node;
}

export function treeEnsure<T>(root: TreeNode<T>, path: string): TreeNode<T> {
  if (path === '/') return root;
  const parts = path.slice(1).split('/');
  let node = root;
  for (const part of parts) {
    let child = node.children.get(part);
    if (!child) {
      child = { children: new Map() } as TreeNode<T>;
      node.children.set(part, child);
    }
    node = child;
  }
  return node;
}

export function createMemoryTree(): TreeSource {
  const root: TreeNode<NodeData> = { children: new Map() };
  const navigate = (path: string) => treeNavigate(root, path);
  const ensurePath = (path: string) => treeEnsure(root, path);

  function collectChildren(
    node: TreeNode<NodeData>,
    parentPath: string,
    maxDepth: number,
    currentDepth: number = 1,
  ): NodeData[] {
    const result: NodeData[] = [];
    if (currentDepth > maxDepth) return result;

    for (const [name, child] of node.children) {
      if (child.data) result.push(child.data);
      if (currentDepth < maxDepth) {
        const childPath = parentPath === '/' ? `/${name}` : `${parentPath}/${name}`;
        result.push(...collectChildren(child, childPath, maxDepth, currentDepth + 1));
      }
    }
    return result;
  }

  return {
    async get(path, _ctx) {
      if (typeof path !== 'string') throw new Error(`tree.get: path must be string, got ${typeof path}`);
      const data = navigate(path)?.data;
      return data ? structuredClone(data) : data;
    },

    async getChildren(parent, opts, _ctx) {
      const node = navigate(parent);
      if (!node) return { items: [], total: 0 };
      const depth = opts?.depth ?? 1;
      let result = collectChildren(node, parent, depth);
      if (opts?.query) {
         const test = sift(opts.query);
         result = result.filter(n => test(mapNodeForSift(n)));
      }
      return paginate(result, opts);
    },

    // Clone upfront so the in-memory store stays isolated from caller
    // mutation; scanFromCollected owns sort/cursor/signal contract.
    async *scanChildren(parent, opts, _ctx) {
      const node = navigate(parent);
      if (!node) return;
      const cloned = collectChildren(node, parent, opts?.depth ?? 1).map(d => structuredClone(d));
      yield* scanFromCollected(cloned, opts);
    },

    async set(node, _ctx) {
      const treeNode = ensurePath(node.$path);

      if (node.$rev != null) {
        // OCC: caller knows about rev — must match stored
        const prevRev = treeNode.data?.$rev;
        if (node.$rev !== prevRev) {
          throw new OpError('CONFLICT', `OptimisticConcurrencyError: node ${node.$path} modified by another transaction. Expected $rev ${prevRev}, got ${node.$rev}`);
        }
      }

      node.$rev = (node.$rev ?? 0) + 1;
      treeNode.data = structuredClone(node);
    },

    async remove(path, _ctx) {
      const treeNode = navigate(path);
      if (!treeNode?.data) return false;
      treeNode.data = undefined;
      return true;
    },

    async patch(path, ops, _ctx) {
      const treeNode = navigate(path);
      if (!treeNode?.data) throw new OpError('NOT_FOUND', `Node not found: ${path}`);
      const copy = structuredClone(treeNode.data);
      applyOps(copy, ops);
      if (!hasMutationOps(ops)) return;
      copy.$rev = (copy.$rev ?? 0) + 1;
      treeNode.data = copy;
    },
  };
}

export { type PatchOp, type Rfc6902Op, PatchTestError, applyOps, assertSafePatchPath, toRfc6902, fromRfc6902, defaultPatch, hasMutationOps, patchViaSet } from './patch';
