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
import { decodeReadCursor, encodeReadCursor, planHash } from './plan-hash';
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

  // Cursor↔plan binding (core-8an): cursors carry the minting plan's hash;
  // replay under any other plan is refused (see plan-hash.ts).
  const hash = planHash(plan);

  const scan = source.scanChildren(plan.source, {
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
    if (viewTest && !viewTest(siftView)) continue;
    if (callerTest && !callerTest(siftView)) {
      // MVP rule 8 — hidden-field oracle: the caller predicate did not match
      // the PROJECTED node, but matches the RAW node. That can only happen when
      // it references a field the caller cannot see on a node they CAN read —
      // a membership oracle over hidden data. Refuse rather than leak. Raw eval
      // is paid only on non-match. (Documented limitation: a predicate on a
      // field ABSENT for every row never rawMatches and passes silently.)
      if (callerTest(mapNodeForSift(entry.node))) {
        throw new OpError('FORBIDDEN', 'callerWhere references a field not visible to the caller');
      }
      continue;
    }

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
