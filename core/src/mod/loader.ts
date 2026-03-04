// Treenity Module Loader — dependency sort, load, seed

import type { Tree } from '#tree';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { setCurrentMod } from './tracking';
import type { LoadedMod, ModManifest, TreenityMod } from './types';

// ── Dependency sorting (Kahn's algorithm) ──

export function sortByDependencies(mods: ModManifest[]): ModManifest[] {
  const byName = new Map(mods.map(m => [m.name, m]));
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();

  for (const m of mods) {
    if (!inDegree.has(m.name)) inDegree.set(m.name, 0);
    if (!adj.has(m.name)) adj.set(m.name, []);

    for (const dep of m.dependencies ?? []) {
      if (!byName.has(dep)) throw new Error(`Mod "${m.name}" depends on unknown mod "${dep}"`);
      if (!adj.has(dep)) adj.set(dep, []);
      adj.get(dep)!.push(m.name);
      inDegree.set(m.name, (inDegree.get(m.name) ?? 0) + 1);
    }
  }

  const queue: string[] = [];
  for (const [name, deg] of inDegree) {
    if (deg === 0) queue.push(name);
  }

  const sorted: ModManifest[] = [];
  while (queue.length > 0) {
    const name = queue.shift()!;
    sorted.push(byName.get(name)!);
    for (const next of adj.get(name) ?? []) {
      const deg = inDegree.get(next)! - 1;
      inDegree.set(next, deg);
      if (deg === 0) queue.push(next);
    }
  }

  if (sorted.length !== mods.length) {
    const stuck = mods.filter(m => !sorted.includes(m)).map(m => m.name);
    throw new Error(`Circular dependency among mods: ${stuck.join(', ')}`);
  }

  return sorted;
}

// ── Registry of loaded mods ──

const loaded = new Map<string, LoadedMod>();

export function getLoadedMods(): LoadedMod[] {
  return [...loaded.values()];
}

export function getMod(name: string): LoadedMod | undefined {
  return loaded.get(name);
}

export function isModLoaded(name: string): boolean {
  return loaded.get(name)?.state === 'loaded';
}

export function clearModRegistry(): void {
  loaded.clear();
}

// ── Loader ──

export type LoadTarget = 'server' | 'client';

export interface LoadResult {
  loaded: string[];
  failed: { name: string; error: Error }[];
}

export async function loadMods(
  manifests: ModManifest[],
  target: LoadTarget,
  store?: Tree,
): Promise<LoadResult> {
  const sorted = sortByDependencies(manifests);
  const result: LoadResult = { loaded: [], failed: [] };

  for (const manifest of sorted) {
    const entry: LoadedMod = { name: manifest.name, manifest, state: 'loading' };
    loaded.set(manifest.name, entry);

    try {
      for (const dep of manifest.dependencies ?? []) {
        if (!isModLoaded(dep)) throw new Error(`Dependency "${dep}" not loaded`);
      }

      const entryPath = target === 'server' ? manifest.server : manifest.client;
      let mod: TreenityMod | undefined;

      if (entryPath && manifest.packagePath) {
        const fullPath = join(manifest.packagePath, entryPath);
        setCurrentMod(manifest.name);
        const exported = await import(fullPath);
        setCurrentMod(null);
        mod = exported.default as TreenityMod;
      }

      if (mod?.onLoad) await mod.onLoad();

      // Seed (server-only, needs store)
      if (target === 'server' && store) {
        if (mod?.seed) {
          await mod.seed(store);
        } else if (manifest.seed && manifest.packagePath) {
          const seedMod = await import(join(manifest.packagePath, manifest.seed));
          await seedMod.default(store);
        }
      }

      entry.mod = mod;
      entry.state = 'loaded';
      entry.loadedAt = Date.now();
      result.loaded.push(manifest.name);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      entry.state = 'failed';
      entry.error = error;
      result.failed.push({ name: manifest.name, error });
    }
  }

  return result;
}

// ── Local mod loader (side-effect imports from src/mods/) ──

export async function loadLocalMods(modsDir: string, target: LoadTarget): Promise<LoadResult> {
  const result: LoadResult = { loaded: [], failed: [] };
  const entryFile = target === 'server' ? 'server.ts' : 'client.ts';
  let entries: import('node:fs').Dirent[];

  try {
    entries = await readdir(modsDir, { withFileTypes: true });
  } catch {
    return result;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;

    const filePath = join(modsDir, entry.name, entryFile);
    try { await stat(filePath); } catch { continue; }

    const modEntry: LoadedMod = { name: entry.name, state: 'loading' };
    loaded.set(entry.name, modEntry);

    try {
      setCurrentMod(entry.name);
      await import(filePath);
      setCurrentMod(null);
      modEntry.state = 'loaded';
      modEntry.loadedAt = Date.now();
      result.loaded.push(entry.name);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      modEntry.state = 'failed';
      modEntry.error = error;
      result.failed.push({ name: entry.name, error });
    }
  }

  return result;
}
