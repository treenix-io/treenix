// The expression language (§7): Mongo queries over dotted paths with $eq, $ne, $gt, $gte, $lt, $lte, $in, $nin,
// $exists, $size, $all, $elemMatch, $not, $and, $or and $nor, operands primitive. A query compiles once into tests
// the evaluator runs; a shape outside the language, Mongo's refusals included, is INVALID before any node is read,
// so a query means the same whichever Store runs it.

import { KernelError } from '#errors'
import { anyAt, charge, type Doc, type ExprWork, isDocument, type Path, type ValueTest } from './eval'
import { compares, equals, isOperand, type Operand, present, sized, someElement, within } from './eval-ops'

/** A compiled test: of a document for a query, of one array element for a value-form $elemMatch. */
export type Test<S> = (source: S, work: ExprWork) => boolean

// How the conditions of one field read their values: along a path of a document, or the element itself.
type Read<S> = (source: S, expand: boolean, test: ValueTest, work: ExprWork) => boolean

const GROUPS = new Set(['$and', '$or', '$nor'])
const INDEX = /^(0|[1-9][0-9]*)$/

/** Only a literal object is a query or an operator set; any other object is refused rather than read. */
export const isQueryObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && Object.getPrototypeOf(v) === Object.prototype

const holdsOperators = (v: unknown): v is Record<string, unknown> =>
  isQueryObject(v) && Object.keys(v).some((key) => key.startsWith('$'))

function every<S>(tests: readonly Test<S>[], source: S, work: ExprWork): boolean {
  for (const test of tests) if (!test(source, work)) return false
  return true
}

function some<S>(tests: readonly Test<S>[], source: S, work: ExprWork): boolean {
  for (const test of tests) if (test(source, work)) return true
  return false
}

const reading = <S>(read: Read<S>, expand: boolean, test: ValueTest): Test<S> => (source, work) =>
  read(source, expand, test, work)

// Every compiled test charges or calls one that does, so the calls of an evaluation stay within a constant of its
// counted work however the expression nests.
const not = <S>(test: Test<S>): Test<S> => (source, work) => {
  charge(work)
  return !test(source, work)
}

const never: Test<unknown> = (_source, work) => {
  charge(work)
  return false
}

const itself: Read<unknown> = (value, _expand, test, work) => {
  charge(work)
  return test(value, work)
}

function operand(op: string, v: unknown): Operand {
  if (isOperand(v)) return v
  throw new KernelError('INVALID', `${op} compares with primitives only; $elemMatch reaches objects in arrays`)
}

function operands(op: string, v: unknown): readonly Operand[] {
  if (Array.isArray(v) && v.every(isOperand)) return v
  throw new KernelError('INVALID', `${op} takes an array of primitives`)
}

const isElemMatchItem = (v: unknown): v is { $elemMatch: unknown } =>
  isQueryObject(v) && Object.keys(v).length === 1 && Object.hasOwn(v, '$elemMatch')

// Mongo reads $all as all of its items: [] matches nothing, and items are all primitives or all {$elemMatch}.
function all<S>(items: unknown, read: Read<S>): Test<S> {
  if (!Array.isArray(items)) throw new KernelError('INVALID', '$all takes an array')
  if (items.length === 0) return never

  const elemMatches = items.filter(isElemMatchItem)
  if (elemMatches.length > 0 && elemMatches.length < items.length)
    throw new KernelError('INVALID', '$all items are all primitives or all {$elemMatch: query}')

  const tests = elemMatches.length > 0
    ? elemMatches.map((item) => operator('$elemMatch', item.$elemMatch, read))
    : items.map((item) => operator('$eq', item, read))
  return (source, work) => every(tests, source, work)
}

