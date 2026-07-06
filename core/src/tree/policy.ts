// Storage policy — THE single pipeline step between subscriptions and mounts
// (core-5fqq). Collapses the former one-shot wrapper chain (migration →
// validation → $refs → cache → trash), which was only ever composed in one
// order in one place; the order is now structural — the statements in
// withStoragePolicy ARE the order. $volatile routing was cut with the feature
// (owner 2026-07-03): zero runtime writers existed; mem-only subtrees use
// t.mount.memory instead of a per-node flag.

import { validateNode } from '#comp/validate';
import {
  getRegistryVersion, isCompKey, isComponent, isRef,
  type NodeData, type RefEntry, resolveExact,
} from '#core';
import { OpError } from '#errors';
import { ulid } from '#util/ulid';
import { type Tree } from './index';
import { withCache } from './cache';

// ── Migration: per-type $v ladder, applied on read (R-gk8.29) ──
// THE mechanism mod developers use to evolve stored data shapes:
//   register(type, 'migrate', () => ({ 1: fn, 2: fn }))
// Absent $v = version 0. Each step mutates the clone in place; $v stamps to the
// highest registered step after apply. Example mod: src/mod/examples/versioned.
// The policy wraps the MOUNTED tree — above fs/mongo/federation/query adapters —
// so every adapter's nodes migrate on read and one layer covers all read verbs
// (R-gk8.29: an earlier wrapper sat below the mounts and persistent stores — the
// only data that outlives code versions — bypassed it entirely). Reads write the
// migrated node back, so the corpus converges lazily; set() stamps $v so fresh
// writes never re-enter the ladder.
//
// Hot path:
//  1. checked: WeakSet — same NodeData object seen twice → instant skip
//  2. migrationInfo: per-type cache (Map) — second time we ask "has type X
//     any migrations?" returns cached answer (including a cached "no") without
//     touching the registry. Cache is keyed by registry version
//     (`getRegistryVersion()`) so any register/unregister/replaceHandler call
//     invalidates it in one integer compare.

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

/** Check if node or any of its `#` components need migration. */
function needsMigration(node: NodeData): boolean {
  const nm = getMigrations(node.$type);
  if (nm && ((node['$v'] as number) ?? 0) < nm.version) return true;

  // Strict namespace: only '#' keys are components; bare {$type} values are data.
  for (const key of Object.keys(node)) {
    if (!isCompKey(key)) continue;
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

  applyMigrations(clone as Record<string, unknown>, clone.$type);

  for (const key of Object.keys(clone)) {
    if (!isCompKey(key)) continue;
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
    if (!isCompKey(key)) continue;
    const val = node[key];
    if (!isComponent(val)) continue;
    const cm = getMigrations(val.$type);
    if (cm) (val as Record<string, unknown>)['$v'] = cm.version;
  }
}

// ── $refs derivation: auto-populated index of outgoing refs on set() ──
// Scans node fields for { $ref } entries, builds the $refs array.
// Standalone refs (no f:) pass through untouched.

/** Deep-scan node for $ref fields, return derived RefEntries.
 *  f: locator is the actual access path — '#comp.field' for component fields,
 *  bare 'field' for node-body data (strict namespace: keys are never rewritten). */
function extractRefs(node: NodeData): RefEntry[] {
  const refs: RefEntry[] = [];

  function scan(obj: unknown, prefix: string) {
    if (!obj || typeof obj !== 'object') return;
    if (isRef(obj)) {
      refs.push({ t: obj.$ref, f: prefix || undefined });
      return;
    }
    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) scan(obj[i], `${prefix}.${i}`);
      return;
    }
    for (const [k, v] of Object.entries(obj)) {
      if (k.startsWith('$')) continue;
      scan(v, prefix ? `${prefix}.${k}` : k);
    }
  }

  for (const [k, v] of Object.entries(node)) {
    if (k.startsWith('$')) continue;
    scan(v, k);
  }

  return refs;
}

