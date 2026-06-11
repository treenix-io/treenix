// Component-namespace migration: bare named components → '#'-prefixed keys (core-gk8.21).
// Runs automatically when an fs root opens (createFsTree → ensureMigrated). A
// `.treenix-version` marker in the root records the completed pass; the marker is
// correctness-bearing, not an optimization — after cutover a bare `{$type}` value
// is legitimate plain data (snapshot escape), so the rename pass must never run
// twice on the same root.
//
// Offline pre-review CLI (server stopped):
//
//   tsx src/tree/migrate-component-namespace.ts <fs-root> [...roots]          # dry-run
//   tsx src/tree/migrate-component-namespace.ts --write <fs-root> [...roots]  # apply + stamp
//
// Old semantics: any top-level non-$ value carrying $type WAS a component —
// so every such entry migrates; the meaning of existing data is preserved
// exactly. Query-mount `match` clauses referencing migrated component fields
// (run.status → #run.status) are reported for manual review, not rewritten:
// they describe OTHER nodes' shapes, which a single-file pass cannot verify.

import { isComponent, safeJsonParse } from '#core';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite } from './fs-atomic';

export const NS_VERSION = 1;
export const VERSION_FILE = '.treenix-version';

type Stats = { files: number; migrated: number; renames: number; warnings: string[] };

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
        const warning = `${file}: query-mount match key "${mk}" may need the '#' prefix`;
        stats.warnings.push(warning);
        log(`  WARN ${warning} — review manually`);
      }
    }
  }

  return changed;
}

export async function migrateFsRoot(root: string, write: boolean, log: (line: string) => void = console.log): Promise<Stats> {
  const stats: Stats = { files: 0, migrated: 0, renames: 0, warnings: [] };

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

export async function readDataVersion(root: string): Promise<number> {
  let text: string;
  try {
    text = await readFile(join(root, VERSION_FILE), 'utf-8');
  } catch (e: any) {
    if (e.code === 'ENOENT') return 0;
    throw e;
  }

  const v = Number(text.trim());
  if (!Number.isInteger(v) || v <= 0) {
    throw new Error(`${join(root, VERSION_FILE)}: corrupted version marker ${JSON.stringify(text)}`);
  }
  return v;
}

export async function stampVersion(root: string): Promise<void> {
  await atomicWrite(join(root, VERSION_FILE), `${NS_VERSION}\n`);
}

// Boot gate, called by createFsTree before a root is served.
export async function ensureMigrated(root: string, log: (line: string) => void = console.log): Promise<void> {
  const version = await readDataVersion(root);
  if (version > NS_VERSION) {
    throw new Error(`${root}: data version ${version} is newer than this engine supports (${NS_VERSION}) — upgrade the engine`);
  }
  if (version === NS_VERSION) return;

  // Dry pass first: a match-key warning must abort with ZERO files touched.
  const dry = await migrateFsRoot(root, false, () => {});
  if (dry.warnings.length > 0) {
    throw new Error(
      `${root}: component-namespace migration blocked — query-mount match keys need manual review:\n`
      + dry.warnings.map(w => `  ${w}`).join('\n')
      + `\nPrefix keys that address component fields with '#' ("task.status" → "#task.status"), then restart.`,
    );
  }

  if (dry.migrated > 0) {
    const s = await migrateFsRoot(root, true, log);
    log(`[treenix] ${root}: component namespace migrated — ${s.migrated} files, ${s.renames} renames`);
  }

  // Stamp LAST: a crash mid-pass leaves no marker, so the next open resumes (renames are idempotent).
  await stampVersion(root);
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
      console.log(`  files=${s.files} migrated=${s.migrated} renames=${s.renames} warnings=${s.warnings.length}`);
      if (!write && s.migrated > 0) console.log('  (re-run with --write to apply)');

      if (write) {
        if (s.warnings.length === 0) {
          await stampVersion(root);
          console.log(`  stamped ${VERSION_FILE}=${NS_VERSION}`);
        } else {
          console.log(`  ${VERSION_FILE} NOT stamped — fix the match keys above, then re-run --write`);
        }
      }
    }
  };
  run().catch(err => { console.error(err); process.exit(1); });
}
