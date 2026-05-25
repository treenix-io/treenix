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
  } catch (e: any) {
    if (e?.code === 'ENOENT') return results;
    throw e;
  }

  for (const entry of entries) {
    if (entry.startsWith('.')) continue;

    // Scoped packages: @scope/pkg
    if (entry.startsWith('@')) {
      let scoped: string[];
      try {
        scoped = await readdir(join(nodeModulesPath, entry));
      } catch (e: any) {
        if (e?.code === 'ENOENT') continue;
        console.warn(`[mod-discover] readdir ${entry} failed:`, e?.message ?? e);
        continue;
      }

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
  let raw: string;
  try {
    raw = await readFile(join(packageDir, 'package.json'), 'utf-8');
  } catch (e: any) {
    if (e?.code === 'ENOENT') return null;
    console.warn(`[mod-discover] failed to read ${packageDir}/package.json:`, e?.message ?? e);
    return null;
  }
  let pkg: any;
  try {
    pkg = JSON.parse(raw);
  } catch (e: any) {
    console.warn(`[mod-discover] invalid JSON in ${packageDir}/package.json:`, e?.message ?? e);
    return null;
  }
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
}

// ── Local discovery (server-side, dynamic import) ──

export async function discoverLocalMods(modsDir: string): Promise<TreenixMod[]> {
  const results: TreenixMod[] = [];
  let entries: import('node:fs').Dirent[];

  try {
    entries = await readdir(modsDir, { withFileTypes: true });
  } catch (e: any) {
    if (e?.code === 'ENOENT') return results;
    throw e;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;

    const indexPath = join(modsDir, entry.name, 'index.ts');

    try {
      await stat(indexPath);
    } catch (e: any) {
      if (e?.code === 'ENOENT') continue; // not a mod
      console.warn(`[mod-discover] stat ${indexPath} failed:`, e?.message ?? e);
      continue;
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
