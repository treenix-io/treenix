// Treenix Mount — Layer 4
// Mount = component on node. Adapter resolved via context system.
// Core untouched. Tree interface preserved.

import { isComponent, isRef, type NodeData, resolve } from '#core';
import { type Tree } from '#tree';
import { createBoundedCache } from '#util/bounded-cache';

// ── Mountable Tree ──

export function withMounts(rootStore: Tree): Tree {
  const MAX_MOUNT_CACHE = 1000;
  const cache = createBoundedCache<string, { tree: Tree; refTarget?: string }>(MAX_MOUNT_CACHE);

  /** Invalidate cache for path and all descendants (nested mounts under it) */
  function invalidateMount(path: string): void {
    if (cache.size === 0) return;
    cache.deleteWhere((entry, key) => {
      // key may have ?uid= suffix — extract the path part
      const keyPath = key.split('?')[0];
      return (
        isSameOrDescendant(keyPath, path)
        || (!!entry.refTarget && isSameOrDescendant(entry.refTarget, path))
      );
    });
  }

  function isSameOrDescendant(candidate: string, path: string): boolean {
    if (path === '/') return true;
    return candidate === path || candidate.startsWith(path + '/');
  }

  const self: Tree = {
    async get(path, ctx) {
      const tree = await resolveNodeStore(path, ctx);
      return tree.get(path, ctx);
    },

    async getChildren(path, opts, ctx) {
      const tree = await resolveContentStore(path, ctx);
      return tree.getChildren(path, opts, ctx);
    },

    async set(node, ctx) {
      const tree = await resolveNodeStore(node.$path, ctx);
      invalidateMount(node.$path);
      await tree.set(node, ctx);
    },

    async remove(path, ctx) {
      const tree = await resolveNodeStore(path, ctx);
      invalidateMount(path);
      return tree.remove(path, ctx);
    },

    async patch(path, ops, ctx) {
      const tree = await resolveNodeStore(path, ctx);
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

  function mountCacheKey(path: string, ctx?: any): string {
    return ctx?.userId ? `${path}?uid=${ctx.userId}` : path;
  }

  function cacheMount(path: string, node: NodeData, tree: Tree, ctx?: any): void {
    cache.set(mountCacheKey(path, ctx), { tree, refTarget: mountRefTarget(node) });
  }

  async function resolveMount(node: NodeData, currentStore: Tree, ctx?: any): Promise<Tree> {
    let mount = node['mount'];
    if (!isComponent(mount)) throw new Error(`Mount component missing on ${node.$path}`);
    let configNode = node;
    if (isRef(mount)) {
      configNode = (await currentStore.get(mount.$ref, ctx)) as NodeData;
      if (!configNode) throw new Error(`Mount ref not found: ${mount.$ref}`);
      mount = configNode['mount'];
      if (!isComponent(mount)) throw new Error(`Mount component missing on ref target ${configNode.$path}`);
    }
    const adapter = resolve(mount.$type, 'mount');
    if (!adapter) throw new Error(`No adapter for type "${mount.$type}"`);
    const mountCtx = { node: configNode, path: node.$path, parentStore: currentStore, globalStore: self };
    return await adapter(mount, mountCtx);
  }


  function strictAncestorPaths(path: string): string[] {
    if (path === '/') return [];
    const segments = path.split('/').filter(Boolean);
    const checks = ['/'];
    for (let i = 0; i < segments.length - 1; i++) checks.push('/' + segments.slice(0, i + 1).join('/'));
    return checks;
  }

  async function resolveNodeStore(path: string, ctx?: any): Promise<Tree> {
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

  async function resolveContentStore(path: string, ctx?: any): Promise<Tree> {
    const nodeStore = await resolveNodeStore(path, ctx);
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
