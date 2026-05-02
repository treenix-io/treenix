// Treenix vite plugin:
// 1. Resolve #subpath imports via nearest package.json (Vite doesn't support them)
// 2. Resolve @treenx/* exports with array conditions (Vite bug #16153)
// 3. Auto-discover mod client.ts → virtual:mod-clients
// 4. Block server.ts from frontend bundle

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Plugin } from 'vite';

// ── Package.json resolution ──

type SpecValue = string | string[] | Record<string, string | string[]>;
type FieldMap = Record<string, SpecValue>;

const pkgCache = new Map<string, { dir: string; name?: string; imports?: FieldMap; exports?: FieldMap } | null>();

function readPkg(startDir: string) {
  if (pkgCache.has(startDir)) return pkgCache.get(startDir)!;

  let current = startDir;
  while (current !== dirname(current)) {
    const pkgPath = join(current, 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      if (pkg.imports || pkg.exports) {
        const result = { dir: current, name: pkg.name as string | undefined, imports: pkg.imports as FieldMap, exports: pkg.exports as FieldMap };
        pkgCache.set(startDir, result);
        return result;
      }
    }
    current = dirname(current);
  }

  pkgCache.set(startDir, null);
  return null;
}

// Cache for @treenx/* package dirs
const treenixPkgCache = new Map<string, { dir: string; exports: FieldMap } | null>();

function findTreenixPkg(name: string): { dir: string; exports: FieldMap } | null {
  if (treenixPkgCache.has(name)) return treenixPkgCache.get(name)!;

  // Walk up from CWD to find node_modules/@treenx/<name>
  let current = process.cwd();
  while (current !== dirname(current)) {
    const pkgDir = join(current, 'node_modules', name);
    const pkgPath = join(pkgDir, 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      // Follow symlink to real path for resolution
      const realDir = realpathSync(pkgDir);
      const result = pkg.exports ? { dir: realDir, exports: pkg.exports as FieldMap } : null;
      treenixPkgCache.set(name, result);
      return result;
    }
    current = dirname(current);
  }

  treenixPkgCache.set(name, null);
  return null;
}

function resolveConditions(pkgDir: string, spec: SpecValue, conditions: string[]): string[] {
  if (typeof spec === 'string') return [resolve(pkgDir, spec)];
  if (Array.isArray(spec)) return spec.map(s => resolve(pkgDir, s));

  for (const cond of conditions) {
    if (spec[cond]) return resolveConditions(pkgDir, spec[cond], conditions);
  }
  if (spec.default) return resolveConditions(pkgDir, spec.default, conditions);
  return [];
}

function isFile(p: string): boolean {
  return existsSync(p) && statSync(p).isFile();
}

const EXT = ['.ts', '.tsx', '.js', '.jsx'];
const IDX = ['/index.ts', '/index.tsx', '/index.js', '/index.jsx'];

function tryResolve(candidates: string[]): string | undefined {
  for (const c of candidates) {
    if (isFile(c)) return c;
    for (const ext of EXT) { if (isFile(c + ext)) return c + ext; }
    for (const idx of IDX) { if (isFile(c + idx)) return c + idx; }
  }
}

function expandWildcard(spec: SpecValue, matched: string): SpecValue {
  if (typeof spec === 'string') return spec.replace('*', matched);
  if (Array.isArray(spec)) return spec.map(s => s.replace('*', matched));
  return Object.fromEntries(
    Object.entries(spec).map(([k, v]) => [k, expandWildcard(v, matched)])
  ) as SpecValue;
}

function matchPattern(id: string, map: FieldMap, pkgDir: string, conditions: string[]): string | undefined {
  for (const [pattern, spec] of Object.entries(map)) {
    if (pattern === id) {
      return tryResolve(resolveConditions(pkgDir, spec, conditions));
    }

    if (pattern.includes('*')) {
      const [prefix, suffix] = pattern.split('*');
      if (id.startsWith(prefix) && (!suffix || id.endsWith(suffix))) {
        const matched = id.slice(prefix.length, suffix ? -suffix.length || undefined : undefined);
        return tryResolve(resolveConditions(pkgDir, expandWildcard(spec, matched), conditions));
      }
    }
  }
}

// ── Mod discovery ──

const VIRTUAL_ID = 'virtual:mod-clients';
const RESOLVED_ID = '\0' + VIRTUAL_ID;
const SERVER_RE = /\/mods\/[^/]+\/server(\.ts)?$/;

// Default convention. react.tsx is the preferred name (filename = first-level context,
// see docs/concepts/context.md). view.tsx kept as legacy alias during migration.
// Override via plugin opts.clientFiles — e.g. RN build passes ['types.ts', 'rn.tsx'].
const DEFAULT_CLIENT_FILES = ['types.ts', 'react.tsx', 'view.tsx'];

type ModEntry = { name: string; files: string[] };

function scanClients(dir: string, clientFiles: string[], warnIfMissing = true): ModEntry[] {
  if (!existsSync(dir)) {
    if (warnIfMissing) console.warn(`[treenix] modsDir not found, skipped: ${dir}`);
    return [];
  }
  const mods: ModEntry[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const modDir = resolve(dir, entry.name);
    const client = resolve(modDir, 'client.ts');
    if (existsSync(client)) {
      mods.push({ name: entry.name, files: [client] });
    } else {
      const files = clientFiles
        .map(f => resolve(modDir, f))
        .filter(f => existsSync(f));
      if (files.length) mods.push({ name: entry.name, files });
    }
  }
  return mods;
}

