// Load JSON schemas into core registry
// Per-mod: each mod has schemas/ dir next to its source, loaded by mod loader

import { normalizeType, register, safeJsonParse } from '#core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function loadSchemasFromDir(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let count = 0;
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
    const raw = fs.readFileSync(path.join(dir, file), 'utf-8').trim();
    if (!raw) { console.warn(`[schema] empty: ${file}`); continue; }
    const schema = safeJsonParse(raw);
    if (!schema.$id) { console.warn(`[schema] no $id: ${file}`); continue; }
    schema.$id = normalizeType(schema.$id);
    register(schema.$id, 'schema', () => schema);
    count++;
  }
  return count;
}

const SCHEMA_RECURSE_SKIP = new Set(['node_modules', 'dist', 'build', '.git']);

/** Walk `root` recursively; for every directory named `schemas`, call loadSchemasFromDir.
 * Skips node_modules, dist, build, hidden dirs. */
export function loadSchemasRecursive(root: string): number {
  if (!fs.existsSync(root)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.') || SCHEMA_RECURSE_SKIP.has(entry.name)) continue;
    const sub = path.join(root, entry.name);
    if (entry.name === 'schemas') total += loadSchemasFromDir(sub);
    else total += loadSchemasRecursive(sub);
  }
  return total;
}

/** Load `./schemas/*.json` relative to caller's module — for tests that bypass mod loader.
 * Usage: `loadTestSchemas(import.meta.url)` */
export function loadTestSchemas(metaUrl: string): number {
  return loadSchemasFromDir(path.join(path.dirname(fileURLToPath(metaUrl)), 'schemas'));
}
