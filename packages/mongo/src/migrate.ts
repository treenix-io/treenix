// Mongo counterpart of the fs component-namespace boot-gate (core-r096).
//
// UNLIKE the fs pass, this gate NEVER renames automatically. The fs migration
// was safe only because it ran exactly at cutover, before any post-cutover
// data existed. Mongo collections meet this gate LATE: they hold a mix of
// pre-cutover bare components (must rename) and post-cutover plain-data
// snapshots that legitimately carry $type (e.g. audit.event before/after —
// renaming those corrupts the audit log). Per-doc the two are undecidable,
// so: a clean collection is stamped and served; found candidates fail the
// boot with the exact list + operator commands. Marker is stamped LAST and
// is correctness-bearing — after it exists the scan never runs again.

import type { Collection } from 'mongodb';
import { globMatch } from '@treenx/core/glob';
import { fromStorageKeys, toStorageKeys } from '@treenx/core/kernel/store/keys';
import { NS_VERSION, type Stats, transformNode } from '@treenx/core/tree/migrate-component-namespace';

// Reserved _path — no leading '/', so node lookups and children regexes
// (all anchored at '^/') can never surface the marker as a node.
export const MARKER_PATH = '.treenix-version';

export async function migrateCollection(
  col: Collection,
  label: string,
  write: boolean,
  log: (line: string) => void,
): Promise<Stats> {
  const stats: Stats = { files: 0, migrated: 0, renames: 0, warnings: [] };

  for await (const doc of col.find({ _path: /^\// })) {
    stats.files++;
    const { _id, ...raw } = doc;
    const node = fromStorageKeys(raw);
    if (!transformNode(node, `${label}:${raw._path}`, stats, log)) continue;

    stats.migrated++;
    if (write) await col.replaceOne({ _id }, toStorageKeys(node));
  }

  return stats;
}

export async function stampCollection(col: Collection): Promise<void> {
  await col.updateOne({ _path: MARKER_PATH }, { $set: { v: NS_VERSION } }, { upsert: true });
}

export type NsMigratePolicy = 'rename' | 'stamp';

/** Deploy-time policy for the whole fleet: TREENIX_NS_MIGRATE is a comma list
 *  of `<glob>:<rename|stamp>` matched against the `db.collection` label
 *  (e.g. `*.users:rename,*.audit_events:stamp`). Env, not tree data, because
 *  existing mounts predate the nsMigrate field (seeds skip existing paths) and
 *  per-tenant node edits don't scale — same precedent as MONGO_URI fallback.
 *  Malformed entries throw: a typo silently ignored would strand collections. */
export function envNsMigratePolicy(label: string, env = process.env.TREENIX_NS_MIGRATE): NsMigratePolicy | undefined {
  if (!env) return undefined;
  let matched: NsMigratePolicy | undefined;
  for (const entry of env.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const i = trimmed.lastIndexOf(':');
    const glob = trimmed.slice(0, i);
    const policy = trimmed.slice(i + 1);
    if (i <= 0 || (policy !== 'rename' && policy !== 'stamp')) {
      throw new Error(`TREENIX_NS_MIGRATE: malformed entry "${trimmed}" — expected <glob>:<rename|stamp>`);
    }
    if (globMatch(glob, label)) matched = policy;
  }
  return matched;
}

/** Boot gate, called by createMongoTree before the collection is served.
 *  The rename-vs-stamp judgment is per-collection and human-owned (see header);
 *  once declared — via the mount's `nsMigrate` field or TREENIX_NS_MIGRATE —
 *  boot executes it idempotently, so a deploy self-migrates (core-r096).
 *  Undeclared + dirty stays fail-closed: throw with the rename list; the
 *  operator reviews and applies via the CLI below (--write / --stamp). */
export async function ensureMigratedMongo(
  col: Collection,
  label: string,
  log: (line: string) => void = console.log,
  policy?: NsMigratePolicy,
): Promise<void> {
  const marker = await col.findOne({ _path: MARKER_PATH });
  const version = marker ? marker.v : 0;
  if (!Number.isInteger(version) || (version as number) < 0) {
    throw new Error(`${label}: corrupted version marker ${JSON.stringify(marker?.v)}`);
  }
  if (version > NS_VERSION) {
    throw new Error(`${label}: data version ${version} is newer than this engine supports (${NS_VERSION}) — upgrade the engine`);
  }
  if (version === NS_VERSION) return;

  const effective = policy ?? envNsMigratePolicy(label);

  if (effective === 'stamp') {
    await stampCollection(col);
    log(`[treenix] ${label}: stamped v${NS_VERSION} without renames (nsMigrate: stamp)`);
    return;
  }

  if (effective === 'rename') {
    const s = await migrateCollection(col, label, true, log);
    if (s.warnings.length > 0) {
      // Renames are applied and idempotent; the marker would freeze the state
      // before a human reviewed the warnings (query-mount match configs using
      // bare dot-paths) — leave unstamped so the scan repeats until clean.
      for (const w of s.warnings) log(`[treenix] ${label}: WARNING ${w}`);
      log(`[treenix] ${label}: migrated ${s.migrated}/${s.files} docs, NOT stamped — review warnings, then --stamp`);
      return;
    }
    await stampCollection(col);
    log(`[treenix] ${label}: migrated ${s.migrated}/${s.files} docs — stamped v${NS_VERSION} (nsMigrate: rename)`);
    return;
  }

  const lines: string[] = [];
  const dry = await migrateCollection(col, label, false, (l) => lines.push(l));

  if (dry.migrated > 0 || dry.warnings.length > 0) {
    throw new Error(
      `${label}: component-namespace migration required — refusing to serve unmigrated data.\n`
      + `Candidate renames (bare component keys):\n${lines.join('\n')}\n`
      + `Review each: real components → apply renames; data snapshots (e.g. audit before/after) → stamp as-is.\n`
      + `  auto  : set nsMigrate: 'rename' | 'stamp' on the t.mount.mongo config, or TREENIX_NS_MIGRATE="<glob>:<policy>,..." (glob on "${label}")\n`
      + `  apply : tsx --conditions development packages/mongo/src/migrate.ts --write <mongo-uri> <db> <collection>\n`
      + `  stamp : tsx --conditions development packages/mongo/src/migrate.ts --stamp <mongo-uri> <db> <collection>`,
    );
  }

  await stampCollection(col);
  log(`[treenix] ${label}: component namespace clean — stamped v${NS_VERSION}`);
}

// ── Operator CLI (mirrors the fs migrator's isCliEntry pattern) ──

const isCliEntry = process.argv[1]?.endsWith('migrate.ts');
if (isCliEntry) {
  const args = process.argv.slice(2);
  const write = args.includes('--write');
  const stamp = args.includes('--stamp');
  const rest = args.filter(a => a !== '--write' && a !== '--stamp');
  const [uri, dbName, collectionName] = rest;

  if (!uri || !dbName || !collectionName || (write && stamp)) {
    console.error('Usage: tsx src/migrate.ts [--write|--stamp] <mongo-uri> <db> <collection>');
    process.exit(1);
  }

  const run = async () => {
    const { MongoClient } = await import('mongodb');
    const client = new MongoClient(uri);
    await client.connect();
    try {
      const col = client.db(dbName).collection(collectionName);
      const label = `${dbName}.${collectionName}`;

      if (stamp) {
        await stampCollection(col);
        console.log(`${label}: stamped v${NS_VERSION} without renames`);
        return;
      }

      const s = await migrateCollection(col, label, write, console.log);
      console.log(`${write ? 'Migrated' : 'Dry-run'}: docs=${s.files} migrated=${s.migrated} renames=${s.renames} warnings=${s.warnings.length}`);
      if (write && s.warnings.length === 0) {
        await stampCollection(col);
        console.log(`${label}: stamped v${NS_VERSION}`);
      } else if (write) {
        console.log(`${label}: NOT stamped — review query-mount match warnings above, then --stamp`);
      }
    } finally {
      await client.close();
    }
  };
  run().catch(err => { console.error(err); process.exit(1); });
}
