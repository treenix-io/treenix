// Read colocated JSON schemas for publication by the owning module.

import { normalizeType } from '#core';
import { safeJsonParse } from '#util/json';
import fs from 'node:fs';
import path from 'node:path';
import type { TypeSchema } from './types';

type LoadedSchema = TypeSchema & { $id: string };

export function readSchemasFromDir(dir: string): LoadedSchema[] {
  if (!fs.existsSync(dir)) return [];
  const schemas: LoadedSchema[] = [];
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
    const full = path.join(dir, file);
    const raw = fs.readFileSync(full, 'utf-8').trim();
    if (!raw) throw new Error(`[schema] ${full}: file is empty — delete it or fill in the schema`);
    const schema: LoadedSchema = safeJsonParse(raw);
    if (!schema || typeof schema !== 'object') throw new Error(`[schema] ${full}: parsed value is not an object`);
    if (!schema.$id) throw new Error(`[schema] ${full}: missing "$id" — required for registry lookup`);
    schema.$id = normalizeType(schema.$id);
    schemas.push(schema);
  }
  return schemas;
}

const SCHEMA_RECURSE_SKIP = new Set(['node_modules', 'dist', 'build', '.git']);

export function visitSchemaDirectories(root: string, visit: (directory: string) => number): number {
  if (!fs.existsSync(root)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.') || SCHEMA_RECURSE_SKIP.has(entry.name)) continue;
    const sub = path.join(root, entry.name);
    if (entry.name === 'schemas') total += visit(sub);
    else total += visitSchemaDirectories(sub, visit);
  }
  return total;
}

