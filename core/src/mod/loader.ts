// Treenix Module Loader — side-effect imports and schema discovery

import { isInsideRoot } from '#core/path';
import { safeJsonParse } from '#core/json';
import { createLogger } from '#log';
import { loadSchemasRecursive } from '#schema/load';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setCurrentMod } from './tracking';
import type { LoadedMod } from './types';

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

// ── Registry of loaded mods ──

const loaded = new Map<string, LoadedMod>();

export function getLoadedMods(): LoadedMod[] {
  return [...loaded.values()];
}

export function isModLoaded(name: string): boolean {
  return loaded.get(name)?.state === 'loaded';
}

export function clearModRegistry(): void {
  loaded.clear();
}

export type LoadTarget = 'server' | 'client';

export interface LoadResult {
  loaded: string[];
  failed: { name: string; error: Error }[];
}

// ── Local mod loader (side-effect imports from src/mods/) ──

// Convention files for auto-discovery when server/client entry is absent.
// Each bare name is tried with both .ts (source-shipped packages) and .js (dist-shipped).
const SERVER_CONVENTION = ['types', 'seed', 'service'];
const CLIENT_CONVENTION = ['types', 'view'];
const SERVER_EXT = ['.ts', '.js'];
const CLIENT_EXT = ['.tsx', '.ts', '.jsx', '.js'];

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
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
    const pkg = safeJsonParse(await readFile(join(modsDir, 'package.json'), 'utf-8'));
    if (typeof pkg.name !== 'string' || pkg.name.length === 0) throw new TypeError('The mod package needs a name');
    return pkg.name;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function basenameNoExt(p: string): string {
  const slash = p.lastIndexOf('/');
  const name = slash >= 0 ? p.slice(slash + 1) : p;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

// Project-local TS mods (outside node_modules) need TypeScript handling for two reasons:
// (a) Node 22 has no native strip-types at all;
// (b) Node 25 has it but doesn't resolve extensionless `import './foo'`.
// We register tsx as a GLOBAL ESM loader hook once, then use plain `await import(real)` so
// the whole import graph (the mod and its transitive deps) shares a single module map —
// crucial so all module-level state in @treenx/core (e.g. the prefab map in mod/prefab.ts)
// has ONE instance across factory + all mods. tsx's scoped `tsImport` would put each mod
// in its own loader scope, dual-instancing every module that registers prefabs/services.
// The Vite 8 × tsx race that justified an earlier `tsImport` workaround no longer applies:
// the server is now spawned as a child process (see @treenx/core/vite-plugin), outside
// Vite's hooks entirely.
let _tsxRegistered: Promise<void> | null = null;
async function ensureTsxRegistered(): Promise<void> {
  _tsxRegistered ??= import('tsx/esm/api').then(({ register }) => { register(); });
  return _tsxRegistered;
}


export async function loadLocalMods(modsDir: string, target: LoadTarget): Promise<LoadResult> {
  const result: LoadResult = { loaded: [], failed: [] };
  const entryBase = target === 'server' ? 'server' : 'client';
  const exts = target === 'server' ? SERVER_EXT : CLIENT_EXT;
  const convention = target === 'server' ? SERVER_CONVENTION : CLIENT_CONVENTION;
  let entries: import('node:fs').Dirent[];

  try {
    entries = await readdir(modsDir, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return result;
    throw error;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));

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
            await ensureTsxRegistered();
            await import(real);
          } else {
            await import(real);
          }
        }
        loadSchemasRecursive(modDir);
      } finally {
        setCurrentMod(null);
      }
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