/** Merge derived refs with standalone refs (those without f:) */
function buildRefs(node: NodeData): RefEntry[] | undefined {
  const derived = extractRefs(node);
  const standalone = node.$refs?.filter(r => !r.f) ?? [];
  const merged = [...standalone, ...derived];
  return merged.length ? merged : undefined;
}

// ── Trash: soft-delete for user/agent-initiated removes (core-gk8.8) ──
// Policy: system namespaces (/sys/**, /auth/**, /proc/**, and / itself) hard-
// delete — they hold infra, sessions carry secrets, and /sys/trash must be
// purgeable without recursion. Everything else (the business tree) is copied
// under /sys/trash/<ts>-<seq>-<slug>/<name> first, then removed: a crash in
// between leaves a duplicate, never a loss. Copies are written below
// subscriptions → no event spam; the remove itself still emits through the
// layers above. /sys/trash is admin-ACL'd (system seed), so purging an entry
// IS the explicit admin hard delete. Restore = copy the entry's child subtree
// back to `from` (admin tooling / MCP).

export const TRASH_ROOT = '/sys/trash';
export const TRASH_ENTRY_TYPE = 't.trash.entry';

const EXEMPT = ['/sys', '/auth', '/proc'];

export function isTrashExempt(path: string): boolean {
  return path === '/' || EXEMPT.some(p => path === p || path.startsWith(p + '/'));
}

// Monotonic suffix de-dups entries created for the same path within one ms.
let entrySeq = 0;

function entryId(path: string): string {
  return `${Date.now()}-${entrySeq++}-${path.replace(/^\//, '').replace(/\//g, '~')}`;
}

// ── The policy step ──

export type StoragePolicy = {
  /** Client path: migration → validation → $refs → cache → trash. */
  tree: Tree;
  /** Migration-only view over the backing — the base for the 'system' identity
   *  (factory bootstrap: seed, anon-key, log writer; request-edge session
   *  resolution). No validation (seeds write anything), no cache (boot writes
   *  stay coherent with the store), no trash (session revoke / GC are real
   *  hard deletes). */
  base: Tree;
  invalidate(path: string): void;
  invalidateAll(): void;
};

