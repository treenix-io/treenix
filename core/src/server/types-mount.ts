// Treenity Types Mount — Layer 4
// Union of registry (code-defined types) + backing store (dynamic types)

import { type ComponentData, createNode, getContextsForType, getRegisteredTypes, type NodeData, resolve } from '#core';
import { paginate, type Tree } from '#tree';

export function createTypesStore(backingStore: Tree, typesPath = '/sys/types'): Tree {
  // block.hero → /types/block/hero
  const toPath = (type: string) => `${typesPath}/${type.replace(/\./g, '/')}`;
  // /types/block/hero → block.hero
  const toType = (path: string) => path.slice(typesPath.length + 1).replace(/\//g, '.');

  function isRegistryType(path: string): boolean {
    const typeName = toType(path);
    return getContextsForType(typeName).length > 0;
  }

  function typeNode(typeName: string): NodeData | undefined {
    const contexts = getContextsForType(typeName);
    if (contexts.length === 0) return undefined;
    const components: Record<string, ComponentData> = {};
    for (const ctx of contexts) {
      // "schema" returns data object; other contexts (twa, react) are renderers — just mark presence
      if (ctx === 'schema') {
        const handler = resolve(typeName, ctx)!;
        const schema = handler() as Record<string, unknown>;
        components[ctx] = { $type: ctx, ...schema } as ComponentData;
      } else {
        components[ctx] = { $type: ctx } as ComponentData;
      }
    }
    return createNode(toPath(typeName), 'type', undefined, components);
  }

  // Merge registry node with backing store node — registry wins for code-defined
  // components, backing store adds dynamic components (view, actions from AI agent)
  async function mergedTypeNode(typeName: string): Promise<NodeData | undefined> {
    const fromRegistry = typeNode(typeName);
    if (!fromRegistry) return undefined;
    const fromStore = await backingStore.get(fromRegistry.$path);
    if (!fromStore) return fromRegistry;
    // Backing store fields first, registry overwrites (code-defined always wins)
    return { ...fromStore, ...fromRegistry };
  }

  return {
    async get(path) {
      const typeName = toType(path);
      const merged = await mergedTypeNode(typeName);
      if (merged) return merged;
      // Check if it's a category folder (e.g. /types/block)
      const prefix = typeName + '.';
      if (getRegisteredTypes('schema').some((t) => t.startsWith(prefix))) {
        return createNode(path, 'dir');
      }
      return backingStore.get(path);
    },

    async getChildren(path, opts) {
      const depth = opts?.depth ?? 1;
      const prefix = path === typesPath ? '' : toType(path) + '.';
      const types = getRegisteredTypes();
      const byPath = new Map<string, NodeData>();
      // Backing store — scan deep to discover category folders, synthesize intermediate dirs
      const backingItems = (await backingStore.getChildren(path, { depth: Infinity })).items;
      for (const n of backingItems) {
        const rel = path === '/' ? n.$path.slice(1) : n.$path.slice(path.length + 1);
        const parts = rel.split('/');
        if (parts.length <= depth) byPath.set(n.$path, n);
        // Synthesize dir nodes for intermediate paths (like registry does for categories)
        for (let i = 0; i < parts.length - 1; i++) {
          if (i + 1 > depth) break;
          const dirPath = `${path}/${parts.slice(0, i + 1).join('/')}`;
          if (!byPath.has(dirPath)) byPath.set(dirPath, createNode(dirPath, 'dir'));
        }
      }
      // Registry types — merge with backing store data (dynamic views, actions)
      const seenDirs = new Set<string>();
      for (const t of types) {
        if (prefix && !t.startsWith(prefix)) continue;
        if (!prefix && !t.includes('.')) {
          const reg = typeNode(t);
          if (reg) {
            const stored = byPath.get(reg.$path);
            byPath.set(reg.$path, stored ? { ...stored, ...reg } : reg);
          }
          continue;
        }
        const rest = prefix ? t.slice(prefix.length) : t;
        const parts = rest.split('.');
        if (parts.length === 1) {
          // Direct child leaf type — merge with any backing store data
          const reg = typeNode(t);
          if (reg) {
            const stored = byPath.get(reg.$path);
            byPath.set(reg.$path, stored ? { ...stored, ...reg } : reg);
          }
        } else {
          // Category folder (always emit)
          const cat = parts[0];
          if (!seenDirs.has(cat)) {
            seenDirs.add(cat);
            const folderPath = `${path}/${cat}`;
            byPath.set(folderPath, createNode(folderPath, 'dir'));
          }
          // Deep types — emit when depth allows, merge with backing store
          if (depth > 1) {
            const reg = typeNode(t);
            if (reg) {
              const stored = byPath.get(reg.$path);
              byPath.set(reg.$path, stored ? { ...stored, ...reg } : reg);
            }
            // Intermediate dirs
            for (let i = 1; i < parts.length - 1; i++) {
              const dirKey = parts.slice(0, i + 1).join('.');
              if (!seenDirs.has(dirKey)) {
                seenDirs.add(dirKey);
                const dirPath = `${path}/${parts.slice(0, i + 1).join('/')}`;
                byPath.set(dirPath, createNode(dirPath, 'dir'));
              }
            }
          }
        }
      }
      return paginate([...byPath.values()], opts);
    },

    async set(node) {
      return backingStore.set(node);
    },

    async remove(path) {
      // Never remove code-registered types
      if (isRegistryType(path)) throw new Error(`Cannot remove registry type: ${toType(path)}`);
      return backingStore.remove(path);
    },

    async patch(path, ops, ctx) {
      return backingStore.patch(path, ops, ctx);
    },
  };
}