// Scan node_modules for @treenx/* packages with treenix.clients field
function discoverPackageClients(): string[] {
  const imports: string[] = [];
  let current = process.cwd();

  while (current !== dirname(current)) {
    const nmDir = join(current, 'node_modules', '@treenx');
    if (existsSync(nmDir)) {
      for (const entry of readdirSync(nmDir, { withFileTypes: true })) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        const pkgPath = join(nmDir, entry.name, 'package.json');
        if (!existsSync(pkgPath)) continue;
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
        // TODO: fix this, mods search should be more clever
        if (pkg.treenix?.clients) {
          const realDir = realpathSync(join(nmDir, entry.name));
          const clientsPath = resolve(realDir, pkg.treenix.clients);
          if (existsSync(clientsPath)) imports.push(clientsPath);
        }
      }
      break; // found node_modules, stop walking up
    }
    current = dirname(current);
  }

  return imports;
}

// ── Plugin ──

export default function treenixPlugin(opts?: { modsDirs?: string[]; clientFiles?: string[] }): Plugin {
  const engineRoot = resolve(import.meta.dirname, '../../..');
  // In npm installs engineRoot = node_modules/, which has no sibling mods/ —
  // engine mods scan is a monorepo-dev convenience only.
  const inNodeModules = import.meta.dirname.includes('/node_modules/');
  const clientFiles = opts?.clientFiles ?? DEFAULT_CLIENT_FILES;
  let conditions: string[] = [];

  return {
    name: 'treenix',
    enforce: 'pre',

    configResolved(config) {
      conditions = (config.resolve.conditions ?? []).concat('default');
    },

    resolveId(id, importer) {
      if (id === VIRTUAL_ID) return RESOLVED_ID;
      if (!importer) return;


      // Block server.ts from frontend + resolve relative imports in @treenx packages
      if (id.startsWith('.')) {
        const resolved = resolve(importer, '..', id).replace(/\\/g, '/');

        // Relative imports within @treenx packages: resolve explicitly so module IDs
        // match plugin-resolved @treenx/* paths (prevents ?v= hash mismatch and the
        // /src/* vs /@fs/.../packages/*/src/* dual-URL issue → dual module instances).
        // Match BOTH installed packages (node_modules) and monorepo workspaces — the
        // older guard was node_modules-only and missed dev-mode workspace symlinks.
        if (importer.includes('/node_modules/@treenx/')) {
          return tryResolve([resolved]);
        }
        const importerPkg = readPkg(dirname(importer));
        if (importerPkg?.name?.startsWith?.('@treenx/')) {
          return tryResolve([resolved]);
        }

        if (SERVER_RE.test(resolved)) {
          this.error(
            `Server module imported in frontend build: "${id}"\n` +
            `  from: ${importer}\n` +
            `  Mods must not import server.ts from client code`
          );
        }
      }

      // Resolve # imports via nearest package.json imports field
      if (id.startsWith('#')) {
        const pkg = readPkg(dirname(importer));
        if (pkg?.imports) {
          // Inside node_modules: skip 'development' condition to stay in dist/
          // (dist files use relative ./hooks, # must resolve to same dist files)
          const isNm = importer.includes('/node_modules/');
          const conds = isNm ? conditions.filter(c => c !== 'development') : conditions;
          return matchPattern(id, pkg.imports, pkg.dir, conds);
        }
      }

      // Resolve @treenx/* exports (Vite doesn't handle array conditions)
      if (id.startsWith('@treenx/')) {
        const parts = id.split('/');
        const pkgName = parts.slice(0, 2).join('/');
        const subpath = './' + parts.slice(2).join('/');
        const pkg = findTreenixPkg(pkgName);
        if (pkg?.exports) {
          return matchPattern(parts.length > 2 ? subpath : '.', pkg.exports, pkg.dir, conditions);
        }
      }
    },

    load(id) {
      if (id !== RESOLVED_ID) return;

      // 1. Auto-discover @treenx/* packages with treenix.clients
      const pkgClients = discoverPackageClients();

      // 2. Engine mods (sibling to this plugin's package) — monorepo-dev only
      const engineMods = inNodeModules ? [] : scanClients(resolve(engineRoot, 'mods'), clientFiles);

      // 3. Extra mods dirs (passed explicitly from project vite config)
      const extraMods = (opts?.modsDirs ?? []).flatMap(d => scanClients(resolve(d), clientFiles));

      // Dedupe by mod name (realpath of first file)
      const seen = new Set<string>();
      const allMods: ModEntry[] = [];

      // pkgClients are plain paths (from npm packages) — wrap as ModEntry
      for (const p of pkgClients) {
        const real = realpathSync(p);
        if (!seen.has(real)) {
          seen.add(real);
          const name = p.match(/\/([^/]+)\/client\.ts$/)?.[1] ?? p.split('/').at(-2) ?? p;
          allMods.push({ name, files: [p] });
        }
      }

      for (const mod of [...engineMods, ...extraMods]) {
        const real = realpathSync(mod.files[0]);
        if (!seen.has(real)) { seen.add(real); allMods.push(mod); }
      }

      // Dynamic imports — each mod loads independently, failures don't crash the app
      const lines = allMods.map(mod => {
        const imports = mod.files.map(f => `import('${f}')`).join(', ');
        return `  loadMod('${mod.name}', async () => { await Promise.all([${imports}]); })`;
      });

      return [
        `import { loadMod } from '@treenx/react/mod-errors';`,
        'await Promise.allSettled([',
        lines.join(',\n'),
        ']);',
        '',
      ].join('\n');
    },
  };
}
