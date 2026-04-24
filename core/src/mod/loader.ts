// Treenity Module Loader — dependency sort, load, seed

import { createLogger } from '#log';
import { loadSchemasFromDir } from '#schema/load';
import type { Tree } from '#tree';
import { readdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { setCurrentMod } from './tracking';
import type { LoadedMod, ModManifest, TreenityMod } from './types';

const log = createLogger('mod');

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

// ── Timeout helper ──

const MOD_TIMEOUT_MS = 30_000;

async function withTimeout<T>(promise: Promise<T>, label: string, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`[mod] ${label} timed out after ${ms}ms`)),
      ms,
    );
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

// ── Loader ──

export type LoadTarget = 'server' | 'client';

export interface LoadResult {
  loaded: string[];
  failed: { name: string; error: Error }[];
}

export interface LoadModsOpts {
  modTimeout?: number;
}

export async function loadMods(
  manifests: ModManifest[],
  target: LoadTarget,
  tree?: Tree,
  opts?: LoadModsOpts,
): Promise<LoadResult> {
  const timeout = opts?.modTimeout ?? MOD_TIMEOUT_MS;
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

      const t0 = performance.now();

      if (mod?.onLoad) {
        await withTimeout(mod.onLoad(), `${manifest.name}.onLoad`, timeout);
      }

      // Seed (server-only, needs tree)
      if (target === 'server' && tree) {
        if (mod?.seed) {
          await withTimeout(mod.seed(tree), `${manifest.name}.seed`, timeout);
        } else if (manifest.seed && manifest.packagePath) {
          const seedMod = await import(join(manifest.packagePath, manifest.seed));
          await withTimeout(seedMod.default(tree), `${manifest.name}.seed`, timeout);
        }
      }

      const elapsed = Math.round(performance.now() - t0);
      log.info(`${manifest.name} loaded in ${elapsed}ms`);

      entry.mod = mod;
      entry.state = 'loaded';
      entry.loadedAt = Date.now();
      entry.loadDurationMs = elapsed;
      result.loaded.push(manifest.name);

      // Load per-mod schemas
      if (manifest.packagePath) {
        const entryPath = target === 'server' ? manifest.server : manifest.client;
        if (entryPath) loadSchemasFromDir(join(manifest.packagePath, dirname(entryPath), 'schemas'));
      }
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

// Convention files for auto-discovery when server/client entry is absent.
// Each bare name is tried with both .ts (source-shipped packages) and .js (dist-shipped).
const SERVER_CONVENTION = ['types', 'seed', 'service'];
const CLIENT_CONVENTION = ['types', 'view'];
const SERVER_EXT = ['.ts', '.js'];
const CLIENT_EXT = ['.tsx', '.ts', '.jsx', '.js'];

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

async function resolveFirst(dir: string, bases: string[], exts: string[]): Promise<string | null> {
  for (const base of bases) {
    for (const ext of exts) {
      const p = join(dir, base + ext);
      if (await exists(p)) return p;
    }
  }
  return null;
}

export async function loadLocalMods(modsDir: string, target: LoadTarget): Promise<LoadResult> {
  const result: LoadResult = { loaded: [], failed: [] };
  const entryBase = target === 'server' ? 'server' : 'client';
  const exts = target === 'server' ? SERVER_EXT : CLIENT_EXT;
  const convention = target === 'server' ? SERVER_CONVENTION : CLIENT_CONVENTION;
  let entries: import('node:fs').Dirent[];

  try {
    entries = await readdir(modsDir, { withFileTypes: true });
  } catch {
    return result;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;

    const modDir = join(modsDir, entry.name);
    const entryPath = await resolveFirst(modDir, [entryBase], exts);

    // Discover convention files if no explicit entry
    const filesToImport: string[] = [];
    if (entryPath) {
      filesToImport.push(entryPath);
    } else {
      for (const base of convention) {
        const p = await resolveFirst(modDir, [base], exts);
        if (p) filesToImport.push(p);
      }
    }

    if (filesToImport.length === 0) continue;

    const modEntry: LoadedMod = { name: entry.name, state: 'loading' };
    loaded.set(entry.name, modEntry);

    try {
      setCurrentMod(entry.name);
      for (const f of filesToImport) await import(f);
      setCurrentMod(null);
      modEntry.state = 'loaded';
      modEntry.loadedAt = Date.now();
      result.loaded.push(entry.name);
      loadSchemasFromDir(join(modDir, 'schemas'));
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      modEntry.state = 'failed';
      modEntry.error = error;
      result.failed.push({ name: entry.name, error });
    }
  }

  return result;
}

// ── Load all mods: internal + engine + project (CWD) ──

export async function loadAllMods(target: LoadTarget, ...extraDirs: string[]): Promise<LoadResult> {
  const internalDir = new URL('../mods', import.meta.url).pathname;
  const engineDir = new URL('../../../mods', import.meta.url).pathname;

  const dirs = [internalDir, engineDir];

  // CWD/mods/ if different from engine mods
  const projectDir = resolve('mods');
  if (resolve(projectDir) !== resolve(engineDir)) dirs.push(projectDir);

  dirs.push(...extraDirs);

  const seen = new Set<string>();
  const result: LoadResult = { loaded: [], failed: [] };

  for (const dir of dirs) {
    const abs = resolve(dir);
    if (seen.has(abs)) continue;
    seen.add(abs);

    const r = await loadLocalMods(dir, target);
    result.loaded.push(...r.loaded);
    result.failed.push(...r.failed);
  }

  for (const f of result.failed) log.error(`${f.name}: ${f.error.message}`);
  log.info(`loaded: ${result.loaded.join(', ')}`);

  return result;
}
