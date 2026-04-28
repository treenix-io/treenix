// Treenix Module System — public API

export { defineMod } from './types';
export type { TreenixMod, ModManifest, ModState, LoadedMod } from './types';
export { discoverMods } from './discover';
export { sortByDependencies, loadMods, loadLocalMods, loadAllMods, getLoadedMods, getMod, isModLoaded, clearModRegistry } from './loader';
export type { LoadTarget, LoadResult } from './loader';
export { OptimisticBuffer } from './optimistic';
export type { PendingMutation } from './optimistic';
export { registerPrefab, getPrefab, getModPrefabs, getRegisteredMods, getSeedPrefabs, clearPrefabs } from './prefab';
export type { PrefabSetup, PrefabMeta, PrefabEntry } from './prefab';
export { getTypesForMod, inferModFromType, clearTracking } from './tracking';
