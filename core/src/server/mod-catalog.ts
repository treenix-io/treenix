// Mod Catalog — synthesizes rich mod info from loader + tracking + TypeCatalog + prefabs
// Pure functions, no tree deps.

import { getLoadedMods } from '#mod/loader';
import { getModPrefabs, getRegisteredMods } from '#mod/prefab';
import { getTypesForMod } from '#mod/tracking';
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
  // R4-BOOT-5: tracked-types only — drop convention fallback. Inferring mod-of-type from
  // string prefix lets a type registered outside any setCurrentMod() window appear under
  // an unrelated mod (e.g. `auth.takeover` shows up under mod `auth`). Authoritative
  // attribution comes from typeToMod populated during loader's setCurrentMod windows.
  const trackedSet = new Set(getTypesForMod(name));
  const types = catalog.list().filter(e => trackedSet.has(e.name));
  const prefabs = getModPrefabs(name).map(([n]) => n);

  return {
    name,
    state,
    ...(error ? { error: error.message } : {}),
    types,
    prefabs,
  };
}