// Operators first make the value form, testing each element itself; fields and groups make the object form, a
// query over each element that is a document or an array.
function elemMatch(q: unknown): ValueTest {
  if (!isQueryObject(q)) throw new KernelError('INVALID', '$elemMatch takes a query object')

  const first = Object.keys(q)[0]
  if (first?.startsWith('$') && !GROUPS.has(first)) return someElement(conditions(q, itself))

  const query = compileQuery(q, '$elemMatch')
  return someElement((element, work) => (isDocument(element) || Array.isArray(element)) && query(element, work))
}

function operator<S>(op: string, params: unknown, read: Read<S>): Test<S> {
  switch (op) {
    case '$eq':
      return reading(read, true, equals(operand(op, params)))
    case '$ne':
      return not(reading(read, true, equals(operand(op, params))))
    case '$gt':
    case '$gte':
    case '$lt':
    case '$lte':
      return reading(read, true, compares(op, operand(op, params)))
    case '$in':
      return reading(read, true, within(operands(op, params)))
    case '$nin':
      return not(reading(read, true, within(operands(op, params))))
    case '$exists':
      if (typeof params !== 'boolean') throw new KernelError('INVALID', '$exists takes true or false')
      return params ? reading(read, false, present) : not(reading(read, false, present))
    case '$size':
      if (typeof params !== 'number' || !Number.isInteger(params) || params < 0)
        throw new KernelError('INVALID', '$size takes a non-negative integer')
      return reading(read, false, sized(params))
    case '$all':
      return all(params, read)
    case '$elemMatch':
      return reading(read, false, elemMatch(params))
    case '$not':
      if (!holdsOperators(params)) throw new KernelError('INVALID', '$not takes operators on the value')
      return not(conditions(params, read))
  }

  if (GROUPS.has(op)) throw new KernelError('INVALID', `${op} combines queries, not the conditions of a field`)
  throw new KernelError('INVALID', `Unsupported operator: ${op}`)
}

// A value holding a $-key is a set of operators, all of which must hold; anything else is compared by equality.
function conditions<S>(value: unknown, read: Read<S>): Test<S> {
  if (!holdsOperators(value)) return operator('$eq', value, read)

  const tests = Object.entries(value).map(([op, params]) => {
    if (!op.startsWith('$')) throw new KernelError('INVALID', `Field conditions mix operators and fields: ${op}`)
    return operator(op, params, read)
  })
  return (source, work) => every(tests, source, work)
}

function group(op: string, branches: unknown): Test<Doc> {
  if (!GROUPS.has(op)) throw new KernelError('INVALID', `${op} is no query operator; a query holds fields and $and, $or, $nor`)
  if (!Array.isArray(branches) || branches.length === 0) throw new KernelError('INVALID', `${op} takes a non-empty array of queries`)

  const tests = branches.map((branch) => compileQuery(branch, op))
  if (op === '$and') return (doc, work) => every(tests, doc, work)
  if (op === '$or') return (doc, work) => some(tests, doc, work)
  return (doc, work) => !some(tests, doc, work)
}

// Mongo reads an empty segment its own way at an array ('a.' there is not 'a' then ''), so none is in the language.
function pathOf(key: string): Path {
  const names = key.split('.')
  if (names.includes('')) throw new KernelError('INVALID', `A path has an empty segment: ${JSON.stringify(key)}`)
  return names.map((name) => ({ name, index: INDEX.test(name) ? Number(name) : -1 }))
}

/** Compile a query already mapped to storage keys; INVALID on what the language refuses. */
export function compileQuery(q: unknown, op = 'A query'): Test<Doc> {
  if (!isQueryObject(q)) throw new KernelError('INVALID', `${op} takes a query object`)

  const tests = Object.entries(q).map(([key, value]): Test<Doc> => {
    if (key.startsWith('$')) return group(key, value)

    const path = pathOf(key)
    return conditions(value, (doc: Doc, expand, test, work) => anyAt(doc, path, expand, test, work))
  })

  return (doc, work) => {
    charge(work)
    return every(tests, doc, work)
  }
}
