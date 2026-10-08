// Treenix Patch — Layer 1
// Compact [op, path, value?] tuples with dot-notation paths.
// Maps 1:1 to RFC 6902 JSON Patch.

import { type NodeData } from '#core';
import { KernelError } from '#errors';
import { assertNoPrototypeKeys, assertSafePatchPath, deleteByPath, getByPath, setByPath } from '#kernel/update-ops';

// ── Types ──

export type PatchOp =
  | readonly ['t', string, unknown]     // test
  | readonly ['r', string, unknown]     // replace
  | readonly ['a', string, unknown]     // add (field or array push via path.-)
  | readonly ['d', string]              // delete

export class PatchTestError extends Error {
  code = 'TEST_FAILED' as const;
  constructor(public field: string, public expected: unknown, public actual: unknown) {
    super(`Patch test failed: ${field}`);
  }
}

// ── Commit receipt (core-ns6p.2) ──
// Every mutation verb returns what it committed, minted INSIDE the adapter's
// atomic span — cache/subs/audit consume the receipt instead of re-reading
// (each reread was a coherency window: a second write could land inside it
// and poison the first write's event/audit row with a foreign after-image).

/** One committed member. before=null → created; after=null → removed; a
 *  guarded no-op (test-only ops) reports before/after with equal content.
 *  Images are SHARED READ-ONLY snapshots (same rule as cached nodes):
 *  consumers never mutate them, adapters never alias live internal state. */
export type CommitChange = { path: string; before: NodeData | null; after: NodeData | null };

/** `changes` lists every member the verb touched ([] = known no-op, e.g.
 *  remove of a missing node). `null` = OPAQUE authority: a remote transport
 *  that cannot see the authority's images (federation) — consumers take an
 *  explicit degraded branch, never treat it as "nothing changed". */
export type CommitReceipt = { changes: CommitChange[] | null };

/** The values that replace and add ops write pass assertNoPrototypeKeys. */
export function assertOpValuesSafe(ops: readonly PatchOp[], path: string): void {
  for (const op of ops) if (op[0] === 'r' || op[0] === 'a') assertNoPrototypeKeys(op[2], path);
}

// ── Apply ops to object in-place ──

export function applyOps(target: Record<string, unknown>, ops: readonly PatchOp[]): void {
  for (const op of ops) {
    assertSafePatchPath(op[1]);
    switch (op[0]) {
      case 't': {
        const actual = getByPath(target, op[1]);
        if (actual !== op[2]) throw new PatchTestError(op[1], op[2], actual);
        break;
      }
      case 'r':
        // RFC 6902 replace: target location MUST exist.
        setByPath(target, op[1], op[2], true);
        break;
      case 'a':
        if (op[1].endsWith('.-')) {
          const arrPath = op[1].slice(0, -2);
          const arr = getByPath(target, arrPath);
          if (!Array.isArray(arr)) throw new Error(`add: ${arrPath} is not an array`);
          arr.push(op[2]);
        } else {
          setByPath(target, op[1], op[2]);
        }
        break;
      case 'd':
        deleteByPath(target, op[1]);
        break;
    }
  }
}

export function hasMutationOps(ops: readonly PatchOp[]): boolean {
  return ops.some(op => op[0] !== 't');
}

/** Patch via get→apply→set on the tree itself — adapters without a native
 *  patch, and combinators that must route patch through their own set()
 *  pipeline (validation, refs, cache). */
export async function patchViaSet(
  self: { get(path: string, ctx?: unknown): Promise<NodeData | undefined>; set(node: NodeData, ctx?: unknown): Promise<CommitReceipt> },
  path: string,
  ops: readonly PatchOp[],
  ctx?: unknown,
): Promise<CommitReceipt> {
  const node = await self.get(path, ctx);
  if (!node) throw new KernelError('NOT_FOUND', `Node not found: ${path}`);
  const copy = structuredClone(node);
  applyOps(copy, ops);
  // Test-only: nothing written — report the guarded member (copy is the
  // ops-validated clone, content-equal to stored; exclusive by construction).
  if (!hasMutationOps(ops)) return { changes: [{ path, before: copy, after: copy }] };
  return self.set(copy, ctx);
}
