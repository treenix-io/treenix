// Treenix Mods Mount — Layer 4
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

import { createNode, isComponent, type NodeData } from '#core';
import { getLoadedMods } from '#mod/loader';
import { getModPrefabs, getPrefab, getRegisteredMods } from '#mod/prefab';
import { Prefab } from '#mods/treenix/prefab-type';
import { paginate, type Tree } from '#tree';
import { getModInfo } from './mod-catalog';
import { buildTypeNode } from './types-mount';

// Prefab inner nodes appear under /sys/mods/{mod}/prefabs/... as catalog entries.
// Most have no mount component (just data); some do (e.g. directories that mount
// FS roots when deployed). For the catalog view we disable any present mount —
// browsing the catalog must not trigger live mount resolution. Absent mount = pass through.
function disableMountIfPresent(node: NodeData): NodeData {
  const mount = node['mount'];
  if (!isComponent(mount)) return node;
  return { ...node, mount: { ...mount, disabled: true } };
}

type ParsedPath = {
  mod?: string;
  sub?: 'types' | 'prefabs';
  name?: string;   // type name or prefab name
  rest?: string;    // prefab sub-path
};

export function createModsTree(modsPath = '/sys/mods'): Tree {
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

      // /sys/mods/{mod}/types/{typeName} — same shape as /sys/types/{name}
      if (p.sub === 'types' && p.name) {
        const info = getModInfo(p.mod);
        const entry = info?.types.find(t => t.name === p.name);
        if (!entry) return undefined;
        return buildTypeNode(entry.name, path) ?? createNode(path, 'type');
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
      return found ? disableMountIfPresent({ ...found, $path: path }) : undefined;
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
        // List types for mod — same shape as /sys/types
        const info = getModInfo(p.mod);
        if (info) {
          for (const t of info.types) {
            const childPath = `${path}/${t.name}`;
            items.push(buildTypeNode(t.name, childPath) ?? createNode(childPath, 'type'));
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
            items.push(disableMountIfPresent({ ...node, $path: `${path}/${node.$path}` }));
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
