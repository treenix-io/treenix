// Treenix Read Runtime — Layer 3
// Server-internal safe list algorithm. Replaces ad-hoc ACL scan in
// withAcl.getChildren and the virtual query-tree dispatch path.
//
// Flow:
//   for entry in source.scanChildren(plan.source):
//     project(actor, raw) -> viewWhere(visible)? -> callerWhere(visible)? -> emit
//   stop after limit+1; nextCursor = last-emitted cursor.
//
// Both viewWhere and callerWhere run AGAINST PROJECTED nodes. The MVP plan
// describes a trust split (viewWhere is trusted, may reference hidden fields
// for Mongo pushdown) but that requires type-ACL on `t.mount.*` (MVP item F4,
// deferred). Until then, any user with W on a mount node can author viewWhere
// — running it on raw would let them probe hidden fields via membership.
// Both predicates filter visible data; Mongo pushdown of viewWhere is also
// deferred until F4. depth>1 (core-0bl): adapters walk descendants inside
// scanChildren; $path ASC total order keeps cursors stable at any depth.

import type { NodeData } from '#core';
import { KernelError } from '#errors';
import { assertSafeSiftQuery, assertVisiblePredicate, createSiftTest } from '#kernel/expr';
import { exprWork } from '#kernel/expr-work';
import { DEFAULT_LIMITS } from '#kernel/types';
import { mapNodeForSift, type TreeSource } from './index';
import { decodeReadCursor, encodeReadCursor, planHash } from './plan-hash';

export type Projector = (node: NodeData) => Promise<NodeData | null>;

export type ReadPlan = {
  source: string;
  /** Levels to descend: 1 = direct children (default), -1 = all descendants.
   *  Part of plan identity (canonicalReadPlan) — a cursor minted at one depth
   *  cannot resume a scan at another. */
  depth?: number;
  /** Trusted predicate from mount/config. Pushdown-safe. */
  viewWhere?: Record<string, unknown>;
  /** Untrusted predicate from client. Evaluated against visible (projected)
   *  nodes only — referencing hidden fields will see undefined, not raw. */
  callerWhere?: Record<string, unknown>;
};

export type ExecuteListOpts = {
  limit: number;
  /** ReadCursor minted by a previous page of the SAME plan (see plan-hash.ts). */
  cursor?: string;
  budget?: { maxRawScanned: number };
  signal?: AbortSignal;
};

export type ExecuteListResult = {
  items: NodeData[];
  /** Set when more pages exist after a complete scan within budget. Mutually
   *  exclusive with `truncated` — pagination implies the budget held. */
  nextCursor?: string;
  /** Set when the scan hit `budget.maxRawScanned` before reaching the end of
   *  the source. Returned items are a prefix of what would have been visible;
   *  no nextCursor — clients cannot safely resume past a truncated page. */
  truncated?: true;
};

/** Default operational guard. Not pagination — a runaway scan beyond this
 *  shape means the predicate is dropping nearly everything. Surfaced via
 *  truncated:true on the result, with no nextCursor. */
export const DEFAULT_BUDGET = { maxRawScanned: 10_000 };

/** Both predicates may be user-authored (callerWhere always, viewWhere via a
 *  user-authored query mount): within the expression limits, no code-eval
 *  operators, no hidden fields. Judged before any node is read. */
export function assertPlanPredicates(plan: ReadPlan): void {
  for (const [where, q] of [['callerWhere', plan.callerWhere], ['viewWhere', plan.viewWhere]] as const) {
    if (!q) continue;
    assertSafeSiftQuery(q, DEFAULT_LIMITS);
    assertVisiblePredicate(q, where);
  }
}

export async function executeList(
  source: TreeSource,
  plan: ReadPlan,
  opts: ExecuteListOpts,
  project: Projector,
  ctx?: unknown,
): Promise<ExecuteListResult> {
  const { limit } = opts;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new KernelError('INVALID', `executeList: limit must be positive integer, got ${limit}`);
  }
  const depth = plan.depth ?? 1;
  if (!Number.isInteger(depth) || (depth < 1 && depth !== -1)) {
    throw new KernelError('INVALID', `executeList: depth must be a positive integer or -1, got ${depth}`);
  }
  const budget = opts.budget ?? DEFAULT_BUDGET;

  assertPlanPredicates(plan);

  const viewTest = plan.viewWhere ? createSiftTest(plan.viewWhere, DEFAULT_LIMITS) : null;
  const callerTest = plan.callerWhere ? createSiftTest(plan.callerWhere, DEFAULT_LIMITS) : null;
  const work = exprWork(DEFAULT_LIMITS);

  const collected: { node: NodeData; cursor: string }[] = [];
  let rawScanned = 0;

  // Cursor↔plan binding (core-8an): cursors carry the minting plan's hash;
  // replay under any other plan is refused (see plan-hash.ts).
  const hash = planHash(plan);

  const scan = source.scanChildren(plan.source, {
    depth,
    after: opts.cursor === undefined ? undefined : decodeReadCursor(opts.cursor, hash),
    limitHint: limit + 1,
    signal: opts.signal,
  }, ctx);

  for await (const entry of scan) {
    rawScanned++;
    if (rawScanned > budget.maxRawScanned) {
      // Partial page — return what we have. No nextCursor: resuming after a
      // budget-truncated scan would silently skip filtered-out raw entries.
      return { items: collected.map(c => c.node), truncated: true };
    }

    const visible = await project(entry.node);
    if (!visible) continue;

    // Both viewWhere and callerWhere run against the projected node so
    // hidden fields can't be probed via membership (see file header).
    const siftView = mapNodeForSift(visible);
    if (viewTest && !viewTest(siftView, work)) continue;
    if (callerTest && !callerTest(siftView, work)) continue;

    collected.push({ node: visible, cursor: entry.cursor });
    if (collected.length === limit + 1) break;
  }

  if (collected.length === limit + 1) {
    return {
      items: collected.slice(0, limit).map(c => c.node),
      nextCursor: encodeReadCursor(hash, collected[limit - 1].cursor),
    };
  }
  return { items: collected.map(c => c.node) };
}
