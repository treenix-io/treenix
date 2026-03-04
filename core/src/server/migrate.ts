// Per-type schema migration — normalizes nodes on read, stamps $v on write.
// Migrations registered via: register(type, 'migrate', { 1: fn, 2: fn })
// Absent $v = version 0. Migration functions mutate the node clone in-place.
// NOTE: not wired into pipeline yet — will be added between validated and subscriptions

import { type NodeData, resolveExact } from '#core';
import type { Tree } from '#tree';

type Migrator = (node: Record<string, unknown>) => void;
type Migrations = Record<number, Migrator>;

function getMigrations(type: string): { migrations: Migrations; version: number } | null {
  const handler = resolveExact(type, 'migrate');
  if (!handler) return null;
  const migrations = handler() as unknown as Migrations;
  const keys = Object.keys(migrations).map(Number).sort((a, b) => a - b);
  if (!keys.length) return null;
  return { migrations, version: keys[keys.length - 1] };
}

function migrateNode(node: NodeData): NodeData {
  const m = getMigrations(node.$type);
  if (!m) return node;

  const nodeV = (node as any).$v as number ?? 0;
  if (nodeV >= m.version) return node;

  const clone = structuredClone(node);
  for (const [v, fn] of Object.entries(m.migrations).sort(([a], [b]) => +a - +b)) {
    if (+v > nodeV) fn(clone as Record<string, unknown>);
  }
  (clone as any).$v = m.version;
  return clone;
}

function stampVersion(node: NodeData): void {
  const m = getMigrations(node.$type);
  if (!m) return;
  (node as any).$v = m.version;
}

export function withMigration(store: Tree): Tree {
  return {
    ...store,

    async get(path, ctx) {
      const node = await store.get(path, ctx);
      if (!node) return node;
      return migrateNode(node);
    },

    async getChildren(path, opts, ctx) {
      const page = await store.getChildren(path, opts, ctx);
      return { ...page, items: page.items.map(migrateNode) };
    },

    async set(node, ctx) {
      stampVersion(node);
      return store.set(node, ctx);
    },
  };
}
