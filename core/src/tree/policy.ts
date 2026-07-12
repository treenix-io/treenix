// Storage policy — THE single pipeline step between subscriptions and mounts
// (core-5fqq). Collapses the former one-shot wrapper chain (migration →
// validation → $refs → cache → trash), which was only ever composed in one
// order in one place; the order is now structural — the statements in
// withStoragePolicy ARE the order. $volatile routing was cut with the feature
// (owner 2026-07-03): zero runtime writers existed; mem-only subtrees use
// t.mount.memory instead of a per-node flag.

import { validateNode } from '#comp/validate';
import {
  getRegistryVersion, isCompKey, isComponent, isMoved, isRef,
  type NodeData, type RefEntry, resolveExact,
} from '#core';
import { OpError } from '#errors';
import { ulid } from '#util/ulid';
import { applyPatchManyEntry, assertPatchManyBatch, hasMutationOps, isSetEntry, type PatchManyEntry, type PatchOp, type Tree } from './index';
import { patchViaSet } from './patch';
import { withCache } from './cache';

// ── Migration: per-type $v ladder, applied on read (R-gk8.29) ──
// THE mechanism mod developers use to evolve stored data shapes:
//   register(type, 'migrate', () => ({ 1: fn, 2: fn }))
// Absent $v = version 0. Each step mutates the clone in place; $v stamps to the
// highest registered step after apply. Example mod: src/mod/examples/versioned.
// The policy wraps the MOUNTED tree — above fs/mongo/federation/query adapters —
// so every adapter's nodes migrate on read and one layer covers all read verbs
// (R-gk8.29: an earlier wrapper sat below the mounts and persistent stores — the
// only data that outlives code versions — bypassed it entirely). Reads migrate
// in memory ONLY — no write-back (core-anz4.9: read-path writes lost OCC,
// skipped audit/subs, false-CONFLICTed the caller's $rev through repath, and
// broke read-only query mounts). The corpus converges when a migrated node is
// next written; set() stamps $v so fresh writes never re-enter the ladder.
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

  checked.add(clone);
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

/** Direct child of /sys/trash — one soft-delete entry (marker + copied payload). */
function isTrashEntry(path: string): boolean {
  return path.startsWith(TRASH_ROOT + '/') && !path.includes('/', TRASH_ROOT.length + 1);
}

// core-anz4.8: remove() is single-node engine-wide, so purging a trash entry by
// its marker alone orphans the copied payload forever (retention broken,
// duplicate $id permanent). Depth-first: children before parents, marker last.
async function removeSubtree(tree: Tree, path: string, ctx?: unknown): Promise<boolean> {
  const { items } = await tree.getChildren(path, { depth: 1 });
  for (const child of items) await removeSubtree(tree, child.$path);
  return tree.remove(path, ctx);
}

// Monotonic suffix de-dups entries created for the same path within one ms.
let entrySeq = 0;

function entryId(path: string): string {
  return `${Date.now()}-${entrySeq++}-${path.replace(/^\//, '').replace(/\//g, '~')}`;
}

// ── Store preparation: $v stamp + $id mint/echo ──
// $id (core-gk8.10): identity is minted ONCE at first persist and never
// changes. Stored id wins over the payload — a blind upsert from a legacy
// client (whose read predates $id) must not re-mint; a DIFFERENT incoming id
// is a forged/duplicated identity — reject, never merge. A carried $id on a
// NEW path is accepted: trash-restore, branch merge, move() and backup import
// legitimately relocate identity. Shared by base.set and the patchMany
// set-member path — both funnel every full-node write.

