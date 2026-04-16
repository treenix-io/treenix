// Treenity Tree — Layer 1
// Storage interface + in-memory implementation
// Depends only on core types.

import { isRef, type NodeData, type Ref, toStorageKeys } from '#core';
import { OpError } from '#errors';
import sift from 'sift';
import { applyOps, defaultPatch, type PatchOp } from './patch';

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

// ── In-memory implementation ──

function mapNodeForSift(node: NodeData): Record<string, unknown> {
  return toStorageKeys(node);
}

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

export function createMemoryTree(): Tree {
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
      copy.$rev = (copy.$rev ?? 0) + 1;
      treeNode.data = copy;
    },
  };
}

export { type PatchOp, type Rfc6902Op, PatchTestError, applyOps, toRfc6902, fromRfc6902, defaultPatch, patchViaSet } from './patch';
