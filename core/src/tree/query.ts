// Treenix Query Tree — Layer 1
// Virtual filtered view over a parent tree's children.
// Used by t.mount.query to create virtual folders (e.g., /orders/incoming shows orders where status.value === 'incoming').

import { type NodeData } from '#core';
import { KernelError } from '#errors';
import { isRecord } from '#util/is-record';
import sift from 'sift';
import { mapNodeForSift, type Tree } from './index';

export type QueryConfig = {
  source: string;
  match: Record<string, unknown>;
};

/** Validate a t.mount.query component — shared by the mount adapter and the
 *  ACL read planner (resolve-plan.ts) so both accept and reject the same
 *  configs. An empty `match` is a legitimate match-all; a missing one is not. */
export function queryConfigOf(comp: Record<string, unknown>, at: string): QueryConfig {
  const { source, match } = comp;
  if (typeof source !== 'string' || !source.startsWith('/')) {
    throw new KernelError('INVALID', `query mount at ${at}: source must be an absolute path`);
  }
  if (!isRecord(match)) throw new KernelError('INVALID', `query mount at ${at}: match must be an object`);
  return { source, match };
}

// Refused in every sift query — predicates are user-authored (wire callerWhere,
// user-authored query mounts). Code-eval operators are server-side RCE. $regex
// (and RegExp values) are event-loop DoS: no static check catches every
// catastrophic pattern — a length cap + nested-quantifier heuristic let
// ^(.|.)*$ and ^(a+){2,}$ through at seconds per node — and nothing in the
// platform needs user regexes.
const SIFT_FORBIDDEN = new Set(['$where', '$function', '$accumulator', '$expr', '$regex']);

/** Validate a sift query (throws INVALID on a forbidden operator). */
export function assertSafeSiftQuery(q: unknown): void {
  mapSiftQuery(q);
}

/** Validate and map a sift query to storage keys. */
export function mapSiftQuery(q: unknown): unknown {
  if (Array.isArray(q)) return q.map(mapSiftQuery);
  if (q instanceof RegExp) throw new KernelError('INVALID', 'Forbidden sift value: RegExp');
  if (q && typeof q === 'object' && q.constructor === Object) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(q)) {
      if (SIFT_FORBIDDEN.has(k)) throw new KernelError('INVALID', `Forbidden sift operator: ${k}`);
      let newKey = k;
      if (k === '$type') newKey = '_type';
      else if (k === '$path') newKey = '_path';
      else if (k === '$acl') newKey = '_acl';
      else if (k === '$owner') newKey = '_owner';
      else if (k === '$rev') newKey = '_rev';
      else if (k === '$id') newKey = '_tid'; // matches toStorageKeys — queries can find nodes by identity
      else if (k === '$refId') newKey = '_refId'; // ref-target identity — omission here fails silently (matches nothing)
      out[newKey] = mapSiftQuery(v);
    }
    return out;
  }
  return q;
}

// core-anz4.3: read/watch predicates are validated up front and rejected if
// they reference a hidden field — THE rule for executeList and query watches.
// Predicates evaluate on the ACTOR-PROJECTED, storage-shaped node, but
// projection keeps $acl/$owner for A-holders and mapNodeForSift maps
// $acl→_acl, $owner→_owner, $refs→_refs, so predicates over those (or their
// storage aliases) stay statically rejected. viewWhere is guarded too: a
// query mount can be user-authored. Visible system fields, plain data fields
// and #-component predicates pass — a #-component the actor cannot read is
// stripped before evaluation, so it can never gate their membership.
// Both namespaces are allowlists: toStorageKeys maps EVERY top-level
// $foo→_foo, so any unknown _-field is a storage alias for a hidden system
// field and must fail closed too.
// The rejection is STATIC (depends only on the predicate, never on data): an
// earlier raw-node re-check threw only when hidden data matched — a 1-bit
// oracle that extracted hidden components character by character.
const VISIBLE_SYSTEM_FIELDS = new Set(['$path', '$type', '$rev', '$id', '$ref', '$refId']);
const VISIBLE_STORAGE_FIELDS = new Set(['_path', '_type', '_rev', '_tid', '_ref', '_refId']);
const LOGICAL_OPS = new Set(['$and', '$or', '$nor']);

/** Throw FORBIDDEN if a sift predicate references a hidden field (system field
 *  or its storage alias). Walks $and/$or/$nor branches; checks the head segment
 *  of dotted paths. Value-level operators ($exists/$gt/…) live under a field key
 *  and are not re-examined. */
export function assertVisiblePredicate(q: unknown, where: 'callerWhere' | 'viewWhere'): void {
  if (!q || typeof q !== 'object' || q.constructor !== Object) return;
  for (const [k, v] of Object.entries(q)) {
    if (LOGICAL_OPS.has(k)) {
      const branches = Array.isArray(v) ? v : [v];
      for (const b of branches) assertVisiblePredicate(b, where);
      continue;
    }
    const head = k.split('.')[0];
    const hiddenSystem = head.startsWith('$') && !VISIBLE_SYSTEM_FIELDS.has(head);
    const hiddenStorage = head.startsWith('_') && !VISIBLE_STORAGE_FIELDS.has(head);
    if (hiddenSystem || hiddenStorage) {
      throw new KernelError('FORBIDDEN', `${where} references a hidden field: ${k}`);
    }
  }
}

export function createSiftTest(match: Record<string, unknown>): (node: Record<string, unknown>) => boolean {
  return sift(mapSiftQuery(match) as Record<string, unknown>);
}

export function matchesFilter(node: NodeData, match: Record<string, unknown>): boolean {
  return sift(mapSiftQuery(match))(mapNodeForSift(node));
}

export function createQueryTree(config: QueryConfig, parentStore: Tree): Tree {
  return {
    async get(path, ctx) {
      return parentStore.get(path, ctx);
    },

    // RAW-tree reads only (systemTree, internal services): the public ACL
    // read path resolves query mounts into ReadPlans BEFORE the raw tree is
    // consulted (resolveReadPlan), so this adapter never sees client traffic.
    async getChildren(_path, opts, ctx) {
      if (opts?.query) assertSafeSiftQuery(opts.query);
      const mappedQuery = mapSiftQuery(config.match) as Record<string, unknown>;
      const mergedQuery = opts?.query ? { $and: [opts.query, mappedQuery] } : mappedQuery;
      return parentStore.getChildren(config.source, { ...opts, depth: 1, query: mergedQuery }, ctx);
    },

    async set() {
      throw new KernelError('FORBIDDEN', 'Query mount is read-only: writes not supported');
    },

    async remove() {
      throw new KernelError('FORBIDDEN', 'Query mount is read-only: removes not supported');
    },

    async patch() {
      throw new KernelError('FORBIDDEN', 'Query mount is read-only: patches not supported');
    },
  };
}
