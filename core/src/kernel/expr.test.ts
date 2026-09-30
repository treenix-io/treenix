import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import sift from 'sift'

import { KernelError } from '#errors'
import { assertSafePredicate, assertSafeSiftQuery, createSiftTest } from './expr'
import { type ExprWork, exprWork } from './expr-work'
import { DEFAULT_LIMITS } from './types'

const isBudget = (e: unknown) => e instanceof KernelError && e.code === 'BUDGET'
const isInvalid = (e: unknown) => e instanceof KernelError && e.code === 'INVALID'

const values = (n: number, from = 0) => Array.from({ length: n }, (_, i) => i + from)

// Work of one test on a fresh counter.
function workOf(q: Record<string, unknown>, node: Record<string, unknown>): number {
  const work = exprWork(DEFAULT_LIMITS)
  createSiftTest(q, DEFAULT_LIMITS)(node, work)
  return work.used
}

// A 100 000-element array that counts reads of its elements.
function countedArray(length: number): { array: number[]; reads: () => number } {
  let reads = 0
  const array = new Proxy(new Array<number>(length).fill(0), {
    get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) reads++
      return Reflect.get(target, key, receiver)
    },
  })
  return { array, reads: () => reads }
}

describe('expression size', () => {
  it('a 17 KiB expression is refused with BUDGET before a tester exists', () => {
    const q = { name: 'x'.repeat(17 * 1024) }

    assert.throws(() => assertSafeSiftQuery(q, DEFAULT_LIMITS), isBudget)
    assert.throws(() => createSiftTest(q, DEFAULT_LIMITS), isBudget)
  })

  it('size is counted in UTF-8 bytes, not characters', () => {
    assert.throws(() => createSiftTest({ name: 'я'.repeat(9 * 1024) }, DEFAULT_LIMITS), isBudget)
  })

  it('the size limit is a parameter', () => {
    const q = { tag: { $in: values(100) } }
    assert.doesNotThrow(() => assertSafeSiftQuery(q, DEFAULT_LIMITS))
    assert.throws(() => assertSafeSiftQuery(q, { ...DEFAULT_LIMITS, exprBytes: 64 }), isBudget)
  })

  it('code and regex operators stay INVALID on the compile path', () => {
    for (const q of [{ $where: 'true' }, { name: { $regex: 'x' } }, { name: /x/ }])
      assert.throws(() => createSiftTest(q, DEFAULT_LIMITS), isInvalid, String(Object.keys(q)))
  })

  it('an operator sift lacks, or operators mixed with fields, is INVALID at compile', () => {
    const invalid = [
      { name: { $text: 'x' } }, { $comment: 'x' }, { name: { $gt: 1, sub: 2 } }, { $or: [] }, { $and: {} },
      { $or: [1] }, { name: { $in: [{ $gt: 1 }] } }, { name: { $size: '1' } }, { name: { $mod: [2] } },
      { name: { $elemMatch: 1 } },
    ]
    for (const q of invalid)
      assert.throws(() => createSiftTest(q, DEFAULT_LIMITS), isInvalid, JSON.stringify(q))
  })

  it('a compound or NaN operand is INVALID at compile', () => {
    const invalid: Record<string, unknown>[] = [
      { a: { x: 1 } }, { a: [1] }, { a: Number.NaN }, { a: { $eq: { x: 1 } } }, { a: { $ne: [1] } }, { a: { $gt: {} } },
      { a: { $in: [{ x: 1 }] } }, { a: { $nin: [[1]] } }, { a: { $all: [[1]] } }, { a: { $not: [1] } },
      { $or: [{ a: 1 }, { b: { c: 1 } }] }, { list: { $elemMatch: { x: [1] } } },
    ]
    for (const q of invalid) assert.throws(() => createSiftTest(q, DEFAULT_LIMITS), isInvalid, JSON.stringify(q))
  })

  it('an object-literal $in over a 12 000-key object is INVALID before any node is tested', () => {
    const node = { a: Object.fromEntries(values(12_000).map((i) => [`k${i}`, i])) }
    const q = { a: { $in: [{ k0: 0 }] } }

    assert.throws(() => createSiftTest(q, DEFAULT_LIMITS)(node, exprWork(DEFAULT_LIMITS)), isInvalid)
  })

  it('primitive operands, value tests under $not, $elemMatch items in $all, groups at a query root, $size and $mod parse', () => {
    const valid: Record<string, unknown>[] = [
      { a: 'x', b: 1, c: true, d: null }, { a: { $in: ['x', 1, null], $nin: [false] } },
      { a: { $all: [1, 'x'] } }, { list: { $all: [{ $elemMatch: { x: 1, y: { $all: [2] } } }] } },
      { a: { $not: { $gt: 1, $lt: 5, $in: [7], $size: 2, $exists: true } } }, { a: { $not: 1 } },
      { list: { $not: { $elemMatch: { x: { $not: { $eq: 1 } } } } } },
      { list: { $elemMatch: { x: 1, 'y.z': { $exists: true } } } }, { list: { $elemMatch: { $or: [{ x: 1 }, { $gt: 2 }] } } },
      { a: { $size: 2 } }, { a: { $mod: [2, 0] } }, { $nor: [{ a: 1 }], $and: [{ b: { $lte: 3 } }] },
    ]
    for (const q of valid) assert.doesNotThrow(() => createSiftTest(q, DEFAULT_LIMITS), JSON.stringify(q))
  })

  it('a query under $not or in $all that reaches past the value itself is INVALID at compile', () => {
    let notChain: Record<string, unknown> = { $gt: 1 }
    let allChain: Record<string, unknown> = { $gt: 1 }
    for (let i = 0; i < 200; i++) {
      notChain = { $not: notChain }
      allChain = { $all: [allChain] }
    }
    let notFields: Record<string, unknown> = { a: 1 }
    let allFields: Record<string, unknown> = { a: 1 }
    for (let i = 0; i < 22; i++) {
      notFields = { a: { $not: notFields } }
      allFields = { a: { $all: [allFields] } }
    }

    const invalid: Record<string, unknown>[] = [
      { a: notChain }, { a: allChain }, notFields, allFields,
      { a: { $not: { b: 1 } } }, { a: { $not: { $or: [{ $gt: 1 }] } } }, { a: { $not: { $all: [1] } } },
      { a: { $all: [{ $gt: 1 }] } }, { a: { $all: [{ b: 1 }] } }, { a: { $all: [{ $elemMatch: { b: 1 }, $gt: 1 }] } },
    ]
    for (const q of invalid) assert.throws(() => createSiftTest(q, DEFAULT_LIMITS), isInvalid, JSON.stringify(q).slice(0, 80))
  })

  it('a prototype key anywhere in a query is INVALID, a decoded __proto__ included, whoever runs the query', () => {
    const decoded = (key: string) => JSON.parse(`{"list":{"$elemMatch":{"${key}":{"$or":[{"$eq":1}]}}}}`)
    const invalid: Record<string, unknown>[] = [
      decoded('__proto__'), decoded('constructor'), decoded('prototype'), JSON.parse('{"__proto__":{"a":1}}'),
      { 'a.__proto__.b': 1 }, { 'a.constructor': 1 },
    ]
    for (const q of invalid) {
      assert.throws(() => createSiftTest(q, DEFAULT_LIMITS), isInvalid, Object.keys(q).join())
      assert.throws(() => assertSafeSiftQuery(q, DEFAULT_LIMITS), isInvalid, Object.keys(q).join())
      assert.throws(() => assertSafePredicate(q, DEFAULT_LIMITS, 'callerWhere'), isInvalid, Object.keys(q).join())
    }
  })

  it('a group among the conditions of a field, or a value test at the top of an expression, is INVALID at compile', () => {
    const invalid: Record<string, unknown>[] = [
      { a: { $or: [{ $gt: 1 }] } }, { a: { $and: [{ $gt: 1 }] } }, { a: { $nor: [{ $gt: 1 }] } },
      { $exists: true }, { $or: [{ $gt: 1 }] }, { $not: { $gt: 1 } }, { $elemMatch: { a: 1 } },
    ]
    for (const q of invalid) assert.throws(() => createSiftTest(q, DEFAULT_LIMITS), isInvalid, JSON.stringify(q))
  })
})

