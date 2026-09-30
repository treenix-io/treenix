// Expression work (A10, §7): a condition tests every value its path reaches, so neither the expression size nor
// the node size bounds the work alone. Parsing fixes each condition's weight and refuses what the formula cannot
// bound: a compound literal operand, whose deep equality walks the node's value whole, and a query under $not or
// in $all that reaches past the value itself — sift runs those on each element and again on the whole array, so
// every nesting level would walk the array once more. Before sift tests a node, one walk counts the values at
// every path and stops as soon as the operation's budget is exceeded. The parse mirrors how sift reads a query,
// so a path here is the path sift walks.

import { KernelError } from '#errors'
import { isRecord } from '#util/is-record'
import type { Limits } from './types'

/** The expression work of one operation: every node it tests is charged first. */
export interface ExprWork {
  readonly limit: number
  used: number
}

export const exprWork = (limits: Limits): ExprWork => ({ limit: limits.exprWork, used: 0 })

/** One path of an expression and the paths below it; weights are summed per path, so a node walks each once. */
export interface PathWork {
  /** Summed weight of the conditions at exactly this path. */
  weight: number
  /** This path's weight plus every child's total — the work when the path is missing. */
  total: number
  /** Totals of the children sift reaches through the elements of an array. */
  nameTotal: number
  readonly children: Map<string, PathWork>
}

/** A comparison operand: a primitive, compared with each value in constant time. */
export type Operand = string | number | boolean | null

// NaN equals nothing in sift but itself in a Set, and JSON cannot carry it.
const isOperand = (v: unknown): v is Operand =>
  typeof v === 'string' || typeof v === 'boolean' || v === null || (typeof v === 'number' && !Number.isNaN(v))

const notOperand = (op: string) =>
  new KernelError('INVALID', `${op} compares with primitives only; $elemMatch reaches objects in arrays`)

// A comparison with one primitive operand weighs 1.
function primitive(op: string, v: unknown, at: PathWork): void {
  if (!isOperand(v)) throw notOperand(op)
  at.weight += 1
}

/** The operands of $in and $nin: primitives only, so they test through a Set and weigh 1. */
export function setOperands(op: string, params: unknown): readonly Operand[] {
  const values: unknown[] = Array.isArray(params) ? params : [params]
  if (values.every(isOperand)) return values
  throw notOperand(op)
}

// sift reads a numeric key (or `length`) from an array itself and walks the elements for any other key.
const readsArray = (key: string) => !Number.isNaN(Number(key)) || key === 'length'

const newPath = (): PathWork => ({ weight: 0, total: 0, nameTotal: 0, children: new Map() })

function child(at: PathWork, key: string): PathWork {
  let next = at.children.get(key)
  if (!next) at.children.set(key, next = newPath())
  return next
}

const holdsOperator = (v: unknown): v is Record<string, unknown> =>
  isRecord(v) && Object.keys(v).some((key) => key.startsWith('$'))

const GROUPS = new Set(['$and', '$or', '$nor'])
const PRIMITIVE = new Set(['$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$exists'])

// Operators whose parameter is not a comparison operand, by the shape sift reads. `$type` never arrives here:
// storage mapping turns every `$type` key into the `_type` field.
const SHAPED = new Map<string, (params: unknown) => boolean>([
  ['$size', (n) => typeof n === 'number'],
  ['$mod', (pair) => Array.isArray(pair) && pair.length === 2 && pair.every((n) => typeof n === 'number')],
])

// What $not may hold: tests of the value itself. $elemMatch is one — handed an element it does nothing, so its
// query runs on the array's elements once however often sift hands it values.
const VALUE_TESTS = new Set([...PRIMITIVE, ...SHAPED.keys(), '$in', '$nin', '$elemMatch'])

/**
 * What an operator tests. `node`: the whole expression and its group branches — a node is a record, so only
 * fields and groups apply (sift's $exists even throws there). `element`: an $elemMatch query and its branches,
 * testing each element. `field`: the conditions of one path, where sift refuses groups.
 */
type Level = 'node' | 'element' | 'field'

function operator(op: string, params: unknown, at: PathWork, level: Level): void {
  const shaped = SHAPED.get(op)
  if (GROUPS.has(op)) {
    if (level === 'field') throw new KernelError('INVALID', `${op} combines queries, not the conditions of a field`)
    if (!Array.isArray(params) || params.length === 0) throw new KernelError('INVALID', `${op} takes a non-empty array`)
    for (const branch of params) query(op, branch, at, level)
  } else if (level === 'node') {
    throw new KernelError('INVALID', `${op} tests a value; the top of an expression holds fields and groups`)
  } else if (op === '$all') {
    if (!Array.isArray(params)) throw new KernelError('INVALID', '$all takes an array')
    for (const item of params) allItem(item, at)
  } else if (op === '$elemMatch') {
    query(op, params, at, 'element')
  } else if (op === '$not') {
    negated(params, at)
  } else if (op === '$in' || op === '$nin') {
    setOperands(op, params)
    at.weight += 1
  } else if (PRIMITIVE.has(op)) {
    primitive(op, params, at)
  } else if (shaped) {
    if (!shaped(params)) throw new KernelError('INVALID', `${op} does not take ${JSON.stringify(params)}`)
    at.weight += 1
  } else if (op !== '$options') {
    throw new KernelError('INVALID', `Unsupported sift operator: ${op}`)
  }
}