export function withStoragePolicy(backing: Tree): StoragePolicy {
  // Migrate-on-read base — shared by the client path and the system identity.
  // patch stays delegated to the backing (spread): re-implementing it here as
  // get+set would break mounts with native patch semantics (federation
  // forwards ops remotely; the remote migrates its own data). Every action
  // flows through get() before drafting, which converges the node first.
  const base: Tree = {
    ...backing,

    async get(path, ctx) {
      const node = await backing.get(path, ctx);
      if (!node) return node;

      const migrated = migrateNode(node);
      if (migrated !== node) {
        await backing.set(migrated, ctx);
        checked.add(migrated);
      }
      return migrated;
    },

    async getChildren(path, opts, ctx) {
      const page = await backing.getChildren(path, opts, ctx);
      const writebacks: Promise<void>[] = [];
      const items = page.items.map(n => {
        const migrated = migrateNode(n);
        if (migrated !== n) {
          writebacks.push(backing.set(migrated, ctx));
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

      // $id (core-gk8.10): identity is minted ONCE at first persist and never
      // changes. Stored id wins over the payload — a blind upsert from a
      // legacy client (whose read predates $id) must not re-mint; a DIFFERENT
      // incoming id is a forged/duplicated identity — reject, never merge.
      // A carried $id on a NEW path is accepted: trash-restore, branch merge
      // and backup import legitimately relocate identity. Cost: one backing
      // get per write (fs already reads for OCC; memory get is O(depth)).
      const existing = await backing.get(node.$path, ctx);
      if (existing?.$id) {
        if (node.$id !== undefined && node.$id !== existing.$id) {
          throw new OpError('BAD_REQUEST', `$id is immutable: ${node.$path} already carries an identity`);
        }
        node.$id = existing.$id;
      } else if (node.$id === undefined) {
        node.$id = ulid();
      }

      return backing.set(node, ctx);
    },
  };

  // scanChildren is the read-runtime list path (ACL listings) — it MUST migrate
  // too, or lists serve old shapes while get serves new ones. Override only when
  // the backing exposes it; the spread already forwarded the original.
  if (backing.scanChildren) {
    base.scanChildren = async function* (parent, opts) {
      for await (const entry of backing.scanChildren!(parent, opts)) {
        const migrated = migrateNode(entry.node);
        if (migrated !== entry.node) {
          await backing.set(migrated);
          checked.add(migrated);
          yield { ...entry, node: migrated };
        } else {
          yield entry;
        }
      }
    };
  }

  // Client write policy. Order pinned by the former wrapper chain: $refs are
  // derived BEFORE validation (validators see the node with its index), $v is
  // stamped after (base.set). Validation failure throws before any write —
  // atomic, nothing reaches the backing.
  const policied: Tree = {
    ...base,

    async set(node, ctx) {
      const refs = buildRefs(node);
      if (refs) node.$refs = refs;
      else delete node.$refs;

      const errors = validateNode(node);
      if (errors.length) {
        const msg = errors.map(e => `${e.path}: ${e.message}`).join('; ');
        throw new OpError('BAD_REQUEST', `Validation: ${msg}`);
      }

      return base.set(node, ctx);
    },
  };

  // Cache above the write policy — populated on read AND write (post-write
  // re-read captures the $rev bump), so cached nodes are always migrated,
  // validated, indexed. withCache also turns patch into get→apply→set through
  // this policy, which is where patch validation and $refs recomputation come
  // from. Reused as-is: the client SDK wraps remote trees with the same code.
  const cached = withCache(policied);

  // Soft-delete last (gk8.8): below subscriptions so the copy-writes stay
  // silent, above cache so copies land coherently; the remove event still
  // emits above. The system identity uses `base` — hard delete.
  const tree: Tree = {
    ...cached,

    async remove(path, ctx) {
      if (isTrashExempt(path)) return cached.remove(path, ctx);

      const node = await cached.get(path);
      if (!node) return false;

      const entryPath = `${TRASH_ROOT}/${entryId(path)}`;
      const removedAt = new Date().toISOString();

      // remove() is single-node across every adapter (children live by prefix
      // query — D04 — and survive their parent), so trash mirrors that contract:
      // one node copied, one node removed. A client deleting a subtree loops
      // removes and gets one restorable entry per node. $rev stripped: copies
      // are fresh nodes, OCC history does not transfer.
      await cached.set({ $path: entryPath, $type: TRASH_ENTRY_TYPE, from: path, removedAt });

      const { $rev: _r, ...data } = node;
      await cached.set({ ...data, $path: `${entryPath}/${path.split('/').pop()!}` } as NodeData);

      // ctx (opId, actor) forwards only to the real remove — the event that
      // subscribers and audit see; copy-writes above are internal.
      return cached.remove(path, ctx);
    },
  };

  return { tree, base, invalidate: cached.invalidate, invalidateAll: cached.invalidateAll };
}

// ── Trash GC ──

const DAY = 86_400_000;

function trashTtlMs(): number {
  const raw = process.env.TREENIX_TRASH_TTL_DAYS;
  if (raw === undefined || raw === '') return 30 * DAY;
  const days = Number(raw);
  if (!Number.isFinite(days) || days <= 0) throw new Error(`TREENIX_TRASH_TTL_DAYS invalid: ${JSON.stringify(raw)}`);
  return days * DAY;
}

/** Purge trash entries older than the TTL. Runs at boot (factory) on the
 *  system tree — below the trash policy, so the purge is a real hard delete. */
export async function sweepTrash(tree: Tree, ttlMs = trashTtlMs()): Promise<number> {
  const { items } = await tree.getChildren(TRASH_ROOT, { depth: 1 });
  const cutoff = Date.now() - ttlMs;

  let purged = 0;
  for (const entry of items) {
    const ts = Number(entry.$path.slice(TRASH_ROOT.length + 1).split('-', 1)[0]);
    if (Number.isFinite(ts) && ts < cutoff) {
      await tree.remove(entry.$path);
      purged++;
    }
  }

  if (purged) console.log(`[trash] GC purged ${purged} entries older than ${Math.round(ttlMs / DAY)}d`);
  return purged;
}
