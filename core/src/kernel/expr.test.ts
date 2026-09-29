import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import sift from 'sift'

import { KernelError } from '#errors'
import { assertSafeSiftQuery, createSiftTest } from './expr'
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
      { name: { $in: [{ $gt: 1 }] } },
    ]
    for (const q of invalid)
      assert.throws(() => createSiftTest(q, DEFAULT_LIMITS), isInvalid, JSON.stringify(q))
  })
})

describe('expression work', () => {
  it('a 1000-branch $or over a 100 000-element array is refused with BUDGET before evaluation', () => {
    const { array, reads } = countedArray(100_000)
    const q = { $or: values(1_000, 1).map((v) => ({ arr: v })) }
    const test = createSiftTest(q, DEFAULT_LIMITS)

    assert.throws(() => test({ arr: array }, exprWork(DEFAULT_LIMITS)), isBudget)
    assert.ok(reads() <= 100_000, `the node is counted in one walk and never tested: ${reads()} element reads`)
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
    assert.equal(workOf({ a: 1 }, { a: [[1, 2], [3, [4, 5]]] }), 5, 'nested arrays expand at any level')
    assert.equal(workOf({ 'a.b': 1 }, { a: [{ b: 1 }, { b: [2, 3] }, { c: 4 }] }), 4, 'an element without the path counts 1')
    assert.equal(workOf({ 'a.b': 1 }, {}), 1, 'a missing path counts 1')
    assert.equal(workOf({ 'a.1': 1 }, { a: [[0], [1, 2, 3]] }), 3, 'a numeric key reads the array itself')
  })

  it('$in and $nin over primitives weigh 1; over objects, their values', () => {
    const node = { a: [1, 2] }
    assert.equal(workOf({ a: { $in: values(500) } }, node), 2)
    assert.equal(workOf({ a: { $nin: values(500) } }, node), 2)
    assert.equal(workOf({ a: { $in: [{ x: 1 }, { y: 2 }] } }, node), 8)
  })

  it('logical operators sum their branches; $elemMatch adds the inner path to the outer one', () => {
    const node = { a: 1, b: 2, list: [{ x: 1, y: 1 }, { x: 2 }] }
    assert.equal(workOf({ $or: [{ a: 1 }, { b: 2 }, { a: 2 }] }, node), 3)
    assert.equal(workOf({ list: { $elemMatch: { x: 1, y: 1 } } }, node), 4)
    assert.equal(workOf({ list: { $elemMatch: { x: 1 } }, 'list.x': 2 }, node), 4, 'one walk per path, weights summed')
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
    { a: [[1], 3] }, { a: [null] }, { a: [{ b: 1 }] }, { a: [{ c: 1 }] }, { a: [{ b: [1, 3] }, { b: null }] },
    { a: { b: 1 } }, { a: { b: null } }, { a: 0 }, { a: -0 }, { a: new Date(1) },
  ]
  const operands: unknown[] = [
    [1], [1, '1'], [null], [true, 0], [3, 4, 5], [1, null], [], 1,
    [[1, 3]], [{ b: 1 }, 2], [[{ b: 1 }]], [new Date(1)],
  ]

  it('matches exactly what sift matches, primitive operands or not', () => {
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
