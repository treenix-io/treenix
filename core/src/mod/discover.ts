// Treenix Module Discovery
// npm: scan node_modules for packages with "treenix" field
// local: scan dir for subdirs with index.ts exporting defineMod()

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ModManifest, TreenixMod } from './types';

// ── npm discovery ──

export async function discoverMods(nodeModulesPath: string): Promise<ModManifest[]> {
  const results: ModManifest[] = [];
  let entries: string[];

  try {
    entries = await readdir(nodeModulesPath);
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (entry.startsWith('.')) continue;

    // Scoped packages: @scope/pkg
    if (entry.startsWith('@')) {
      let scoped: string[];
      try {
        scoped = await readdir(join(nodeModulesPath, entry));
      } catch { continue; }

      for (const sub of scoped) {
        const m = await readManifest(join(nodeModulesPath, entry, sub));
        if (m) results.push(m);
      }
      continue;
    }

    const m = await readManifest(join(nodeModulesPath, entry));
    if (m) results.push(m);
  }

  return results;
}

async function readManifest(packageDir: string): Promise<ModManifest | null> {
  try {
    const raw = await readFile(join(packageDir, 'package.json'), 'utf-8');
    const pkg = JSON.parse(raw);
    if (!pkg.treenix) return null;

    const t = pkg.treenix;
    return {
      name: t.name ?? pkg.name,
      version: t.version ?? pkg.version ?? '0.0.0',
      types: t.types,
      dependencies: t.dependencies,
      server: t.server,
      client: t.client,
      seed: t.seed,
      packagePath: packageDir,
    };
  } catch {
    return null;
  }
}

// ── Local discovery (server-side, dynamic import) ──

export async function discoverLocalMods(modsDir: string): Promise<TreenixMod[]> {
  const results: TreenixMod[] = [];
  let entries: import('node:fs').Dirent[];

  try {
    entries = await readdir(modsDir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;

    const indexPath = join(modsDir, entry.name, 'index.ts');

    try {
      await stat(indexPath);
    } catch {
      continue; // no index.ts — not a mod
    }

    try {
      const exported = await import(indexPath);
      const mod = exported.default as TreenixMod;
      if (mod?.name) results.push(mod);
    } catch (err) {
      console.warn(`[mod] failed to load ${entry.name}:`, err instanceof Error ? err.message : err);
    }
  }

  return results;
}
