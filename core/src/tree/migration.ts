// Per-type schema migration — normalizes nodes and components on read.
// Migrations registered via: register(type, 'migrate', () => ({ 1: fn, 2: fn }))
// Absent $v = version 0. Migration functions mutate the clone in-place.
//
// Hot path:
//  1. checked: WeakSet — same NodeData object seen twice → instant skip
//  2. migrationInfo: per-type cache (Map) — second time we ask "has type X
//     any migrations?" returns cached answer (including a cached "no") without
//     touching the registry. Cache is keyed by registry version (`getRegistryVersion()`)
//     so any `register/unregister/replaceHandler` call invalidates it in one
//     integer compare.

import { getRegistryVersion, isComponent, type NodeData, resolveExact } from '#core';
import type { Tree } from '#tree';

type Migrator = (data: Record<string, unknown>) => void;
type Migrations = Record<number, Migrator>;
type MigrationInfo = { steps: [number, Migrator][]; version: number };

// Objects that passed through migrateNode and need no changes
const checked = new WeakSet<NodeData>();

// Per-type migration descriptor cache. `null` is cached too, so types with no
// migrations registered cost a single Map.get on the hot read path.
const migrationInfo = new Map<string, MigrationInfo | null>();
let cachedRegistryVersion = -1;

function getMigrations(type: string): MigrationInfo | null {
  const v = getRegistryVersion();
  if (v !== cachedRegistryVersion) {
    migrationInfo.clear();
    cachedRegistryVersion = v;
  }
  const cached = migrationInfo.get(type);
  if (cached !== undefined) return cached;

  const info = computeMigrationInfo(type);
  migrationInfo.set(type, info);
  return info;
}

function computeMigrationInfo(type: string): MigrationInfo | null {
  const handler = resolveExact(type, 'migrate');
  if (!handler) return null;
  const migrations = handler() as Migrations;
  const keys = Object.keys(migrations).map(Number).sort((a, b) => a - b);
  if (!keys.length) return null;
  return {
    steps: keys.map(k => [k, migrations[k]]),
    version: keys[keys.length - 1],
  };
}

/** Apply pending migrations to a data object. Returns true if anything changed. */
function applyMigrations(data: Record<string, unknown>, type: string): boolean {
  const m = getMigrations(type);
  if (!m) return false;

  const v = (data['$v'] as number) ?? 0;
  if (v >= m.version) return false;

  for (const [ver, fn] of m.steps) {
    if (ver > v) fn(data);
  }
  data['$v'] = m.version;
  return true;
}

/** Check if node or any of its components need migration. */
function needsMigration(node: NodeData): boolean {
  // Node-level
  const nm = getMigrations(node.$type);
  if (nm && ((node['$v'] as number) ?? 0) < nm.version) return true;

  // Named components
  for (const key of Object.keys(node)) {
    if (key.startsWith('$')) continue;
    const val = node[key];
    if (!isComponent(val)) continue;
    const cm = getMigrations(val.$type);
    if (cm && ((val['$v'] as number) ?? 0) < cm.version) return true;
  }

  return false;
}

function migrateNode(node: NodeData): NodeData {
  if (checked.has(node)) return node;

  if (!needsMigration(node)) {
    checked.add(node);
    return node;
  }

  const clone = structuredClone(node);

  // Migrate node-level
  applyMigrations(clone as Record<string, unknown>, clone.$type);

  // Migrate named components
  for (const key of Object.keys(clone)) {
    if (key.startsWith('$')) continue;
    const val = clone[key];
    if (!isComponent(val)) continue;
    applyMigrations(val as Record<string, unknown>, val.$type);
  }

  return clone;
}

function stampVersion(node: NodeData): void {
  const m = getMigrations(node.$type);
  if (m) node['$v'] = m.version;

  for (const key of Object.keys(node)) {
    if (key.startsWith('$')) continue;
    const val = node[key];
    if (!isComponent(val)) continue;
    const cm = getMigrations(val.$type);
    if (cm) (val as Record<string, unknown>)['$v'] = cm.version;
  }
}

export function withMigration(tree: Tree): Tree {
  return {
    ...tree,

    async get(path, ctx) {
      const node = await tree.get(path, ctx);
      if (!node) return node;

      const migrated = migrateNode(node);
      if (migrated !== node) {
        await tree.set(migrated, ctx);
        checked.add(migrated);
      }
      return migrated;
    },

    async getChildren(path, opts, ctx) {
      const page = await tree.getChildren(path, opts, ctx);
      const writebacks: Promise<void>[] = [];
      const items = page.items.map(n => {
        const migrated = migrateNode(n);
        if (migrated !== n) {
          writebacks.push(tree.set(migrated, ctx));
          checked.add(migrated);
        }
        return migrated;
      });
      if (writebacks.length) {
        await Promise.all(writebacks);
        page.items = items;
      }
      return page;
    },

    async set(node, ctx) {
      stampVersion(node);
      return tree.set(node, ctx);
    },
  };
}
