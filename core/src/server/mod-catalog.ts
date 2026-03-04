// Mod Catalog — synthesizes rich mod info from loader + tracking + TypeCatalog + prefabs
// Pure functions, no store deps.

import { getLoadedMods } from '#mod/loader';
import { getModPrefabs, getRegisteredMods } from '#mod/prefab';
import { getTypesForMod, inferModFromType } from '#mod/tracking';
import type { ModState } from '#mod/types';
import type { CatalogEntry } from '#schema/catalog';
import { TypeCatalog } from '#schema/catalog';

export type ModInfo = {
  name: string;
  state: ModState;
  error?: string;
  types: CatalogEntry[];
  prefabs: string[];
};

const catalog = new TypeCatalog();

/** Get rich info for a single mod (works for loader AND prefab-only mods) */
export function getModInfo(name: string): ModInfo {
  const loaded = getLoadedMods().find(m => m.name === name);
  return buildModInfo(name, loaded?.state ?? 'loaded', loaded?.error);
}

/** Get info for all known mods (loader + prefab registry) */
export function getAllMods(): ModInfo[] {
  const names = new Set(getLoadedMods().map(m => m.name));
  for (const n of getRegisteredMods()) names.add(n);
  return [...names].map(n => getModInfo(n));
}

function buildModInfo(name: string, state: ModState, error?: Error): ModInfo {
  // Tracked types first
  const tracked = getTypesForMod(name);
  const trackedSet = new Set(tracked);

  // Convention fallback: catalog types whose inferred mod matches
  const allTypes = catalog.list();
  const conventionTypes = allTypes.filter(
    e => !trackedSet.has(e.name) && inferModFromType(e.name) === name,
  );

  const types = [
    ...allTypes.filter(e => trackedSet.has(e.name)),
    ...conventionTypes,
  ];

  const prefabs = getModPrefabs(name).map(([n]) => n);

  return {
    name,
    state,
    ...(error ? { error: error.message } : {}),
    types,
    prefabs,
  };
}
