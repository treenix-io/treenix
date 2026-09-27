// Treenix Types Mount — Layer 4
// Union of registry (code-defined types) + backing tree (dynamic types)

import { type ComponentData, createNode, getContextsForType, getRegisteredTypes, type NodeData, resolve } from '#core';
import { OpError } from '#errors';
import { paginate, type Tree } from '#tree';
import { scanFromCollected } from '#tree/fs-common';

/**
 * Build a `type` NodeData for a registered type by collecting its registry contexts.
 * The `schema` context is materialized into a `schema` named component;
 * other contexts (react, twa, ...) are marked as presence-only components.
 * Returns undefined when nothing is registered for the type.
 *
 * Reused by mods-mount so that `/sys/mods/{mod}/types/{name}` and
 * `/sys/types/{name}` produce structurally identical nodes.
 */
export function buildTypeNode(typeName: string, path: string): NodeData | undefined {
  const contexts = getContextsForType(typeName);
  if (contexts.length === 0) return undefined;
  const components: Record<string, ComponentData> = {};
  for (const ctx of contexts) {
    if (ctx === 'schema') {
      const handler = resolve(typeName, ctx)!;
      const schema = handler() as Record<string, unknown>;
      components[ctx] = { $type: ctx, ...schema } as ComponentData;
    } else {
      components[ctx] = { $type: ctx } as ComponentData;
    }
  }
  return createNode(path, 'type', undefined, components);
}

export function createTypesTree(backingStore: Tree, typesPath = '/sys/types'): Tree {
  // block.hero → /types/block/hero
  const toPath = (type: string) => `${typesPath}/${type.replace(/\./g, '/')}`;
  // /types/block/hero → block.hero
  const toType = (path: string) => path.slice(typesPath.length + 1).replace(/\//g, '.');

  // Registry wins for code-defined components; the backing tree adds dynamic
  // ones (view, actions from an AI agent).
  const merge = (stored: NodeData | undefined, reg: NodeData): NodeData => (stored ? { ...stored, ...reg } : reg);

  return {
    async get(path) {
      const typeName = toType(path);
      const reg = buildTypeNode(typeName, toPath(typeName));
      if (reg) return merge(await backingStore.get(reg.$path), reg);
      // Category folder (e.g. /types/block)
      if (getRegisteredTypes().some((t) => t.startsWith(typeName + '.'))) return createNode(path, 'dir');
      return backingStore.get(path);
    },

    async getChildren(path, opts) {
      const depth = opts?.depth ?? 1;
      const maxDepth = depth < 0 ? Infinity : depth;
      const byPath = new Map<string, NodeData>();
      // Synthesize folders for the leading segments of a relative path.
      const addDirs = (rel: string[]) => {
        for (let i = 1; i < rel.length && i <= maxDepth; i++) {
          const dirPath = `${path}/${rel.slice(0, i).join('/')}`;
          if (!byPath.has(dirPath)) byPath.set(dirPath, createNode(dirPath, 'dir'));
        }
      };

      for (const n of (await backingStore.getChildren(path, { depth: -1 })).items) {
        const rel = n.$path.slice(path.length + 1).split('/');
        if (rel.length <= maxDepth) byPath.set(n.$path, n);
        addDirs(rel);
      }

      const prefix = path === typesPath ? '' : toType(path) + '.';
      for (const t of getRegisteredTypes()) {
        if (!t.startsWith(prefix)) continue;
        const rel = t.slice(prefix.length).split('.');
        addDirs(rel);
        if (rel.length > maxDepth) continue;
        const reg = buildTypeNode(t, toPath(t));
        if (reg) byPath.set(reg.$path, merge(byPath.get(reg.$path), reg));
      }
      return paginate([...byPath.values()], opts);
    },

    // scanChildren — virtual catalog mount. Reuses getChildren (registry +
    // backing merge is complex) and yields via the shared cursor helper.
    // Bridge for read-runtime dispatch; not a streaming-native path.
    async *scanChildren(parent, opts) {
      const page = await this.getChildren!(parent, { depth: opts?.depth ?? 1 });
      yield* scanFromCollected(page.items, opts);
    },

    async set(node) {
      return backingStore.set(node);
    },

    async remove(path) {
      if (getContextsForType(toType(path)).length > 0) {
        throw new OpError('FORBIDDEN', `Cannot remove registry type: ${toType(path)}`);
      }
      return backingStore.remove(path);
    },

    async patch(path, ops, ctx) {
      return backingStore.patch(path, ops, ctx);
    },
  };
}