function prepareForStore(node: NodeData, existing: NodeData | undefined): void {
  stampVersion(node);

  if (existing?.$id) {
    // Replacing a tombstone with a real node: the identity moved away WITH
    // the node — the sign post does not own the path's future. Echoing here
    // would let an unrelated write steal the moved id (refs with $refId
    // would resolve to the impostor). Carried id wins (move-back/restore);
    // id-less write mints fresh.
    if (isMoved(existing) && !isMoved(node)) {
      if (node.$id === undefined) node.$id = ulid();
      return;
    }
    if (node.$id !== undefined && node.$id !== existing.$id) {
      throw new OpError('BAD_REQUEST', `$id is immutable: ${node.$path} already carries an identity`);
    }
    node.$id = existing.$id;
  } else if (node.$id === undefined) {
    node.$id = ulid();
  }
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
  // patch delegates to the backing for CONVERGED nodes (mounts keep native
  // patch semantics: federation forwards ops remotely; the remote migrates its
  // own data). A node with a pending ladder must NOT take ops against the old
  // stored shape (reads no longer converge storage, core-anz4.9 — mixed-schema
  // corruption), so it converges via get→apply→set instead. The extra backing
  // get is system-path only: the client path patches through withCache, which
  // never calls this. Every action flows through get() before drafting, which
  // migrates the node first.
  const base: Tree = {
    ...backing,

    async get(path, ctx) {
      const node = await backing.get(path, ctx);
      return node ? migrateNode(node) : node;
    },

    async getChildren(path, opts, ctx) {
      const page = await backing.getChildren(path, opts, ctx);
      page.items = page.items.map(n => migrateNode(n));
      return page;
    },

    async set(node, ctx) {
      // Cost: one backing get per write (fs already reads for OCC; memory get
      // is O(depth)).
      prepareForStore(node, await backing.get(node.$path, ctx));
      return backing.set(node, ctx);
    },

    async patch(path, ops, ctx) {
      const raw = await backing.get(path, ctx);
      if (raw && migrateNode(raw) !== raw) return patchViaSet(base, path, ops, ctx);
      return backing.patch(path, ops, ctx);
    },
  };

  // scanChildren is the read-runtime list path (ACL listings) — it MUST migrate
  // too, or lists serve old shapes while get serves new ones. Override only when
  // the backing exposes it; the spread already forwarded the original.
  if (backing.scanChildren) {
    base.scanChildren = async function* (parent, opts, ctx) {
      for await (const entry of backing.scanChildren!(parent, opts, ctx)) {
        yield { ...entry, node: migrateNode(entry.node) };
      }
    };
  }

  // System-path batches (base/systemTree) need the same migration convergence
  // as the client path below — ops against a pending-ladder node would apply
  // to the old stored shape. No validation/$refs here (system semantics);
  // converged nodes and set-members pass through untouched.
  if (backing.patchMany) {
    base.patchMany = async (ancestor, entries, ctx) => {
      assertPatchManyBatch(ancestor, entries);

      const augmented: PatchManyEntry[] = [];
      for (const entry of entries) {
        if (isSetEntry(entry)) { augmented.push(entry); continue; }

        const raw = await backing.get(entry.path, ctx);
        if (!raw) { augmented.push(entry); continue; } // adapter throws NOT_FOUND itself
        const node = migrateNode(raw);
        if (node === raw) { augmented.push(entry); continue; }

        const copy = applyPatchManyEntry(node, entry);
        augmented.push(hasMutationOps(entry.ops)
          ? { path: entry.path, node: copy }
          : { path: entry.path, ops: [['t', '$rev', raw.$rev] as const] });
      }

      return backing.patchMany!(ancestor, augmented, ctx);
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

    // patchMany (core-gk8.15): the write policy applies per member BEFORE the
    // batch reaches storage — post-apply clones are validated (ALL errors
    // collected → one BAD_REQUEST, nothing written) and $refs re-derived, with
    // the recomputed index appended as a derived op so the adapter's atomic
    // phase 2 commits it with the member's own ops (mirror of set() above).
    ...(backing.patchMany ? {
      async patchMany(ancestor: string, entries: PatchManyEntry[], ctx?: unknown) {
        assertPatchManyBatch(ancestor, entries);

        const augmented: PatchManyEntry[] = [];
        const errors: string[] = [];
        for (const entry of entries) {
          // Set-member: full-node write, may CREATE — replicate policied.set
          // ($refs, validation) + base.set (prepareForStore) per member, since
          // base.patchMany forwards to the backing without either. Cloned so
          // the caller's node is never mutated (set() mutates in place — a
          // batch stages, so staging must not leak).
          if (isSetEntry(entry)) {
            const copy = structuredClone(entry.node);
            const refs = buildRefs(copy);
            if (refs) copy.$refs = refs;
            else delete copy.$refs;

            for (const e of validateNode(copy)) errors.push(`${entry.path} ${e.path}: ${e.message}`);
            prepareForStore(copy, await backing.get(entry.path, ctx));
            augmented.push({ path: entry.path, node: copy });
            continue;
          }

          const raw = await backing.get(entry.path, ctx);
          if (!raw) throw new OpError('NOT_FOUND', `Node not found: ${entry.path}`);
          const node = migrateNode(raw);
          const copy = applyPatchManyEntry(node, entry);

          // Test-only member: preconditions were just evaluated against the
          // MIGRATED shape (applyPatchManyEntry above). Converged node: forward
          // as-is — the adapter re-evaluates identically; no derived $refs op
          // (test-only = no write). Migration pending: raw storage still holds
          // the old shape, so the client's field tests would false-CONFLICT at
          // the adapter — forward a $rev guard instead ($rev is ladder-
          // invariant), preserving the commit-time precondition.
          if (!hasMutationOps(entry.ops)) {
            augmented.push(node === raw ? entry : { path: entry.path, ops: [['t', '$rev', raw.$rev] as const] });
            continue;
          }

          const refs = buildRefs(copy);
          if (refs) copy.$refs = refs;
          else delete copy.$refs;

          for (const e of validateNode(copy)) errors.push(`${entry.path} ${e.path}: ${e.message}`);

          if (node === raw) {
            // Converged node: forward ops — the adapter applies them against
            // current storage under its own lock (concurrent-merge semantics
            // preserved, no implicit OCC added), with the recomputed $refs
            // index appended as a derived op (mirror of set() above).
            const ops: PatchOp[] = [...entry.ops];
            if (refs) ops.push(['r', '$refs', refs] as const);
            else if ('$refs' in raw) ops.push(['d', '$refs'] as const);
            augmented.push({ path: entry.path, ops });
          } else {
            // Migration pending: ops against the still-old stored shape would
            // corrupt (reads no longer converge storage, core-anz4.9), so ship
            // the full migrated post-image as a set-member. copy carries the
            // pre-read $rev — the adapter's set-member gate enforces it as OCC,
            // denying the WHOLE batch (loud CONFLICT) on a concurrent write. A
            // revisionless legacy node has no token to guard with — documented
            // blind-upsert residual, still narrower than the pre-anz4.9
            // writeback, which blind-upserted on every read.
            augmented.push({ path: entry.path, node: copy });
          }
        }

        if (errors.length) {
          throw new OpError('BAD_REQUEST', `Validation: ${errors.join('; ')}`);
        }

        // Straight to the backing: base.patchMany's migration conversion
        // (system path) would re-read every ops-member for nothing — this
        // loop already converged them.
        return backing.patchMany!(ancestor, augmented, ctx);
      },
    } : {}),
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
      // Manual purge of a trash entry must take its copied payload subtree too
      // (core-anz4.8); other exempt paths keep the single-node contract.
      if (isTrashEntry(path)) return removeSubtree(cached, path, ctx);
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
      await removeSubtree(tree, entry.$path);
      purged++;
    }
  }

  if (purged) console.log(`[trash] GC purged ${purged} entries older than ${Math.round(ttlMs / DAY)}d`);
  return purged;
}
