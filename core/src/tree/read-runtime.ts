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
// deferred until F4. depth=1 only — MVP scope.

import type { NodeData } from '#core';
import { OpError } from '#errors';
import { mapNodeForSift, type TreeSource } from './index';
import { assertSafeSiftQuery, createSiftTest } from './query';

export type Projector = (node: NodeData) => Promise<NodeData | null>;

export type ReadPlan = {
  source: string;
  /** Trusted predicate from mount/config. Pushdown-safe. */
  viewWhere?: Record<string, unknown>;
  /** Untrusted predicate from client. Evaluated against visible (projected)
   *  nodes only — referencing hidden fields will see undefined, not raw. */
  callerWhere?: Record<string, unknown>;
};

export type ExecuteListOpts = {
  limit: number;
  cursor?: string;
  budget?: { maxRawScanned: number };
  signal?: AbortSignal;
};

export type ExecuteListResult = {
  items: NodeData[];
  nextCursor?: string;
};

/** Default operational guard. Not pagination — a runaway scan beyond this
 *  shape means the predicate is dropping nearly everything; surface it. */
export const DEFAULT_BUDGET = { maxRawScanned: 10_000 };

export async function executeList(
  source: TreeSource,
  plan: ReadPlan,
  opts: ExecuteListOpts,
  project: Projector,
  ctx?: unknown,
): Promise<ExecuteListResult> {
  const { limit } = opts;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new OpError('BAD_REQUEST', `executeList: limit must be positive integer, got ${limit}`);
  }
  const budget = opts.budget ?? DEFAULT_BUDGET;

  // callerWhere is untrusted — block code-eval operators before sift sees them.
  // viewWhere is trusted; assertSafe still cheap to apply for defense-in-depth.
  if (plan.callerWhere) assertSafeSiftQuery(plan.callerWhere);
  if (plan.viewWhere) assertSafeSiftQuery(plan.viewWhere);

  const viewTest = plan.viewWhere ? createSiftTest(plan.viewWhere) : null;
  const callerTest = plan.callerWhere ? createSiftTest(plan.callerWhere) : null;

  const collected: { node: NodeData; cursor: string }[] = [];
  let rawScanned = 0;

  const scan = source.scanChildren(plan.source, {
    after: opts.cursor,
    limitHint: limit + 1,
    signal: opts.signal,
  }, ctx);

  for await (const entry of scan) {
    rawScanned++;
    if (rawScanned > budget.maxRawScanned) {
      throw new OpError(
        'RESOURCE_EXHAUSTED',
        `executeList: scan budget exhausted (${budget.maxRawScanned})`,
      );
    }

    const visible = await project(entry.node);
    if (!visible) continue;

    // Both viewWhere and callerWhere run against the projected node so
    // hidden fields can't be probed via membership (see file header).
    const siftView = mapNodeForSift(visible);
    if (viewTest && !viewTest(siftView)) continue;
    if (callerTest && !callerTest(siftView)) continue;

    collected.push({ node: visible, cursor: entry.cursor });
    if (collected.length === limit + 1) break;
  }

  if (collected.length === limit + 1) {
    return {
      items: collected.slice(0, limit).map(c => c.node),
      nextCursor: collected[limit - 1].cursor,
    };
  }
  return { items: collected.map(c => c.node) };
}
