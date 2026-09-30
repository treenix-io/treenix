// Treenix Patch — Layer 1
// Compact [op, path, value?] tuples with dot-notation paths.
// Maps 1:1 to RFC 6902 JSON Patch.

import { assertSafeKey, type NodeData } from '#core';
import { KernelError } from '#errors';

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

// ── Path safety (prototype pollution guard) ──

export function assertSafePatchPath(path: string): void {
  if (typeof path !== 'string' || path.length === 0 || path.includes('\0')) {
    throw new KernelError('FORBIDDEN', `Invalid patch path: ${JSON.stringify(path)}`);
  }
  for (const part of path.split('.')) {
    if (part === '') throw new KernelError('FORBIDDEN', `Empty patch segment in ${path}`);
    try { assertSafeKey(part); }
    catch { throw new KernelError('FORBIDDEN', `Forbidden patch segment: ${JSON.stringify(part)} in ${path}`); }
  }
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

// ── Path helpers (dot notation) ──

export function getByPath(obj: any, path: string): unknown {
  const parts = path.split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[p];
  }
  return cur;
}

// Arrays take integer indices within bounds: an unbounded one made a sparse
// array (['a','list.99999999',1] → length 1e8, ~500 MB per serialization and
// one validation error object per hole).
function arrayIndex(arr: unknown[], key: string, max: number, path: string): number {
  const idx = Number(key);
  if (!Number.isInteger(idx) || idx < 0 || idx > max) {
    throw new KernelError('INVALID', `patch: array index "${key}" out of range (length ${arr.length}) in ${path}`);
  }
  return idx;
}

function setByPath(obj: any, path: string, value: unknown, strict = false): void {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = Array.isArray(cur) ? arrayIndex(cur, parts[i], cur.length - 1, path) : parts[i];
    const next = cur[key];
    if (next == null || typeof next !== 'object') {
      const at = parts.slice(0, i + 1).join('.');
      if (strict) throw new KernelError('NOT_FOUND', `replace: missing parent at "${at}" in ${path}`);
      // Creating a missing parent is add's job; clobbering a value is not.
      if (next != null) throw new KernelError('INVALID', `add: "${at}" is not an object in ${path}`);
      cur[key] = {};
    }
    cur = cur[key];
  }
  const last = parts[parts.length - 1];
  // replace targets an existing element; add may also append at length.
  if (Array.isArray(cur)) cur[arrayIndex(cur, last, strict ? cur.length - 1 : cur.length, path)] = value;
  else cur[last] = value;
}

function deleteByPath(obj: any, path: string): void {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null) throw new KernelError('NOT_FOUND', `delete: missing parent at "${parts.slice(0, i + 1).join('.')}" in ${path}`);
    cur = cur[parts[i]];
  }
  const key = parts[parts.length - 1];
  if (Array.isArray(cur)) {
    const idx = Number(key);
    if (Number.isInteger(idx)) {
      if (idx < 0 || idx >= cur.length) throw new KernelError('NOT_FOUND', `delete: array index ${idx} out of range (length ${cur.length}) in ${path}`);
      cur.splice(idx, 1);
      return;
    }
  }
  if (!(key in cur)) throw new KernelError('NOT_FOUND', `delete: missing key "${key}" in ${path}`);
  delete cur[key];
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
