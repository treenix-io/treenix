// Treenix Module Loader — dependency sort, load, seed

import { isInsideRoot } from '#core/path';
import { createLogger } from '#log';
import { loadSchemasRecursive } from '#schema/load';
import type { Tree } from '#tree';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setCurrentMod } from './tracking';
import type { LoadedMod, ModManifest, TreenixMod } from './types';

const log = createLogger('mod');

export function confine(packagePath: string, candidate: string): string {
  const root = resolve(packagePath);
  const full = resolve(packagePath, candidate);
  if (!isInsideRoot(root, full)) {
    throw new Error(`Manifest path escapes package root: ${candidate} → ${full}`);
  }
  return full;
}

// R4-BOOT-2: realpath-aware containment. Lexical confine() doesn't follow symlinks, but
// `import` does — a malicious package can ship `seed.js` as a symlink to `../../etc/payload.js`,
// pass lexical confine, then load the foreign code. Resolve real paths and re-assert before
// returning the importable path. Only used by the load entry points where `import` runs.
async function confineReal(packagePath: string, candidate: string): Promise<string> {
  const lexical = confine(packagePath, candidate);
  // realpath throws ENOENT for missing files — let that propagate as a real error.
  const realRoot = await realpath(resolve(packagePath));
  const realFull = await realpath(lexical);
  if (!isInsideRoot(realRoot, realFull)) {
    throw new Error(`Symlink escapes package root: ${candidate} → ${realFull} (root ${realRoot})`);
  }
  return realFull;
}

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
      let mod: TreenixMod | undefined;

      if (entryPath && manifest.packagePath) {
        const fullPath = await confineReal(manifest.packagePath, entryPath);
        // R4-BOOT-4: must reset currentMod even if import throws — otherwise the next mod's
        // register() calls attribute their types to the failed mod's name.
        setCurrentMod(manifest.name);
        try {
          const exported = await import(fullPath);
          mod = exported.default as TreenixMod;
        } finally {
          setCurrentMod(null);
        }
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
          // R4-BOOT-2: seed import must use realpath-confine, not lexical confine — `import`
          // follows symlinks; a `manifest.seed = "seed.js"` symlink to `../../etc/payload.js`
          // passes lexical confine but loads foreign code.
          const seedMod = await import(await confineReal(manifest.packagePath, manifest.seed));
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

      // Load per-mod schemas — walks the mod tree for any `schemas/` dir.
      if (manifest.packagePath) {
        const entryPath = target === 'server' ? manifest.server : manifest.client;
        if (entryPath) loadSchemasRecursive(join(manifest.packagePath, dirname(entryPath)));
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

// Mods shipped as a published npm package live under node_modules/<pkg>/<mod>/<entry>.ts.
// Importing the absolute .ts path bypasses the package's `exports` map and forces Node's
// native strip-types path, which refuses .ts files inside node_modules
// (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING). The package, however, also ships compiled
// .js at <pkg>/dist/<mod>/<entry>.js and `exports` maps `./<mod>/<entry>` to either the .ts
// source (development condition) or the dist .js (default condition). Importing through
// the package specifier respects exports, so plain `node` picks .js and tsx (or any
// resolver running with --conditions development) picks .ts. Result: the bundled .js path
// works out of the box, no tsx required for npm-published mods.
async function packageNameAt(modsDir: string): Promise<string | null> {
  try {
    const pkg = JSON.parse(await readFile(join(modsDir, 'package.json'), 'utf-8')) as { name?: unknown };
    return typeof pkg.name === 'string' ? pkg.name : null;
  } catch {
    return null;
  }
}

function basenameNoExt(p: string): string {
  const slash = p.lastIndexOf('/');
  const name = slash >= 0 ? p.slice(slash + 1) : p;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
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

  // Inside node_modules, prefer importing through the package specifier so the package's
  // `exports` map picks the compiled .js by default (and the .ts source under `development`).
  // Sidesteps Node 25's strip-types refusal for .ts files in node_modules.
  const pkgName = modsDir.includes('/node_modules/') ? await packageNameAt(modsDir) : null;

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
      // R4-BOOT-4: reset currentMod even on import-throw — prevents cross-attribution
      // of the next mod's register() calls to this failed mod.
      // R4-BOOT-2: realpath-confine each file inside modDir — symlinked entry files inside
      // a real mod dir would otherwise import code outside the mod root.
      setCurrentMod(entry.name);
      try {
        for (const f of filesToImport) {
          const real = await confineReal(modDir, f);
          if (pkgName) {
            // pkgName/<mod>/<entry> → exports field decides .ts vs .js
            await import(`${pkgName}/${entry.name}/${basenameNoExt(real)}`);
          } else if (real.endsWith('.ts') || real.endsWith('.tsx')) {
            // Project-local TS: tsx's `tsImport` does strip-types + extensionless-import resolution
            // programmatically, without registering global ESM hooks (so no conflict with Vite's
            // `Module.registerHooks`). Required because Node 22 has no native strip-types and Node 25's
            // native strip-types doesn't resolve extensionless imports. `tsx` is an optional
            // peerDependency — lazy import lets servers without project-local .ts mods skip it.
            const { tsImport } = await import('tsx/esm/api');
            await tsImport(real, { parentURL: pathToFileURL(real).href });
          } else {
            await import(real);
          }
        }
      } finally {
        setCurrentMod(null);
      }
      modEntry.state = 'loaded';
      modEntry.loadedAt = Date.now();
      result.loaded.push(entry.name);
      loadSchemasRecursive(modDir);
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

  // R4-BOOT-1: cwd/mods and caller-supplied extraDirs (e.g. MODS_DIR) load by default.
  // Opt out via TREENIX_UNTRUSTED_MODS_DIR=1 in environments where those paths are attacker-writable
  // (shared CI runner pulling untrusted PR diffs, multi-tenant box with untrusted writers) — there
  // a malicious mod at boot = arbitrary RCE.
  const trustExtraDirs = process.env.TREENIX_UNTRUSTED_MODS_DIR !== '1';
  if (trustExtraDirs) {
    // CWD/mods/ if different from engine mods
    const projectDir = resolve('mods');
    if (resolve(projectDir) !== resolve(engineDir)) dirs.push(projectDir);
    dirs.push(...extraDirs);
  } else if (extraDirs.length) {
    console.warn('[mod-loader] ignoring %d extra mod dir(s) — TREENIX_UNTRUSTED_MODS_DIR=1 is set', extraDirs.length);
  }

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
