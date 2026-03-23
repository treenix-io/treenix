// Treenity vite plugin:
// 1. Resolve #subpath imports via nearest package.json (Vite doesn't support them)
// 2. Resolve @treenity/* exports with array conditions (Vite bug #16153)
// 3. Auto-discover mod client.ts → virtual:mod-clients
// 4. Block server.ts from frontend bundle

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Plugin } from 'vite';

// ── Package.json resolution ──

type SpecValue = string | string[] | Record<string, string | string[]>;
type FieldMap = Record<string, SpecValue>;

const pkgCache = new Map<string, { dir: string; imports?: FieldMap; exports?: FieldMap } | null>();

function readPkg(startDir: string) {
  if (pkgCache.has(startDir)) return pkgCache.get(startDir)!;

  let current = startDir;
  while (current !== dirname(current)) {
    const pkgPath = join(current, 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      if (pkg.imports || pkg.exports) {
        const result = { dir: current, imports: pkg.imports as FieldMap, exports: pkg.exports as FieldMap };
        pkgCache.set(startDir, result);
        return result;
      }
    }
    current = dirname(current);
  }

  pkgCache.set(startDir, null);
  return null;
}

// Cache for @treenity/* package dirs
const treenityPkgCache = new Map<string, { dir: string; exports: FieldMap } | null>();

function findTreenityPkg(name: string): { dir: string; exports: FieldMap } | null {
  if (treenityPkgCache.has(name)) return treenityPkgCache.get(name)!;

  // Walk up from CWD to find node_modules/@treenity/<name>
  let current = process.cwd();
  while (current !== dirname(current)) {
    const pkgDir = join(current, 'node_modules', name);
    const pkgPath = join(pkgDir, 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      // Follow symlink to real path for resolution
      const realDir = realpathSync(pkgDir);
      const result = pkg.exports ? { dir: realDir, exports: pkg.exports as FieldMap } : null;
      treenityPkgCache.set(name, result);
      return result;
    }
    current = dirname(current);
  }

  treenityPkgCache.set(name, null);
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

function scanClients(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const clients: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const client = resolve(dir, entry.name, 'client.ts');
    if (existsSync(client)) clients.push(client);
  }
  return clients;
}

// Scan node_modules for @treenity/* packages with treenity.clients field
function discoverPackageClients(): string[] {
  const imports: string[] = [];
  let current = process.cwd();

  while (current !== dirname(current)) {
    const nmDir = join(current, 'node_modules', '@treenity');
    if (existsSync(nmDir)) {
      for (const entry of readdirSync(nmDir, { withFileTypes: true })) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        const pkgPath = join(nmDir, entry.name, 'package.json');
        if (!existsSync(pkgPath)) continue;
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
        if (pkg.treenity?.clients) {
          const realDir = realpathSync(join(nmDir, entry.name));
          const clientsPath = resolve(realDir, pkg.treenity.clients);
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

export default function treenityPlugin(opts?: { modsDirs?: string[] }): Plugin {
  const engineRoot = resolve(import.meta.dirname, '../..');
  let conditions: string[] = [];

  return {
    name: 'treenity',
    enforce: 'pre',

    configResolved(config) {
      conditions = (config.resolve.conditions ?? []).concat('default');
    },

    resolveId(id, importer) {
      if (id === VIRTUAL_ID) return RESOLVED_ID;
      if (!importer) return;


      // Block server.ts from frontend + resolve relative imports in @treenity packages
      if (id.startsWith('.')) {
        const resolved = resolve(importer, '..', id).replace(/\\/g, '/');

        // Relative imports within @treenity packages: resolve explicitly so module IDs
        // match plugin-resolved @treenity/* paths (prevents ?v= hash mismatch → dual modules)
        if (importer.includes('/node_modules/@treenity/')) {
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

      // Resolve @treenity/* exports (Vite doesn't handle array conditions)
      if (id.startsWith('@treenity/')) {
        const parts = id.split('/');
        const pkgName = parts.slice(0, 2).join('/');
        const subpath = './' + parts.slice(2).join('/');
        const pkg = findTreenityPkg(pkgName);
        if (pkg?.exports) {
          return matchPattern(parts.length > 2 ? subpath : '.', pkg.exports, pkg.dir, conditions);
        }
      }
    },

    load(id) {
      if (id !== RESOLVED_ID) return;

      // 1. Auto-discover @treenity/* packages with treenity.clients
      const pkgClients = discoverPackageClients();

      // 2. Engine mods (sibling to this plugin's package)
      const engineMods = scanClients(resolve(engineRoot, 'mods'));

      // 3. Extra mods dirs (passed explicitly from project vite config)
      const extraMods = (opts?.modsDirs ?? []).flatMap(d => scanClients(resolve(d)));

      // Dedupe by realpath
      const seen = new Set<string>();
      const imports: string[] = [];
      for (const p of [...pkgClients, ...engineMods, ...extraMods]) {
        const real = realpathSync(p);
        if (!seen.has(real)) { seen.add(real); imports.push(p); }
      }

      // Dynamic imports — each mod loads independently, failures don't crash the app
      const lines = imports.map(p => {
        const name = p.match(/\/([^/]+)\/client\.ts$/)?.[1] ?? p.split('/').at(-2) ?? p;
        return `  loadMod('${name}', () => import('${p}'))`;
      });

      return [
        `import { loadMod } from '@treenity/react/mod-errors';`,
        'await Promise.allSettled([',
        lines.join(',\n'),
        ']);',
        '',
      ].join('\n');
    },
  };
}