// The $not operand: a primitive, or tests of the value (Mongo refuses paths and groups under $not as well).
function negated(v: unknown, at: PathWork): void {
  if (!isRecord(v)) return primitive('$not', v, at)

  for (const [op, params] of Object.entries(v)) {
    if (!VALUE_TESTS.has(op)) throw new KernelError('INVALID', `$not holds tests of the value itself, not ${op}`)
    operator(op, params, at, 'field')
  }
}

// An $all item: a primitive or {$elemMatch: …}, as in Mongo, which reads any other object as a literal.
function allItem(v: unknown, at: PathWork): void {
  if (!isRecord(v)) return primitive('$all', v, at)

  const keys = Object.keys(v)
  if (keys.length !== 1 || keys[0] !== '$elemMatch')
    throw new KernelError('INVALID', '$all items are primitives or {$elemMatch: query}')
  query('$elemMatch', v.$elemMatch, at, 'element')
}

// A field value holding any $-key is a set of operators; anything else is compared by equality.
function field(at: PathWork, value: unknown): void {
  if (!holdsOperator(value)) return primitive('Equality', value, at)

  for (const [op, params] of Object.entries(value)) {
    if (!op.startsWith('$')) throw new KernelError('INVALID', `Field conditions mix operators and fields: ${op}`)
    operator(op, params, at, 'field')
  }
}

// A query rooted at `at`: operators test the value there, other keys are dotted paths below it.
function query(op: string, q: unknown, at: PathWork, level: Exclude<Level, 'field'>): void {
  if (!isRecord(q)) throw new KernelError('INVALID', `${op} takes a query object`)

  for (const [key, value] of Object.entries(q)) {
    if (key.startsWith('$')) operator(key, value, at, level)
    else field(key.split('.').reduce(child, at), value)
  }
}

// Paths without work are dropped, so every path the walk visits charges at least once.
function sumTotals(at: PathWork): number {
  at.total = at.weight
  at.nameTotal = 0
  for (const [key, next] of at.children) {
    const total = sumTotals(next)
    if (total === 0) {
      at.children.delete(key)
      continue
    }
    at.total += total
    if (!readsArray(key)) at.nameTotal += total
  }
  return at.total
}

/** Paths and weights of an expression already mapped to storage keys; INVALID on what the language refuses. */
export function parseWork(q: unknown): PathWork {
  const root = newPath()
  query('A query', q, root, 'node')
  sumTotals(root)
  return root
}

function charge(counter: ExprWork, n: number): void {
  counter.used += n
  if (counter.used > counter.limit)
    throw new KernelError('BUDGET', `Expression work exceeds the limit ${counter.limit}`)
}

// sift walks an array inside an array once per level (and compares it whole at each), so the formula cannot
// bound it.
const nestedArray = () => new KernelError('BUDGET', 'An array directly inside an array on a condition path')

// The values a condition at this path tests: one per element of an array; an empty array is tested itself.
function chargeValues(v: unknown, weight: number, counter: ExprWork): void {
  if (!Array.isArray(v) || v.length === 0) return charge(counter, weight)

  for (const item of v) {
    if (Array.isArray(item)) throw nestedArray()
    charge(counter, weight)
  }
}

// The children of `at` read from a record; with namesOnly, those sift reaches through the elements of an array.
function walkFields(v: Record<string, unknown>, at: PathWork, counter: ExprWork, namesOnly: boolean): void {
  for (const [key, next] of at.children) {
    if (namesOnly && readsArray(key)) continue
    if (Object.hasOwn(v, key)) walk(v[key], next, counter)
    else charge(counter, next.total)
  }
}

function walkElements(v: unknown[], at: PathWork, counter: ExprWork): void {
  if (v.length === 0) return charge(counter, at.nameTotal)

  for (const item of v) {
    if (Array.isArray(item)) throw nestedArray()
    if (isRecord(item)) walkFields(item, at, counter, true)
    else charge(counter, at.nameTotal)
  }
}

function walk(v: unknown, at: PathWork, counter: ExprWork): void {
  if (at.weight > 0) chargeValues(v, at.weight, counter)
  if (at.total === at.weight) return

  if (isRecord(v)) return walkFields(v, at, counter, false)
  if (!Array.isArray(v)) return charge(counter, at.total - at.weight)

  for (const [key, next] of at.children) {
    if (!readsArray(key)) continue
    if (Object.hasOwn(v, key)) walk(Reflect.get(v, key), next, counter)
    else charge(counter, next.total)
  }
  if (at.nameTotal > 0) walkElements(v, at, counter)
}

/** Charge the work of testing `node` to its operation; past the limit it is BUDGET and the node stays untested. */
export function chargeWork(node: Record<string, unknown>, paths: PathWork, counter: ExprWork): void {
  if (paths.total > 0) walk(node, paths, counter)
}
