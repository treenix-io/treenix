// Treenix Prefab Registry — in-memory tree for module prefab declarations
// Modules call registerPrefab() during import; mods-mount exposes data as virtual tree.
// Prefabs named 'seed' are auto-deployed at startup by deploySeedPrefabs().

import { type NodeData } from '#core';

export type PrefabSetup = (nodes: NodeData[], params?: unknown) => NodeData[] | Promise<NodeData[]>;

export type PrefabMeta = { tier?: 'core' };

export type PrefabEntry = {
  nodes: NodeData[];
  setup?: PrefabSetup;
  meta?: PrefabMeta;
};

// Key: "mod/name"
const prefabs = new Map<string, PrefabEntry>();

export function registerPrefab(
  mod: string,
  name: string,
  nodes: NodeData[],
  setup?: PrefabSetup,
  meta?: PrefabMeta,
): void {
  const key = `${mod}/${name}`;
  if (prefabs.has(key)) return; // sealed, like registry
  prefabs.set(key, { nodes, setup, meta });
}

export function getPrefab(mod: string, name: string): PrefabEntry | undefined {
  return prefabs.get(`${mod}/${name}`);
}

export function getModPrefabs(mod: string): [string, PrefabEntry][] {
  const result: [string, PrefabEntry][] = [];
  for (const [k, v] of prefabs) {
    if (k.startsWith(mod + '/')) result.push([k.slice(mod.length + 1), v]);
  }
  return result;
}

export function getRegisteredMods(): string[] {
  const mods = new Set<string>();
  for (const k of prefabs.keys()) mods.add(k.split('/')[0]);
  return [...mods];
}

/** All seed prefabs: [mod, PrefabEntry][] */
export function getSeedPrefabs(): [string, PrefabEntry][] {
  const result: [string, PrefabEntry][] = [];
  for (const [k, v] of prefabs) {
    if (k.endsWith('/seed')) result.push([k.split('/')[0], v]);
  }
  return result;
}

// For tests
export function clearPrefabs(): void {
  prefabs.clear();
}
