// Treenix Mount — Layer 4
// Mount = component on node. Adapter resolved via context system.
// Core untouched. Tree interface preserved.

import { type ComponentData, getComponentByName, isComponent, isRef, type NodeData, resolve } from '#core';
import { OpError } from '#errors';
import { assertPatchManyBatch, isSetEntry, type Tree } from '#tree';
import { TRASH_ROOT } from '#tree/policy';
import { createBoundedCache } from '#util/bounded-cache';

// core-anz4.8: /sys/trash/** is mount-INERT. A trashed node keeps its mount
// component, but under the trash prefix it is plain stored data — resolving it
// would let GC activate the mount, enumerate and DELETE external adapter
// content. Inertness is by-prefix (not by stripping the component): after
// restore the node returns to a normal path and the mount activates again.
function isTrashInert(path: string): boolean {
  return path === TRASH_ROOT || path.startsWith(TRASH_ROOT + '/');
}

/** The node's mount config when ACTIVE: present, not disabled, not trash-inert.
 *  The one activation rule for withMounts and the ACL read planner
 *  (resolve-plan.ts) — two diverging copies let a disabled or trashed query
 *  mount still drive reads, and trash GC hard-deleted the live view. */
export function activeMount(node: NodeData): ComponentData | undefined {
  if (isTrashInert(node.$path)) return undefined;
  const mount = getComponentByName(node, 'mount');
  return mount && !mount.disabled ? mount : undefined;
}

// ── Adapter contract ──
// Lives here (not in mount-adapters.ts) so that mount.ts and adapters share
// one definition. mount-adapters.ts handles registrations only.

export type MountCtx = {
  node: NodeData;
  path: string;
  parentStore: Tree;
  globalStore?: Tree;
  /** Mount adapter callback: wire an external watch source (Mongo change
   *  stream, FS watch, REST webhook) into the subscription bus. Available
   *  only when the host pipeline supplied a `startExternalWatch` to
   *  `withMounts`. The adapter is responsible for computing `pathPrefix`
   *  (mount root for non-shared mounts, '/' for shared). Returns an abort
   *  function — withMounts tracks it per mount cache key and calls it
   *  on mount invalidation. */
  startExternalWatch?: ExternalWatchStarter;
};

export type ExternalWatchStarter = (
  tree: Tree,
  opts: { pathPrefix: string; dedupWindowMs?: number; source: string },
) => () => void;

export type WithMountsOpts = {
  startExternalWatch?: ExternalWatchStarter;
  /** Max entries in the per-user mount resolution cache. FIFO eviction.
   *  Default 1000 — generous for typical multi-tenant deployments where
   *  the same handful of mount points are accessed by many users. Raise
   *  if you observe high cache miss rate on a hot mount. */
  cacheMax?: number;
};

/** withMounts return type — exposes `invalidateMount` so external-watch
 *  consumers can evict cached adapters when a mount config node is rewritten
 *  out-of-band. In-pipeline writes invalidate automatically (set/remove/patch). */
export type MountableTree = Tree & {
  invalidateMount(path: string): void;
  /** Resolve the mounted subtree owning `path` IF it is a foreign authority —
   *  i.e. the adapter tree exposes the `execute` capability (transport mounts:
   *  t.mount.tree.trpc, future t.mount.peer). Storage mounts (memory/fs/mongo/
   *  query) and unmounted paths return undefined → the action runs in the
   *  LOCAL executor. Strict ancestors only (an action addressed at the mount
   *  node itself targets the local config node). ctx carries `{userId}` bound
   *  by withExecute — never from request data — so the per-user mount cache
   *  keys correctly (core-pxlu). */
  resolveActionTree(path: string, ctx?: unknown): Promise<Tree | undefined>;
};

export type MountAdapter<T = unknown> = (mount: T, ctx: MountCtx) => Tree | Promise<Tree>;

declare module '#core/context' {
  interface ContextHandlers<T> {
    mount: MountAdapter<T>;
  }
}

export async function resolveAdapter(mount: ComponentData, mountCtx: MountCtx): Promise<Tree> {
  const adapter = resolve(mount.$type, 'mount');
  if (!adapter) throw new Error(`No mount adapter for "${mount.$type}"`);
  return await adapter(mount, mountCtx);
}

// ── Mountable Tree ──

const DEFAULT_MOUNT_CACHE = 1000;

type MountCacheEntry = { tree: Tree; refTarget?: string; externalAbort?: () => void };

