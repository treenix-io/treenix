// Soft-delete: user/agent-initiated remove moves the subtree into /sys/trash
// instead of hard-deleting (core-gk8.8). Sits in the pipeline between cache and
// subscriptions (server.ts), so every client surface — tRPC/peer, MCP, future
// transports — gets trash semantics with no per-surface wiring, while internal
// code below the wrapper (session revoke, volatile cleanup, GC itself) keeps
// hard remove.
//
// Policy: system namespaces (/sys/**, /auth/**, /proc/**, and / itself) hard-
// delete — they hold infra, sessions carry secrets, and /sys/trash must be
// purgeable without recursion. Everything else (the business tree) is copied
// under /sys/trash/<ts>-<seq>-<slug>/<name> first, then removed: a crash in
// between leaves a duplicate, never a loss. Copies are written below
// subscriptions → no event spam; the remove itself still emits through the
// layers above. /sys/trash is admin-ACL'd (system seed), so purging an entry
// IS the explicit admin hard delete. Restore = copy the entry's child subtree
// back to `from` (admin tooling / MCP).

import type { NodeData } from '#core';
import type { Tree } from '#tree';

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

export function withTrash(tree: Tree): Tree {
  return {
    ...tree,

    async remove(path, ctx) {
      if (isTrashExempt(path)) return tree.remove(path, ctx);

      const node = await tree.get(path);
      if (!node) return false;

      const entryPath = `${TRASH_ROOT}/${entryId(path)}`;
      const removedAt = new Date().toISOString();

      // remove() is single-node across every adapter (children live by prefix
      // query — D04 — and survive their parent), so trash mirrors that contract:
      // one node copied, one node removed. A client deleting a subtree loops
      // removes and gets one restorable entry per node. $rev stripped: copies
      // are fresh nodes, OCC history does not transfer.
      await tree.set({ $path: entryPath, $type: TRASH_ENTRY_TYPE, from: path, removedAt });

      const { $rev: _r, ...data } = node;
      await tree.set({ ...data, $path: `${entryPath}/${path.split('/').pop()!}` } as NodeData);

      // ctx (opId, actor) forwards only to the real remove — the event that
      // subscribers and audit see; copy-writes above are internal.
      return tree.remove(path, ctx);
    },
  };
}

// ── GC ──

const DAY = 86_400_000;

function trashTtlMs(): number {
  const raw = process.env.TREENIX_TRASH_TTL_DAYS;
  if (raw === undefined || raw === '') return 30 * DAY;
  const days = Number(raw);
  if (!Number.isFinite(days) || days <= 0) throw new Error(`TREENIX_TRASH_TTL_DAYS invalid: ${JSON.stringify(raw)}`);
  return days * DAY;
}

/** Purge trash entries older than the TTL. Runs at boot (factory) on the
 *  system tree — below withTrash, so the purge is a real hard delete. */
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
