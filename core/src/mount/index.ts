// Treenix Mount — Layer 4
// Mount = component on node. Adapter resolved via context system.
// Core untouched. Tree interface preserved.

import { type ComponentData, isComponent, isRef, type NodeData, resolve } from '#core';
import { type Tree } from '#tree';
import { createBoundedCache } from '#util/bounded-cache';

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

export type MountAdapter<T = unknown> = (mount: T, ctx: MountCtx) => Tree | Promise<Tree>;

declare module '#core/context' {
  interface ContextHandlers<T> {
    mount: MountAdapter<T>;
  }
}

/**
 * Resolve a mount component to its Tree by looking up the registered adapter.
 * Used both by the mount machinery (after node + ref resolution) and by composite
 * adapters like MountOverlay that need to resolve sub-components.
 */
export async function resolveAdapter(mount: ComponentData, mountCtx: MountCtx): Promise<Tree> {
  const adapter = resolve(mount.$type, 'mount');
  if (!adapter) throw new Error(`No mount adapter for "${mount.$type}"`);
  return await adapter(mount, mountCtx);
}

// ── Mountable Tree ──

const DEFAULT_MOUNT_CACHE = 1000;

export function withMounts(rootStore: Tree, opts?: WithMountsOpts): Tree {
  const cache = createBoundedCache<string, { tree: Tree; refTarget?: string }>(opts?.cacheMax ?? DEFAULT_MOUNT_CACHE);
  // Parallel map: per-mount-cache-key abort fn for any external-watch
  // consumers the adapter started. On invalidate we call abort before
  // dropping the cache entry, so change-stream cursors and timers don't leak.
  const externalWatchAborts = new Map<string, () => void>();

  /** Invalidate cache for path and all descendants (nested mounts under it) */
  function invalidateMount(path: string): void {
    if (cache.size === 0) return;
    const toAbort: string[] = [];
    cache.deleteWhere((entry, key) => {
      // key may have ?uid= suffix — extract the path part
      const keyPath = key.split('?')[0];
      const match = isSameOrDescendant(keyPath, path)
        || (!!entry.refTarget && isSameOrDescendant(entry.refTarget, path));
      if (match && externalWatchAborts.has(key)) toAbort.push(key);
      return match;
    });
    for (const key of toAbort) {
      const abort = externalWatchAborts.get(key);
      if (abort) { abort(); externalWatchAborts.delete(key); }
    }
  }

  function isSameOrDescendant(candidate: string, path: string): boolean {
    if (path === '/') return true;
    return candidate === path || candidate.startsWith(path + '/');
  }

  const self: Tree = {
    async get(path, ctx) {
      const tree = await resolveNodeTree(path, ctx);
      return tree.get(path, ctx);
    },

    async getChildren(path, opts, ctx) {
      const tree = await resolveContentTree(path, ctx);
      return tree.getChildren(path, opts, ctx);
    },

    // scanChildren dispatch — same per-path resolution as getChildren, but
    // streams. Mount sub-trees that don't expose scanChildren (legacy Tree-only
    // adapters) fail loudly: the new read runtime explicitly forbids falling
    // back to getChildren (would re-introduce the mixed-responsibilities path).
    async *scanChildren(path, opts, ctx) {
      const tree = await resolveContentTree(path, ctx);
      if (!tree.scanChildren) {
        throw new Error(`Mount-resolved tree at ${path} does not expose scanChildren`);
      }
      yield* tree.scanChildren(path, opts, ctx);
    },

    async set(node, ctx) {
      const tree = await resolveNodeTree(node.$path, ctx);
      invalidateMount(node.$path);
      await tree.set(node, ctx);
    },

    async remove(path, ctx) {
      const tree = await resolveNodeTree(path, ctx);
      invalidateMount(path);
      return tree.remove(path, ctx);
    },

    async patch(path, ops, ctx) {
      const tree = await resolveNodeTree(path, ctx);
      invalidateMount(path);
      await tree.patch(path, ops, ctx);
    },
  };

  /** Check if node's mount component resolves to a known adapter */
  function isMountPoint(node: NodeData): boolean {
    const mount = node['mount'];
    if (!isComponent(mount)) return false;
    if (mount.disabled) return false;
    // Refs need resolution — treat as mount-point optimistically
    if (isRef(mount)) return true;
    const adapter = resolve(mount.$type, 'mount');
    if (!adapter) throw new Error(`No adapter for type "${mount.$type}"`);
    return true;
  }

  function mountRefTarget(node: NodeData): string | undefined {
    const mount = node['mount'];
    return isRef(mount) ? mount.$ref : undefined;
  }

  // Mount cache is keyed by user identity — different users may see different
  // mount configurations (per-user ACL drives different ref targets).
  // Tree contract types ctx as `unknown`; we only read userId in mountCacheKey
  // and narrow there. Other helpers pass ctx through opaquely.
  function mountCacheKey(path: string, ctx?: unknown): string {
    const userId = (ctx as { userId?: string } | undefined)?.userId;
    return userId ? `${path}?uid=${userId}` : path;
  }

  function cacheMount(path: string, node: NodeData, tree: Tree, ctx?: unknown): void {
    cache.set(mountCacheKey(path, ctx), { tree, refTarget: mountRefTarget(node) });
  }

  async function resolveMount(node: NodeData, currentStore: Tree, ctx?: unknown): Promise<Tree> {
    let mount = node['mount'];
    if (!isComponent(mount)) throw new Error(`Mount component missing on ${node.$path}`);
    let configNode: NodeData = node;
    if (isRef(mount)) {
      const fetched = await currentStore.get(mount.$ref, ctx);
      if (!fetched) throw new Error(`Mount ref not found: ${mount.$ref}`);
      configNode = fetched;
      mount = configNode['mount'];
      if (!isComponent(mount)) throw new Error(`Mount component missing on ref target ${configNode.$path}`);
    }

    // Wrap startExternalWatch so withMounts captures the abort fn keyed by
    // the SAME cache key cacheMount uses below — invalidation can then close
    // the corresponding external-watch consumer in lockstep with eviction.
    let startExternalWatch: ExternalWatchStarter | undefined;
    if (opts?.startExternalWatch) {
      const wrapped = opts.startExternalWatch;
      const mountPath = node.$path;
      startExternalWatch = (tree, starterOpts) => {
        const key = mountCacheKey(mountPath, ctx);
        // Re-resolve shouldn't normally race, but if it does, abort the
        // previous consumer before installing the new one — never leak.
        const prev = externalWatchAborts.get(key);
        if (prev) prev();
        const abort = wrapped(tree, starterOpts);
        externalWatchAborts.set(key, abort);
        return () => {
          abort();
          if (externalWatchAborts.get(key) === abort) externalWatchAborts.delete(key);
        };
      };
    }

    return resolveAdapter(mount, {
      node: configNode,
      path: node.$path,
      parentStore: currentStore,
      globalStore: self,
      startExternalWatch,
    });
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
      const cacheKey = mountCacheKey(check, ctx);
      const cached = cache.get(cacheKey);
      if (cached) {
        nodeStore = cached.tree;
        continue;
      }

      const node = await nodeStore.get(check, ctx);
      // TODO: parametrized mounts (:param paths) — need explicit registry, not runtime scan
      if (!node || !isMountPoint(node)) continue;

      const tree = await resolveMount(node, nodeStore, ctx);
      cacheMount(check, node, tree, ctx);
      nodeStore = tree;
    }

    return nodeStore;
  }

  async function resolveContentTree(path: string, ctx?: unknown): Promise<Tree> {
    const nodeStore = await resolveNodeTree(path, ctx);
    const cached = cache.get(mountCacheKey(path, ctx));
    if (cached) return cached.tree;

    const node = await nodeStore.get(path, ctx);
    if (!node || !isMountPoint(node)) return nodeStore;
    const tree = await resolveMount(node, nodeStore, ctx);
    cacheMount(path, node, tree, ctx);
    return tree;
  }

  return self;
}
