// Treenity Mods Mount — Layer 4
// Virtual read-only tree exposing loaded mods as rich catalog nodes.
// Sources: mod loader (all loaded mods) + tracking + TypeCatalog + prefab registry.
//
// Tree structure:
//   /sys/mods/                           → dir (list all loaded mods)
//   /sys/mods/{mod}                      → t.mod node (name, state, types, prefabs)
//   /sys/mods/{mod}/types/               → dir (list type CatalogEntries)
//   /sys/mods/{mod}/types/{typeName}     → CatalogEntry node
//   /sys/mods/{mod}/prefabs/             → dir (list prefabs)
//   /sys/mods/{mod}/prefabs/{name}/      → t.prefab node (mod, name, deploy action)
//   /sys/mods/{mod}/prefabs/{name}/{...} → prefab nodes

import { createNode, type NodeData } from '#core';
import { getLoadedMods } from '#mod/loader';
import { getModPrefabs, getPrefab, getRegisteredMods } from '#mod/prefab';
import { Prefab } from '#mods/treenity/prefab-type';
import { paginate, type Tree } from '#tree';
import { getModInfo } from './mod-catalog';

// Mark mount components as disabled on prefab catalog nodes —
// they're data for inspection, not live mount points
function disableMount(node: NodeData): NodeData {
  const mount = node['mount'];
  if (!mount || typeof mount !== 'object' || !('$type' in mount)) return node;
  return { ...node, mount: { ...mount, disabled: true } };
}

type ParsedPath = {
  mod?: string;
  sub?: 'types' | 'prefabs';
  name?: string;   // type name or prefab name
  rest?: string;    // prefab sub-path
};

export function createModsStore(_backingStore: Tree, modsPath = '/sys/mods'): Tree {
  // Union: loader registry + prefab registry (some mods have prefabs but aren't in loader, e.g. tests)
  function allModNames(): Set<string> {
    const names = new Set(getLoadedMods().map(m => m.name));
    for (const n of getRegisteredMods()) names.add(n);
    return names;
  }

  function parsePath(path: string): ParsedPath {
    const rel = path.slice(modsPath.length);
    if (!rel || rel === '/') return {};
    const parts = rel.slice(1).split('/');

    if (parts.length === 1) return { mod: parts[0] };

    const sub = parts[1] as 'types' | 'prefabs';
    if (sub !== 'types' && sub !== 'prefabs') return { mod: parts[0] };

    if (parts.length === 2) return { mod: parts[0], sub };
    const name = parts[2];

    if (sub === 'types') return { mod: parts[0], sub, name };

    // prefabs: may have deeper paths
    const rest = parts.length > 3 ? parts.slice(3).join('/') : undefined;
    return { mod: parts[0], sub: 'prefabs', name, rest };
  }

  return {
    async get(path) {
      const p = parsePath(path);

      // /sys/mods
      if (!p.mod) return createNode(path, 'dir');

      if (!allModNames().has(p.mod)) return undefined;

      // /sys/mods/{mod} → t.mod node
      if (!p.sub) {
        const info = getModInfo(p.mod);
        return createNode(path, 't.mod', {
          name: info.name,
          state: info.state,
          ...(info.error ? { error: info.error } : {}),
          types: info.types.map(t => t.name),
          prefabs: info.prefabs,
        });
      }

      // /sys/mods/{mod}/types
      if (p.sub === 'types' && !p.name) return createNode(path, 'dir');

      // /sys/mods/{mod}/types/{typeName}
      if (p.sub === 'types' && p.name) {
        const info = getModInfo(p.mod);
        const entry = info?.types.find(t => t.name === p.name);
        if (!entry) return undefined;
        return createNode(path, 'type', {
          name: entry.name,
          ...(entry.title ? { title: entry.title } : {}),
          properties: entry.properties,
          actions: entry.actions,
        });
      }

      // /sys/mods/{mod}/prefabs
      if (p.sub === 'prefabs' && !p.name) return createNode(path, 'dir');

      // /sys/mods/{mod}/prefabs/{name}
      const prefab = getPrefab(p.mod, p.name!);
      if (!prefab) return undefined;

      if (!p.rest) return createNode(path, Prefab, { mod: p.mod, name: p.name! });

      // /sys/mods/{mod}/prefabs/{name}/{rest}
      const found = prefab.nodes.find(n => {
        const np = n.$path.startsWith('.') ? n.$path.slice(1) : n.$path;
        const clean = np.startsWith('/') ? np.slice(1) : np;
        return clean === p.rest;
      });
      return found ? disableMount({ ...found, $path: path }) : undefined;
    },

    async getChildren(path, opts) {
      const p = parsePath(path);
      const items: NodeData[] = [];

      if (!p.mod) {
        // List all known mods (loader + prefab registry)
        for (const name of allModNames()) {
          items.push(createNode(`${modsPath}/${name}`, 't.mod'));
        }
      } else if (!p.sub) {
        // Mod children: /types + /prefabs (if non-empty)
        const info = getModInfo(p.mod);
        if (info) {
          if (info.types.length > 0) items.push(createNode(`${path}/types`, 'dir'));
          if (info.prefabs.length > 0) items.push(createNode(`${path}/prefabs`, 'dir'));
        }
      } else if (p.sub === 'types' && !p.name) {
        // List types for mod
        const info = getModInfo(p.mod);
        if (info) {
          for (const t of info.types) {
            items.push(createNode(`${path}/${t.name}`, 'type', {
              name: t.name,
              ...(t.title ? { title: t.title } : {}),
              properties: t.properties,
              actions: t.actions,
            }));
          }
        }
      } else if (p.sub === 'prefabs' && !p.name) {
        // List prefabs for mod
        for (const [name] of getModPrefabs(p.mod)) {
          items.push(createNode(`${path}/${name}`, Prefab, { mod: p.mod, name }));
        }
      } else if (p.sub === 'prefabs' && p.name) {
        // List prefab nodes (direct children only)
        const prefab = getPrefab(p.mod, p.name);
        if (prefab) {
          for (const node of prefab.nodes) {
            if (node.$path === '.' || node.$path.startsWith('/')) continue;
            if (node.$path.includes('/')) continue;
            items.push(disableMount({ ...node, $path: `${path}/${node.$path}` }));
          }
        }
      }

      return paginate(items, opts);
    },

    async set() {
      throw new Error('Mods mount is read-only');
    },

    async remove() {
      throw new Error('Mods mount is read-only');
    },

    async patch() {
      throw new Error('Mods mount is read-only');
    },
  };
}
