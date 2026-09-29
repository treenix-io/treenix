// Expression work (A10): a condition tests every value its path reaches, so neither the expression size nor
// the node size bounds the work alone. Parsing fixes each condition's weight; one walk of a node counts the
// values at every path before sift tests it. The parse mirrors how sift reads a query, so a path here is the
// path sift walks.

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

export type SetOperand = string | number | boolean | null

const isSetOperand = (v: unknown): v is SetOperand =>
  typeof v === 'string' || typeof v === 'boolean' || v === null || (typeof v === 'number' && !Number.isNaN(v))

/** $in and $nin over primitives test through a Set, so they weigh 1 whatever their size. */
export function setOperands(params: unknown): readonly SetOperand[] | null {
  const values = Array.isArray(params) ? params : [params]
  return values.every(isSetOperand) ? values : null
}

// sift reads a numeric key (or `length`) from an array itself and walks the elements for any other key.
const readsArray = (key: string) => !Number.isNaN(Number(key)) || key === 'length'

// Deep equality compares every value of a compound literal.
function literalWeight(v: unknown): number {
  if (Array.isArray(v)) return v.reduce((sum: number, item) => sum + literalWeight(item), 1)
  if (isRecord(v)) return Object.values(v).reduce((sum: number, item) => sum + literalWeight(item), 1)
  return 1
}

const newPath = (): PathWork => ({ weight: 0, total: 0, nameTotal: 0, children: new Map() })

function child(at: PathWork, key: string): PathWork {
  let next = at.children.get(key)
  if (!next) at.children.set(key, next = newPath())
  return next
}

const holdsOperator = (v: unknown): v is Record<string, unknown> =>
  isRecord(v) && Object.keys(v).some((key) => key.startsWith('$'))

const GROUPS = new Set(['$and', '$or', '$nor'])
const VALUE = new Set(['$eq', '$ne', '$gt', '$gte', '$lt', '$lte'])
const UNIT = new Set(['$exists', '$size', '$type', '$mod'])

function operator(op: string, params: unknown, at: PathWork): void {
  if (GROUPS.has(op)) {
    if (!Array.isArray(params) || params.length === 0) throw new KernelError('INVALID', `${op} takes a non-empty array`)
    for (const branch of params) query(branch, at)
  } else if (op === '$all') {
    if (!Array.isArray(params)) throw new KernelError('INVALID', '$all takes an array')
    for (const item of params) query(item, at)
  } else if (op === '$elemMatch' || op === '$not') {
    if (op === '$elemMatch' && (params === null || typeof params !== 'object'))
      throw new KernelError('INVALID', '$elemMatch takes an object')
    query(params, at)
  } else if (op === '$in' || op === '$nin') {
    const values = Array.isArray(params) ? params : [params]
    if (values.some(holdsOperator)) throw new KernelError('INVALID', `${op} operands are values, not conditions`)
    at.weight += setOperands(values) ? 1 : values.reduce((sum: number, v) => sum + literalWeight(v), 0)
  } else if (VALUE.has(op)) {
    at.weight += literalWeight(params)
  } else if (UNIT.has(op)) {
    at.weight += 1
  } else if (op !== '$options') {
    throw new KernelError('INVALID', `Unsupported sift operator: ${op}`)
  }
}

// A field value holding any $-key is a set of operators; anything else is a literal compared by deep equality.
function field(at: PathWork, value: unknown): void {
  if (!holdsOperator(value)) {
    at.weight += literalWeight(value)
    return
  }

  for (const [op, params] of Object.entries(value)) {
    if (!op.startsWith('$')) throw new KernelError('INVALID', `Field conditions mix operators and fields: ${op}`)
    operator(op, params, at)
  }
}

// A query rooted at `at`: operators test the value there, other keys are dotted paths below it.
function query(q: unknown, at: PathWork): void {
  if (!isRecord(q) && !Array.isArray(q)) {
    at.weight += literalWeight(q)
    return
  }

  for (const [key, value] of Object.entries(q)) {
    if (key.startsWith('$')) operator(key, value, at)
    else field(key.split('.').reduce(child, at), value)
  }
}

function sumTotals(at: PathWork): number {
  at.total = at.weight
  at.nameTotal = 0
  for (const [key, next] of at.children) {
    const total = sumTotals(next)
    at.total += total
    if (!readsArray(key)) at.nameTotal += total
  }
  return at.total
}

/** Paths and weights of an expression already mapped to storage keys; INVALID on an operator sift lacks. */
export function parseWork(q: unknown): PathWork {
  const root = newPath()
  query(q, root)
  sumTotals(root)
  return root
}

// Values tested at a path: an array gives one per element at any depth; an empty one is tested itself.
function values(v: unknown): number {
  if (!Array.isArray(v)) return 1
  let n = 0
  for (const item of v) n += values(item)
  return Math.max(1, n)
}

// The children of `at` read from a record; the loop runs over the smaller of its keys and the children.
function fields(v: Record<string, unknown>, at: PathWork, namesOnly: boolean): number {
  const counts = (key: string) => !namesOnly || !readsArray(key)
  let sum = namesOnly ? at.nameTotal : at.total - at.weight
  const own = Object.keys(v)

  if (own.length < at.children.size) {
    for (const key of own) {
      const next = at.children.get(key)
      if (next && counts(key)) sum += work(v[key], next) - next.total
    }
  } else {
    for (const [key, next] of at.children)
      if (counts(key) && Object.hasOwn(v, key)) sum += work(v[key], next) - next.total
  }
  return sum
}

// The numeric children of `at`, read from the array itself.
function indexed(v: unknown[], at: PathWork): number {
  let sum = at.total - at.weight - at.nameTotal
  if (sum === 0) return 0

  if (v.length < at.children.size) {
    for (let i = 0; i < v.length; i++) {
      const next = at.children.get(String(i))
      if (next) sum += work(v[i], next) - next.total
    }
  } else {
    for (const [key, next] of at.children)
      if (readsArray(key) && Object.hasOwn(v, key)) sum += work(Reflect.get(v, key), next) - next.total
  }
  return sum
}

// The other children of `at`, reached through every element of an array, nested arrays included.
function elements(v: unknown, at: PathWork): number {
  if (at.nameTotal === 0) return 0
  if (!Array.isArray(v)) return isRecord(v) ? fields(v, at, true) : at.nameTotal
  if (v.length === 0) return at.nameTotal

  let sum = 0
  for (const item of v) sum += elements(item, at)
  return sum
}

function work(v: unknown, at: PathWork): number {
  const here = at.weight === 0 ? 0 : at.weight * values(v)
  if (at.total === at.weight) return here

  if (Array.isArray(v)) return here + indexed(v, at) + elements(v, at)
  if (isRecord(v)) return here + fields(v, at, false)
  return here + at.total - at.weight
}

/** Charge the work of testing `node` to its operation; past the limit it is BUDGET and the node stays untested. */
export function chargeWork(node: Record<string, unknown>, paths: PathWork, counter: ExprWork): void {
  counter.used += work(node, paths)
  if (counter.used > counter.limit)
    throw new KernelError('BUDGET', `Expression work ${counter.used} exceeds the limit ${counter.limit}`)
}