describe('expression work', () => {
  it('a 1000-branch $or over a 100 000-element array is refused with BUDGET before evaluation', () => {
    const { array, reads } = countedArray(100_000)
    const q = { $or: values(1_000, 1).map((v) => ({ arr: v })) }
    const test = createSiftTest(q, DEFAULT_LIMITS)

    assert.throws(() => test({ arr: array }, exprWork(DEFAULT_LIMITS)), isBudget)
    const budgetElements = DEFAULT_LIMITS.exprWork / 1_000
    assert.ok(reads() <= budgetElements + 1, `the walk stops once the budget is spent, never tested: ${reads()} element reads`)
  })

  it('1024 nested single-element arrays around 100 000 zeros are BUDGET without a long walk', () => {
    const { array, reads } = countedArray(100_000)
    let nested: unknown = array
    for (let i = 0; i < 1_024; i++) nested = [nested]

    assert.throws(() => createSiftTest({ a: 0 }, DEFAULT_LIMITS)({ a: nested }, exprWork(DEFAULT_LIMITS)), isBudget)
    assert.equal(reads(), 0)
  })

  it('an array directly inside an array on a condition path is BUDGET, at the value or through elements', () => {
    const budget = (q: Record<string, unknown>, node: Record<string, unknown>) =>
      assert.throws(() => createSiftTest(q, DEFAULT_LIMITS)(node, exprWork(DEFAULT_LIMITS)), isBudget, JSON.stringify(node))

    budget({ a: 1 }, { a: [1, [2]] })
    budget({ a: { $size: 1 } }, { a: [[1]] })
    budget({ 'a.b': 1 }, { a: [[{ b: 1 }]] })
    budget({ 'a.1': 1 }, { a: [0, [1, [2]]] })
    assert.equal(workOf({ 'a.1': 1 }, { a: [[0], [1, 2]] }), 2, 'a numeric key reads the array itself, not its elements')
    assert.equal(workOf({ b: 1 }, { a: [[1]], b: 1 }), 1, 'an array off every condition path is not walked')
  })

  it('a 3000-value $in over the same array is one Set lookup per element', { timeout: 2_000 }, () => {
    const node = { arr: new Array<number>(100_000).fill(0) }
    const work = exprWork(DEFAULT_LIMITS)

    assert.equal(createSiftTest({ arr: { $in: values(3_000, 1) } }, DEFAULT_LIMITS)(node, work), false)
    assert.equal(work.used, 100_000)
  })

  it('an ordinary where over 1000 small nodes stays far below the limit', () => {
    const test = createSiftTest({ _type: 'task', status: { $in: ['open', 'review'] }, 'meta.tags': 'x' }, DEFAULT_LIMITS)
    const work = exprWork(DEFAULT_LIMITS)

    const matched = values(1_000).filter((i) =>
      test({ _type: 'task', _path: `/t/${i}`, status: i % 2 ? 'open' : 'done', meta: { tags: ['x', 'y'] } }, work))

    assert.equal(matched.length, 500)
    assert.ok(work.used < DEFAULT_LIMITS.exprWork / 1_000, `work ${work.used}`)
  })

  it('the counter belongs to the operation: nodes add up, and the node crossing the limit is refused', () => {
    const limits = { ...DEFAULT_LIMITS, exprWork: 10 }
    const test = createSiftTest({ arr: 1 }, limits)
    const work = exprWork(limits)

    assert.equal(test({ arr: [1, 2, 3, 4, 5, 6] }, work), true)
    assert.throws(() => test({ arr: [1, 2, 3, 4, 5] }, work), isBudget)
    assert.equal(test({ arr: [1, 2, 3, 4, 5] }, exprWork(limits)), true, 'a new operation starts from zero')
  })

  it('a condition weighs its operands times the values at its path', () => {
    assert.equal(workOf({ a: 1 }, { a: 1 }), 1)
    assert.equal(workOf({ a: { $gt: 1, $lt: 5 } }, { a: 3 }), 2)
    assert.equal(workOf({ a: 1 }, { a: [1, 2, 3] }), 3, 'an array gives a value per element')
    assert.equal(workOf({ a: 1 }, { a: [] }), 1, 'an empty array is tested itself')
    assert.equal(workOf({ 'a.b.c': 1 }, { a: [{ b: [{ c: 1 }, { c: [1, 2] }] }, { b: { c: 3 } }] }), 4, 'arrays expand at any level of the path')
    assert.equal(workOf({ 'a.b': 1 }, { a: [{ b: 1 }, { b: [2, 3] }, { c: 4 }] }), 4, 'an element without the path counts 1')
    assert.equal(workOf({ 'a.b': 1 }, {}), 1, 'a missing path counts 1')
    assert.equal(workOf({ 'a.1': 1 }, { a: [[0], [1, 2, 3]] }), 3, 'a numeric key reads the array itself')
  })

  it('$in and $nin weigh 1 whatever their size', () => {
    const node = { a: [1, 2] }
    assert.equal(workOf({ a: { $in: values(500) } }, node), 2)
    assert.equal(workOf({ a: { $nin: values(500) } }, node), 2)
  })

  it('logical operators sum their branches; $elemMatch weighs 1 per value at its path and adds the inner paths', () => {
    const node = { a: 1, b: 2, list: [{ x: 1, y: 1 }, { x: 2 }] }
    assert.equal(workOf({ $or: [{ a: 1 }, { b: 2 }, { a: 2 }] }, node), 3)
    assert.equal(workOf({ list: { $elemMatch: { x: 1, y: 1 } } }, node), 6)
    assert.equal(workOf({ list: { $elemMatch: { x: 1 } }, 'list.x': 2 }, node), 6, 'one walk per path, weights summed')
    for (const q of [{ list: { $elemMatch: {} } }, { list: { $not: { $elemMatch: {} } } }, { list: { $all: [{ $elemMatch: {} }] } }])
      assert.equal(workOf(q, node), 2, JSON.stringify(q))
  })

  it('600 empty $elemMatch conditions over a 100 000-element array are BUDGET before evaluation', () => {
    const { array, reads } = countedArray(100_000)
    const conditions = 600
    const q = { $and: Array.from({ length: conditions }, () => ({ a: { $elemMatch: {} } })) }

    assert.throws(() => createSiftTest(q, DEFAULT_LIMITS)({ a: array }, exprWork(DEFAULT_LIMITS)), isBudget)
    assert.ok(reads() <= DEFAULT_LIMITS.exprWork / conditions + 1, `the walk stops at the budget: ${reads()} element reads`)
  })

  it('the walk reads a path as sift does, through a prototype too', () => {
    const { array, reads } = countedArray(100_000)
    const q = { $or: values(1_000, 1).map((v) => ({ 'a.arr': v })) }

    assert.throws(() => createSiftTest(q, DEFAULT_LIMITS)({ a: Object.create({ arr: array }) }, exprWork(DEFAULT_LIMITS)), isBudget)
    assert.ok(reads() <= DEFAULT_LIMITS.exprWork / 1_000 + 1, `${reads()} element reads`)
  })

  it('the work limit is a parameter', () => {
    const q = { arr: 1 }
    const node = { arr: values(100) }
    assert.doesNotThrow(() => createSiftTest(q, DEFAULT_LIMITS)(node, exprWork(DEFAULT_LIMITS)))
    assert.throws(() => createSiftTest(q, DEFAULT_LIMITS)(node, exprWork({ ...DEFAULT_LIMITS, exprWork: 99 })), isBudget)
  })
})

