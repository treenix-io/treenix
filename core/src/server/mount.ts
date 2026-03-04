// Treenity Mount — Layer 4
// Mount = component on node. Adapter resolved via context system.
// Core untouched. Tree interface preserved.

import { isComponent, isRef, type NodeData, resolve } from '#core';
import { type Tree } from '#tree';

// ── Mountable Tree ──

type ResolveResult = { store: Tree; mountPath: string | null; parentStore: Tree };

export function withMounts(rootStore: Tree): Tree {
  const cache = new Map<string, Tree>();
  const MAX_MOUNT_CACHE = 1000;

  // Cached parametrized mount patterns — avoids depth-5 scan on every resolveStore miss
  type ParamPattern = { regex: RegExp; paramNames: string[]; node: NodeData };
  const paramPatterns = new Map<string, ParamPattern[]>();

  const self: Tree = {
    async get(path, ctx) {
      const { store, mountPath, parentStore } = await resolveStore(path, ctx);
      // Mount node config lives in parent store
      if (mountPath === path) return parentStore.get(path, ctx);
      return store.get(path, ctx);
    },

    async getChildren(path, opts, ctx) {
      const { store } = await resolveStore(path, ctx);
      return store.getChildren(path, opts, ctx);
    },

    async set(node, ctx) {
      const { store, mountPath, parentStore } = await resolveStore(node.$path, ctx);
      if (mountPath === node.$path) await parentStore.set(node, ctx);
      else await store.set(node, ctx);
      // Invalidate param pattern cache AFTER write (cache may have been populated with stale empty results during resolveStore)
      if (node.$path.includes(':') && isComponent(node['mount'])) paramPatterns.clear();
    },

    async remove(path, ctx) {
      const { store, mountPath, parentStore } = await resolveStore(path, ctx);
      if (mountPath === path) {
        // Stop caching this mount
        cache.delete(path);
        return parentStore.remove(path, ctx);
      }
      return store.remove(path, ctx);
    },

    async patch(path, ops, ctx) {
      const { store, mountPath, parentStore } = await resolveStore(path, ctx);
      if (mountPath === path) await parentStore.patch(path, ops, ctx);
      else await store.patch(path, ops, ctx);
    },
  };

  /** Check if node's mount component resolves to a known adapter */
  function isMountPoint(node: NodeData): boolean {
    const mount = node['mount'];
    if (!isComponent(mount)) return false;
    // Refs need resolution — treat as mount-point optimistically
    if (isRef(mount)) return true;
    return !!resolve(mount.$type, 'mount');
  }

  async function resolveMount(node: NodeData, currentStore: Tree, ctx?: any): Promise<Tree> {
    const mount = node['mount'];
    if (!isComponent(mount)) throw new Error(`Mount component missing on ${node.$path}`);
    let configNode = node;
    if (isRef(mount)) {
      configNode = (await currentStore.get(mount.$ref, ctx)) as NodeData;
      if (!configNode) throw new Error(`Mount ref not found: ${mount.$ref}`);
    }
    const adapterType = isRef(mount) ? configNode.$type : mount.$type;
    const adapter = resolve(adapterType, 'mount');
    if (!adapter) throw new Error(`No adapter for type "${adapterType}"`);
    return await adapter(configNode, currentStore, ctx, self);
  }

  // Parse path string like /users/:userId into regex and parameter names
  function parseParametrizedPath(template: string) {
    const paramNames: string[] = [];
    const regexStr = template.replace(/:([a-zA-Z0-9_]+)/g, (_, paramName) => {
      paramNames.push(paramName);
      return '([^/]+)';
    });
    return {
      regex: new RegExp(`^${regexStr}$`),
      paramNames,
    };
  }

  // Bind parameters in a string template, e.g. { source: '/users/:userId/orders' } + { userId: 1 } -> '/users/1/orders'
  // Also recursively handles nested objects, replacing strings inside arrays/objects
  function bindParams(obj: any, params: Record<string, string>): any {
    if (typeof obj === 'string') {
      return obj.replace(/:([a-zA-Z0-9_]+)/g, (match, paramName) => {
        const val = params[paramName];
        if (val === undefined) return match;
        // Prevent sift operator injection: reject $-prefixed values in path params
        if (val.startsWith('$')) throw new Error(`Invalid parameter value: ${paramName}=${val}`);
        return val;
      });
    }
    if (Array.isArray(obj)) {
      return obj.map(item => bindParams(item, params));
    }
    if (typeof obj === 'object' && obj !== null) {
      const result: Record<string, any> = {};
      for (const [key, value] of Object.entries(obj)) {
        result[key] = bindParams(value, params);
      }
      return result;
    }
    return obj;
  }

  async function resolveStore(path: string, ctx?: any): Promise<ResolveResult> {
    // Walk: /, /seg1, /seg1/seg2, ... — each may be a mount point
    // Nested mounts: check each level in the current best store
    const segments = path.split('/').filter(Boolean);
    const checks = ['/'];
    for (let i = 0; i < segments.length; i++) checks.push('/' + segments.slice(0, i + 1).join('/'));

    let bestStore = rootStore;
    let bestMountPath: string | null = null;
    let parentStore = rootStore;

    for (const check of checks) {
      // We need to look for parameterized mounts in the current best store's config nodes if check isn't exactly matching.
      // But first, let's keep the existing logic for direct matches
      const cacheKey = ctx?.userId ? `${check}?uid=${ctx.userId}` : check;
      const cached = cache.get(cacheKey);
      if (cached) {
        parentStore = bestStore;
        bestStore = cached;
        bestMountPath = check;
        continue;
      }

      let node = await bestStore.get(check, ctx);
      let matchParams: Record<string, string> | undefined = undefined;

      // If no direct node, look for parameterized mounts (cached)
      if (!node) {
        const parts = check.split('/').filter(Boolean);
        let parentCheck = '/';
        for (let j = parts.length - 1; j >= 0; j--) {
           const candidate = '/' + parts.slice(0, j).join('/');
           const pNode = await bestStore.get(candidate || '/', ctx);
           if (pNode) {
              parentCheck = candidate || '/';
              break;
           }
        }

        // Scan once per prefix, cache compiled patterns
        let patterns = paramPatterns.get(parentCheck);
        if (!patterns) {
          patterns = [];
          const children = await bestStore.getChildren(parentCheck, { depth: 5 }, ctx);
          for (const child of children.items) {
            if (child.$path.includes(':') && isComponent(child['mount'])) {
              patterns.push({ ...parseParametrizedPath(child.$path), node: child });
            }
          }
          paramPatterns.set(parentCheck, patterns);
        }

        for (const p of patterns) {
          const match = check.match(p.regex);
          if (match) {
            node = p.node;
            matchParams = {};
            for (let i = 0; i < p.paramNames.length; i++) {
              matchParams[p.paramNames[i]] = match[i + 1];
            }
            break;
          }
        }
      }

      if (!node || !isMountPoint(node)) continue;

      // If we matched parameters, bind them into the node config
      let configNode = node;
      if (matchParams) {
          // deep copy and bind parameters for 'query' component or other configs
          configNode = bindParams(node, matchParams);
      }

      const store = await resolveMount(configNode, bestStore, ctx);
      // Evict oldest entry if cache is full
      if (cache.size >= MAX_MOUNT_CACHE) {
        const first = cache.keys().next().value;
        if (first) cache.delete(first);
      }
      cache.set(cacheKey, store);
      parentStore = bestStore;
      bestStore = store;
      bestMountPath = check;
    }
    return { store: bestStore, mountPath: bestMountPath, parentStore };
  }

  return self;
}
