// Offline migration: bare named components → '#'-prefixed keys (core-gk8.21).
// One-shot, run per FS tree root while the server is STOPPED:
//
//   tsx src/tree/migrate-component-namespace.ts <fs-root> [...roots]          # dry-run
//   tsx src/tree/migrate-component-namespace.ts --write <fs-root> [...roots]  # apply
//
// Old semantics: any top-level non-$ value carrying $type WAS a component —
// so every such entry migrates; the meaning of existing data is preserved
// exactly. Query-mount `match` clauses referencing migrated component fields
// (run.status → #run.status) are reported for manual review, not rewritten:
// they describe OTHER nodes' shapes, which a single-file pass cannot verify.

import { isComponent, safeJsonParse } from '#core';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite } from './fs';

type Stats = { files: number; migrated: number; renames: number; warnings: number };

function transformNode(obj: Record<string, unknown>, file: string, stats: Stats, log: (line: string) => void): boolean {
  let changed = false;

  for (const key of Object.keys(obj)) {
    if (key.startsWith('$')) continue;
    if (key.startsWith('#')) {
      if (!isComponent(obj[key])) {
        throw new Error(`${file}: malformed component entry "${key}" — value has no $type`);
      }
      continue;
    }
    if (!isComponent(obj[key])) continue;

    const target = `#${key}`;
    if (target in obj) {
      throw new Error(`${file}: cannot migrate "${key}" — "${target}" already exists`);
    }
    obj[target] = obj[key];
    delete obj[key];
    stats.renames++;
    changed = true;
    log(`  ${file}: ${key} → ${target}`);
  }

  // Query mounts: match keys address fields of the SOURCE's nodes; if those
  // nodes had bare components, the clause must become '#run.status' by hand.
  const mount = obj['#mount'];
  if (isComponent(mount) && mount.$type === 't.mount.query') {
    const match = (mount as { match?: Record<string, unknown> }).match;
    for (const mk of Object.keys(match ?? {})) {
      if (!mk.startsWith('$') && !mk.startsWith('_') && !mk.startsWith('#') && mk.includes('.')) {
        stats.warnings++;
        log(`  WARN ${file}: query-mount match key "${mk}" may need the '#' prefix — review manually`);
      }
    }
  }

  return changed;
}

export async function migrateFsRoot(root: string, write: boolean, log: (line: string) => void = console.log): Promise<Stats> {
  const stats: Stats = { files: 0, migrated: 0, renames: 0, warnings: 0 };

  for (const entry of await readdir(root, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const file = join(entry.parentPath, entry.name);
    stats.files++;

    const obj = safeJsonParse(await readFile(file, 'utf-8'));
    if (!transformNode(obj, file, stats, log)) continue;

    stats.migrated++;
    if (write) await atomicWrite(file, JSON.stringify(obj, null, 2) + '\n');
  }

  return stats;
}

const isCliEntry = process.argv[1]?.endsWith('migrate-component-namespace.ts');
if (isCliEntry) {
  const args = process.argv.slice(2);
  const write = args.includes('--write');
  const roots = args.filter(a => a !== '--write');

  if (roots.length === 0) {
    console.error('Usage: tsx src/tree/migrate-component-namespace.ts [--write] <fs-root> [...roots]');
    process.exit(1);
  }

  const run = async () => {
    for (const root of roots) {
      console.log(`${write ? 'Migrating' : 'Dry-run'}: ${root}`);
      const s = await migrateFsRoot(root, write);
      console.log(`  files=${s.files} migrated=${s.migrated} renames=${s.renames} warnings=${s.warnings}`);
      if (!write && s.migrated > 0) console.log('  (re-run with --write to apply)');
    }
  };
  run().catch(err => { console.error(err); process.exit(1); });
}
