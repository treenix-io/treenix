// The expression language of `where` and `pre`: sift without $regex and without code. Its cost is linear, so an
// expression is judged once, whole, before sift compiles it — size, static cost, forbidden operators — and its
// evaluation needs no counter beyond the nodes and bytes a read already counts.

import sift from 'sift'

import { KernelError } from '#errors'
import { isRecord } from '#util/is-record'
import type { Limits } from './types'

// Refused in every sift query — predicates are user-authored (wire callerWhere,
// user-authored query mounts). Code-eval operators are server-side RCE. $regex
// (and RegExp values) are event-loop DoS: no static check catches every
// catastrophic pattern — a length cap + nested-quantifier heuristic let
// ^(.|.)*$ and ^(a+){2,}$ through at seconds per node — and nothing in the
// platform needs user regexes.
const SIFT_FORBIDDEN = new Set(['$where', '$function', '$accumulator', '$expr', '$regex'])

const encoder = new TextEncoder()

/**
 * Rough per-node work of an expression, compared with `exprCost`: one unit per field condition and per
 * operator, plus one per operand value, so `$in`, `$nin` and `$all` weigh their number of values. A literal
 * object counts its fields, because deep equality compares every one of them.
 */
export function estimateCost(q: unknown): number {
  if (Array.isArray(q)) return q.reduce((sum: number, item) => sum + Math.max(1, estimateCost(item)), 0)
  if (!isRecord(q)) return 0

  let cost = 0
  for (const value of Object.values(q)) cost += 1 + estimateCost(value)
  return cost
}

// A 1e6-value $in fits every counter of scanned nodes and bytes, so size and cost are refused up front.
function assertWithinBudget(q: unknown, limits: Limits): void {
  const bytes = encoder.encode(JSON.stringify(q)).byteLength
  if (bytes > limits.exprBytes) throw new KernelError('BUDGET', `Expression is ${bytes} bytes, limit ${limits.exprBytes}`)

  const cost = estimateCost(q)
  if (cost > limits.exprCost) throw new KernelError('BUDGET', `Expression costs ${cost}, limit ${limits.exprCost}`)
}

/** Validate a sift query: BUDGET over the size or cost limit, INVALID on a forbidden operator. */
export function assertSafeSiftQuery(q: unknown, limits: Limits): void {
  assertWithinBudget(q, limits)
  mapSiftQuery(q)
}

/** Validate and map a sift query to storage keys. */
export function mapSiftQuery(q: unknown): unknown {
  if (Array.isArray(q)) return q.map(mapSiftQuery)
  if (q instanceof RegExp) throw new KernelError('INVALID', 'Forbidden sift value: RegExp')
  if (q && typeof q === 'object' && q.constructor === Object) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(q)) {
      if (SIFT_FORBIDDEN.has(k)) throw new KernelError('INVALID', `Forbidden sift operator: ${k}`)
      let newKey = k
      if (k === '$type') newKey = '_type'
      else if (k === '$path') newKey = '_path'
      else if (k === '$acl') newKey = '_acl'
      else if (k === '$owner') newKey = '_owner'
      else if (k === '$rev') newKey = '_rev'
      else if (k === '$id') newKey = '_tid' // matches toStorageKeys — queries can find nodes by identity
      else if (k === '$refId') newKey = '_refId' // ref-target identity — omission here fails silently (matches nothing)
      out[newKey] = mapSiftQuery(v)
    }
    return out
  }
  return q
}

// Read/watch predicates are validated up front and rejected if they
// reference a hidden field — THE rule for executeList and query watches.
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
const VISIBLE_SYSTEM_FIELDS = new Set(['$path', '$type', '$rev', '$id', '$ref', '$refId'])
const VISIBLE_STORAGE_FIELDS = new Set(['_path', '_type', '_rev', '_tid', '_ref', '_refId'])
const LOGICAL_OPS = new Set(['$and', '$or', '$nor'])

/** Throw FORBIDDEN if a sift predicate references a hidden field (system field
 *  or its storage alias). Walks $and/$or/$nor branches; checks the head segment
 *  of dotted paths. Value-level operators ($exists/$gt/…) live under a field key
 *  and are not re-examined. */
export function assertVisiblePredicate(q: unknown, where: 'callerWhere' | 'viewWhere'): void {
  if (!q || typeof q !== 'object' || q.constructor !== Object) return
  for (const [k, v] of Object.entries(q)) {
    if (LOGICAL_OPS.has(k)) {
      const branches = Array.isArray(v) ? v : [v]
      for (const b of branches) assertVisiblePredicate(b, where)
      continue
    }
    const head = k.split('.')[0]
    const hiddenSystem = head.startsWith('$') && !VISIBLE_SYSTEM_FIELDS.has(head)
    const hiddenStorage = head.startsWith('_') && !VISIBLE_STORAGE_FIELDS.has(head)
    if (hiddenSystem || hiddenStorage) {
      throw new KernelError('FORBIDDEN', `${where} references a hidden field: ${k}`)
    }
  }
}

/** Compile a sift query over storage-shaped nodes; it is validated first, so a refused one evaluates nothing. */
export function createSiftTest(
  match: Record<string, unknown>,
  limits: Limits,
): (node: Record<string, unknown>) => boolean {
  assertWithinBudget(match, limits)
  return sift(mapSiftQuery(match))
}
