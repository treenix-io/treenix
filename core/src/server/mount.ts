// Treenity Mount — Layer 4
// Mount = component on node. Adapter resolved via context system.
// Core untouched. Tree interface preserved.

import { isComponent, isRef, type NodeData, resolve } from '#core';
import { type Tree } from '#tree';

// ── Mountable Tree ──

type ResolveResult = { tree: Tree; mountPath: string | null; parentStore: Tree };

export function withMounts(rootStore: Tree): Tree {
  const cache = new Map<string, Tree>();
  const MAX_MOUNT_CACHE = 1000;

  const self: Tree = {
    async get(path, ctx) {
      const { tree, mountPath, parentStore } = await resolveStore(path, ctx);
      // Mount node config lives in parent tree
      if (mountPath === path) return parentStore.get(path, ctx);
      return tree.get(path, ctx);
    },

    async getChildren(path, opts, ctx) {
      const { tree } = await resolveStore(path, ctx);
      return tree.getChildren(path, opts, ctx);
    },

    async set(node, ctx) {
      const { tree, mountPath, parentStore } = await resolveStore(node.$path, ctx);
      if (mountPath === node.$path) await parentStore.set(node, ctx);
      else await tree.set(node, ctx);
    },

    async remove(path, ctx) {
      const { tree, mountPath, parentStore } = await resolveStore(path, ctx);
      if (mountPath === path) {
        // Stop caching this mount
        cache.delete(path);
        return parentStore.remove(path, ctx);
      }
      return tree.remove(path, ctx);
    },

    async patch(path, ops, ctx) {
      const { tree, mountPath, parentStore } = await resolveStore(path, ctx);
      if (mountPath === path) await parentStore.patch(path, ops, ctx);
      else await tree.patch(path, ops, ctx);
    },
  };

  /** Check if node's mount component resolves to a known adapter */
  function isMountPoint(node: NodeData): boolean {
    const mount = node['mount'];
    if (!isComponent(mount)) return false;
    if (mount.disabled) return false;
    // Refs need resolution — treat as mount-point optimistically
    if (isRef(mount)) return true;
    return !!resolve(mount.$type, 'mount');
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


  async function resolveStore(path: string, ctx?: any): Promise<ResolveResult> {
    // Walk: /, /seg1, /seg1/seg2, ... — each may be a mount point
    // Nested mounts: check each level in the current best tree
    const segments = path.split('/').filter(Boolean);
    const checks = ['/'];
    for (let i = 0; i < segments.length; i++) checks.push('/' + segments.slice(0, i + 1).join('/'));

    let bestStore = rootStore;
    let bestMountPath: string | null = null;
    let parentStore = rootStore;

    for (const check of checks) {
      // We need to look for parameterized mounts in the current best tree's config nodes if check isn't exactly matching.
      // But first, let's keep the existing logic for direct matches
      const cacheKey = ctx?.userId ? `${check}?uid=${ctx.userId}` : check;
      const cached = cache.get(cacheKey);
      if (cached) {
        parentStore = bestStore;
        bestStore = cached;
        bestMountPath = check;
        continue;
      }

      const node = await bestStore.get(check, ctx);
      // TODO: parametrized mounts (:param paths) — need explicit registry, not runtime scan
      if (!node || !isMountPoint(node)) continue;

      const configNode = node;

      const tree = await resolveMount(configNode, bestStore, ctx);
      // Evict oldest entry if cache is full
      if (cache.size >= MAX_MOUNT_CACHE) {
        const first = cache.keys().next().value;
        if (first) cache.delete(first);
      }
      cache.set(cacheKey, tree);
      parentStore = bestStore;
      bestStore = tree;
      bestMountPath = check;
    }
    return { tree: bestStore, mountPath: bestMountPath, parentStore };
  }

  return self;
}