describe('the kernel $in and $nin', () => {
  const nodes: Record<string, unknown>[] = [
    {}, { a: null }, { a: 1 }, { a: 2 }, { a: '1' }, { a: true }, { a: [] }, { a: [1, 3] }, { a: [3, 4] },
    { a: [null] }, { a: [{ b: 1 }] }, { a: [{ c: 1 }] }, { a: [{ b: [1, 3] }, { b: null }] },
    { a: { b: 1 } }, { a: { b: null } }, { a: 0 }, { a: -0 }, { a: new Date(1) }, { a: [new Date(1), 5] },
  ]
  const operands: unknown[] = [[1], [1, '1'], [null], [true, 0], [3, 4, 5], [1, null], [], 1, null]

  it('matches exactly what sift matches', () => {
    for (const path of ['a', 'a.b'])
      for (const op of ['$in', '$nin'])
        for (const params of operands) {
          const q = { [path]: { [op]: params } }
          const ours = createSiftTest(q, DEFAULT_LIMITS)
          const theirs = sift(q)
          for (const node of nodes) {
            const work: ExprWork = exprWork(DEFAULT_LIMITS)
            assert.equal(ours(node, work), theirs(node), `${JSON.stringify(q)} on ${JSON.stringify(node)}`)
          }
        }
  })
})