export function withMounts(rootStore: Tree, opts?: WithMountsOpts): MountableTree {
  // onEvict aborts any external-watch consumer attached to the cache entry
  // — covers both explicit invalidation AND FIFO eviction (otherwise leaks
  // change-stream cursors, dedup timers, onSelfWrite subscriptions).
  const cache = createBoundedCache<string, MountCacheEntry>(
    opts?.cacheMax ?? DEFAULT_MOUNT_CACHE,
    {
      onEvict: (entry) => {
        if (entry.externalAbort) entry.externalAbort();
      },
    },
  );

  /** Invalidate cache for path and all descendants (nested mounts under it).
   *  bounded-cache onEvict fires per entry, releasing any external-watch
   *  consumer the adapter started — no parallel bookkeeping needed. */
  function invalidateMount(path: string): void {
    if (cache.size === 0) return;
    cache.deleteWhere((entry, key) => {
      // key may have ?uid= suffix — extract the path part
      const keyPath = key.split('?')[0];
      return isSameOrDescendant(keyPath, path)
        || (!!entry.refTarget && isSameOrDescendant(entry.refTarget, path));
    });
  }

  function isSameOrDescendant(candidate: string, path: string): boolean {
    if (path === '/') return true;
    return candidate === path || candidate.startsWith(path + '/');
  }

  const self: MountableTree = {
    invalidateMount,

    async resolveActionTree(path, ctx) {
      const tree = await resolveNodeTree(path, ctx);
      // Capability presence = authority marker. No exceptions as control flow.
      return tree.execute ? tree : undefined;
    },

    async get(path, ctx) {
      const tree = await resolveNodeTree(path, ctx);
      return tree.get(path, ctx);
    },

    async getChildren(path, opts, ctx) {
      const tree = await resolveContentTree(path, ctx);
      return tree.getChildren(path, opts, ctx);
    },

    // scanChildren dispatch — same per-path resolution as getChildren, but
    // streams. Legacy Tree-only adapters (no native scanChildren) fall back
    // to getChildren paging wrapped as an async generator — this keeps
    // remote/Mongo Tree-only mounts LISTABLE through the ACL/public path
    // (core-35t). The fallback CANNOT honor `after`: it always restarts from
    // the first page, so a cursor-paginating caller would silently get
    // duplicated/restarted pages (C13) — fail loud instead.
    async *scanChildren(path, opts, ctx) {
      const tree = await resolveContentTree(path, ctx);
      if (tree.scanChildren) {
        yield* tree.scanChildren(path, opts, ctx);
        return;
      }
      if (opts?.after !== undefined) {
        throw new OpError('BAD_REQUEST', `scanChildren: mount at ${path} is a Tree-only adapter without cursor support — 'after' pagination unavailable; migrate the adapter to native scanChildren`);
      }
      // limitHint is a batching hint only — it MUST NOT truncate the stream
      // (core-anz4.16: downstream ACL/query filters drop rows, so a single
      // limitHint-sized page under-reports). Page via nextCursor until the
      // source is exhausted; the lazy generator stops fetching once the
      // consumer stops pulling.
      let cursor: string | undefined;
      const seen = new Set<string>();
      do {
        if (opts?.signal?.aborted) throw opts.signal.reason;
        if (cursor !== undefined) seen.add(cursor);
        const page = await tree.getChildren(path, { depth: opts?.depth, limit: opts?.limitHint, cursor }, ctx);
        for (const node of page.items) {
          yield { node, cursor: node.$path };
        }
        const next = page.nextCursor;
        // core-anz4.16: a legacy adapter returning a repeating/cyclic nextCursor
        // would loop forever — fail loud on the adapter-contract violation.
        if (next !== undefined && seen.has(next)) {
          throw new OpError('BAD_REQUEST', `scanChildren: mount at ${path} returned a repeating nextCursor "${next}" — cyclic pagination from a Tree-only adapter`);
        }
        cursor = next;
      } while (cursor !== undefined);
    },

    async set(node, ctx) {
      const tree = await resolveNodeTree(node.$path, ctx);
      invalidateMount(node.$path);
      return tree.set(node, ctx);
    },

    async remove(path, ctx) {
      const tree = await resolveNodeTree(path, ctx);
      invalidateMount(path);
      return tree.remove(path, ctx);
    },

    async patch(path, ops, ctx) {
      const tree = await resolveNodeTree(path, ctx);
      invalidateMount(path);
      return tree.patch(path, ops, ctx);
    },

    // patchMany (core-gk8.15): batch containment (asserted BEFORE resolution —
    // a non-contained entry would misroute) pins every member at-or-under
    // `ancestor`, so ONE resolution — the same set/patch use — owns the whole
    // batch. Forward only when the resolved tree carries the capability; a
    // silent per-member fallback loop would break atomicity.
    async patchMany(ancestor, entries, ctx) {
      assertPatchManyBatch(ancestor, entries);
      const tree = await resolveNodeTree(ancestor, ctx);
      if (!tree.patchMany) {
        throw new OpError('BAD_REQUEST', `patchMany: target tree at ${ancestor} does not support patchMany`);
      }
      // A set-member may CREATE: if its path lives under a nested mount below
      // `ancestor`, forwarding to the ancestor's tree would silently create a
      // shadowed node in the outer store (an ops-member merely fails NOT_FOUND
      // there). Only set-members pay the extra per-path resolution.
      for (const e of entries) {
        if (isSetEntry(e) && await resolveNodeTree(e.path, ctx) !== tree) {
          throw new OpError('BAD_REQUEST', `patchMany: set-member ${e.path} crosses a mount boundary under ${ancestor}`);
        }
      }
      for (const e of entries) invalidateMount(e.path);
      return tree.patchMany(ancestor, entries, ctx);
    },
  };

  /** Check if node's mount component resolves to a known adapter */
  function isMountPoint(node: NodeData): boolean {
    const mount = activeMount(node);
    if (!mount) return false;
    // Refs need resolution — treat as mount-point optimistically
    if (isRef(mount)) return true;
    const adapter = resolve(mount.$type, 'mount');
    if (!adapter) throw new Error(`No adapter for type "${mount.$type}"`);
    return true;
  }

  function mountRefTarget(node: NodeData): string | undefined {
    const mount = getComponentByName(node, 'mount');
    return isRef(mount) ? mount.$ref : undefined;
  }

  // Per-user keying — different users may see different mount targets due
  // to per-user ACL on the mount node's ref.
  function mountCacheKey(path: string, ctx?: unknown): string {
    const userId = (ctx as { userId?: string } | undefined)?.userId;
    return userId ? `${path}?uid=${userId}` : path;
  }

  function cacheMount(
    path: string,
    node: NodeData,
    tree: Tree,
    externalAbort: (() => void) | undefined,
    ctx?: unknown,
  ): void {
    cache.set(mountCacheKey(path, ctx), { tree, refTarget: mountRefTarget(node), externalAbort });
  }

  async function resolveMount(
    node: NodeData,
    currentStore: Tree,
    ctx?: unknown,
  ): Promise<{ tree: Tree; externalAbort?: () => void }> {
    let mount = getComponentByName(node, 'mount');
    if (!mount) throw new Error(`Mount component missing on ${node.$path}`);
    let configNode: NodeData = node;
    if (isRef(mount)) {
      const fetched = await currentStore.get(mount.$ref, ctx);
      if (!fetched) throw new Error(`Mount ref not found: ${mount.$ref}`);
      configNode = fetched;
      mount = getComponentByName(configNode, 'mount');
      if (!mount) throw new Error(`Mount component missing on ref target ${configNode.$path}`);
    }

    let externalAbort: (() => void) | undefined;
    let startExternalWatch: ExternalWatchStarter | undefined;
    if (opts?.startExternalWatch) {
      const wrapped = opts.startExternalWatch;
      startExternalWatch = (tree, starterOpts) => {
        if (externalAbort) externalAbort(); // re-resolve race: abort previous
        const abort = wrapped(tree, starterOpts);
        externalAbort = abort;
        return abort;
      };
    }

    const tree = await resolveAdapter(mount, {
      node: configNode,
      path: node.$path,
      parentStore: currentStore,
      globalStore: self,
      startExternalWatch,
    });
    return { tree, externalAbort };
  }


  function strictAncestorPaths(path: string): string[] {
    if (path === '/') return [];
    const segments = path.split('/').filter(Boolean);
    const checks = ['/'];
    for (let i = 0; i < segments.length - 1; i++) checks.push('/' + segments.slice(0, i + 1).join('/'));
    return checks;
  }

  async function resolveNodeTree(path: string, ctx?: unknown): Promise<Tree> {
    // Walk strict ancestors only. The target node itself belongs to the tree
    // that contains its config, even when the target is a mount point.
    const checks = strictAncestorPaths(path);
    let nodeStore = rootStore;

    for (const check of checks) {
      // Mounts at/under /sys/trash are inert (core-anz4.8) — their copied
      // subtree is plain data of the store that owns /sys/trash.
      if (isTrashInert(check)) break;
      const cacheKey = mountCacheKey(check, ctx);
      const cached = cache.get(cacheKey);
      if (cached) {
        nodeStore = cached.tree;
        continue;
      }

      const node = await nodeStore.get(check, ctx);
      // TODO: parametrized mounts (:param paths) — need explicit registry, not runtime scan
      if (!node || !isMountPoint(node)) continue;

      const { tree, externalAbort } = await resolveMount(node, nodeStore, ctx);
      cacheMount(check, node, tree, externalAbort, ctx);
      nodeStore = tree;
    }

    return nodeStore;
  }

  async function resolveContentTree(path: string, ctx?: unknown): Promise<Tree> {
    const nodeStore = await resolveNodeTree(path, ctx);
    // Trash is inert — never activate the node's own mount to enumerate its
    // children; the copied subtree lives as plain data in rootStore (anz4.8).
    if (isTrashInert(path)) return nodeStore;

    const cached = cache.get(mountCacheKey(path, ctx));
    if (cached) return cached.tree;

    const node = await nodeStore.get(path, ctx);
    if (!node || !isMountPoint(node)) return nodeStore;
    const { tree, externalAbort } = await resolveMount(node, nodeStore, ctx);
    cacheMount(path, node, tree, externalAbort, ctx);
    return tree;
  }

  return self;
}
