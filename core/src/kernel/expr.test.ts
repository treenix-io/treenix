import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { KernelError } from '#errors'
import { exprWork } from './eval'
import { assertSafePredicate, assertSafeSiftQuery, createSiftTest } from './expr'
import { DEFAULT_LIMITS } from './types'

const isBudget = (e: unknown) => e instanceof KernelError && e.code === 'BUDGET'
const isInvalid = (e: unknown) => e instanceof KernelError && e.code === 'INVALID'

const values = (n: number, from = 0) => Array.from({ length: n }, (_, i) => i + from)

// An array whose element reads are counted, to see what a test reads before it stops.
function countedArray<T>(items: T[]): { array: T[]; reads: () => number } {
  let reads = 0
  const array = new Proxy(items, {
    get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) reads++
      return Reflect.get(target, key, receiver)
    },
  })
  return { array, reads: () => reads }
}

const zeros = (n: number) => new Array<number>(n).fill(0)

function outcome(q: Record<string, unknown>, node: Record<string, unknown>) {
  const work = exprWork(DEFAULT_LIMITS)
  const result = createSiftTest(q, DEFAULT_LIMITS)(node, work)
  return { result, used: work.used }
}

const budget = (q: Record<string, unknown>, node: Record<string, unknown>) =>
  assert.throws(() => createSiftTest(q, DEFAULT_LIMITS)(node, exprWork(DEFAULT_LIMITS)), isBudget)

const invalid = (q: Record<string, unknown>) => {
  assert.throws(() => createSiftTest(q, DEFAULT_LIMITS), isInvalid, JSON.stringify(q)?.slice(0, 100))
  assert.throws(() => assertSafeSiftQuery(q, DEFAULT_LIMITS), isInvalid, JSON.stringify(q)?.slice(0, 100))
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
})

describe('expression language', () => {
  it('code and regex operators stay INVALID on the compile path', () => {
    for (const q of [{ $where: 'true' }, { name: { $regex: 'x' } }, { name: /x/ }]) invalid(q)
  })

  it('an operator outside the language, or operators mixed with fields, is INVALID at compile', () => {
    const shapes = [
      { name: { $text: 'x' } }, { $comment: 'x' }, { name: { $gt: 1, sub: 2 } }, { name: { sub: 2, $gt: 1 } },
      { $or: [] }, { $and: {} }, { $or: [1] }, { $or: [[{ a: 1 }]] }, { name: { $mod: [2, 0] } }, { name: { $options: 'i' } },
      { name: { $elemMatch: 1 } }, { name: { $elemMatch: [] } }, { name: { $type: 'string' } },
    ]
    for (const q of shapes) invalid(q)
  })

  it('a compound, NaN or non-JSON operand is INVALID at compile', () => {
    const shapes: Record<string, unknown>[] = [
      { a: { x: 1 } }, { a: {} }, { a: [1] }, { a: Number.NaN }, { a: undefined }, { a: new Date(1) }, { a: { $eq: { x: 1 } } },
      { a: { $ne: [1] } }, { a: { $gt: {} } }, { a: { $in: [{ x: 1 }] } }, { a: { $nin: [[1]] } }, { a: { $all: [[1]] } },
      { a: { $all: [{ b: 1 }] } }, { $or: [{ a: 1 }, { b: { c: 1 } }] }, { list: { $elemMatch: { x: [1] } } },
    ]
    for (const q of shapes) invalid(q)
  })

  it('operands take the shapes Mongo takes: $in and $nin an array, $size a non-negative integer, $exists a boolean', () => {
    const shapes = [
      { a: { $in: 1 } }, { a: { $in: null } }, { a: { $nin: 'x' } }, { a: { $size: -1 } }, { a: { $size: 1.5 } },
      { a: { $size: '1' } }, { a: { $exists: 1 } }, { a: { $exists: 'yes' } }, { a: { $all: 1 } },
    ]
    for (const q of shapes) invalid(q)
  })

  it('$not holds operators on the value, $all items are all primitives or all $elemMatch, groups stand where Mongo takes them', () => {
    const shapes: Record<string, unknown>[] = [
      { a: { $not: 1 } }, { a: { $not: {} } }, { a: { $not: { b: 1 } } }, { a: { $not: { $or: [{ $gt: 1 }] } } },
      { a: { $all: [1, { $elemMatch: { b: 1 } }] } }, { a: { $all: [{ $elemMatch: { b: 1 } }, 1] } },
      { a: { $all: [{ $elemMatch: { b: 1 }, $gt: 1 }] } }, { a: { $all: [{ $gt: 1 }] } },
      { a: { $or: [{ $gt: 1 }] } }, { a: { $and: [{ $gt: 1 }] } }, { a: { $nor: [{ $gt: 1 }] } },
      { $exists: true }, { $or: [{ $gt: 1 }] }, { $not: { $gt: 1 } }, { $elemMatch: { a: 1 } },
      { list: { $elemMatch: { $gt: 1, b: 1 } } }, { list: { $elemMatch: { b: 1, $gt: 1 } } },
      { list: { $elemMatch: { $or: [{ x: 1 }, { $gt: 2 }] } } }, { list: { $elemMatch: { $gt: 1, $or: [{ x: 1 }] } } },
    ]
    for (const q of shapes) invalid(q)
  })

  it('what Mongo takes and the language keeps compiles', () => {
    const shapes: Record<string, unknown>[] = [
      { a: 'x', b: 1, c: true, d: null, e: -0, f: Infinity }, { a: { $in: ['x', 1, null], $nin: [false] } },
      { a: { $in: [], $nin: [] } }, { a: { $all: [] } }, { a: { $all: [1, 'x'] } },
      { list: { $all: [{ $elemMatch: { x: 1, y: { $all: [2] } } }, { $elemMatch: { $gt: 1 } }] } },
      { a: { $not: { $gt: 1, $lt: 5, $in: [7], $size: 2, $exists: true, $ne: 3, $nin: [1], $all: [1] } } },
      { a: { $not: { $not: { $elemMatch: { $gt: 1 } } } } }, { list: { $not: { $elemMatch: { x: { $not: { $eq: 1 } } } } } },
      { list: { $elemMatch: { x: 1, 'y.z': { $exists: true } } } }, { list: { $elemMatch: { $or: [{ x: 1 }, { y: 2 }], z: 3 } } },
      { list: { $elemMatch: { $elemMatch: { $gt: 1 } } } }, { list: { $elemMatch: {} } }, { list: { $elemMatch: { $not: { $gt: 1 } } } },
      { a: { $size: 2 } }, { $nor: [{ a: 1 }], $and: [{ b: { $lte: 3 } }], $or: [{ c: 1 }] }, { 'a.0.b.1': 1 }, { 'a.$b': 1 }, {},
    ]
    for (const q of shapes) {
      assert.doesNotThrow(() => createSiftTest(q, DEFAULT_LIMITS), JSON.stringify(q))
      assert.doesNotThrow(() => assertSafeSiftQuery(q, DEFAULT_LIMITS), JSON.stringify(q))
    }
  })

  it('a path with an empty segment is INVALID', () => {
    for (const q of [{ '': 1 }, { 'a.': 1 }, { '.a': 1 }, { 'a..b': 1 }]) invalid(q)
  })

  it('an expression nested deeper than 200 objects and arrays is INVALID whatever its size, and 200 compile', () => {
    type Q = Record<string, unknown>
    const nots = (n: number) => {
      let q: Q = { $gt: 1 }
      for (let i = 0; i < n; i++) q = { $not: q }
      return { a: q }
    }
    const ands = (n: number) => {
      let q: Q = { a: 1 }
      for (let i = 0; i < n; i++) q = { $and: [q] }
      return q
    }
    let operand: unknown = 1
    for (let i = 0; i < 5_000; i++) operand = [operand]

    invalid(nots(199))
    invalid(ands(100))
    invalid({ a: { $in: [operand] } })
    assert.doesNotThrow(() => createSiftTest(nots(198), DEFAULT_LIMITS))
    assert.doesNotThrow(() => createSiftTest(ands(99), DEFAULT_LIMITS))
  })

  it('a prototype key anywhere in a query is INVALID, a decoded __proto__ included, whoever runs the query', () => {
    const decoded = (key: string) => JSON.parse(`{"list":{"$elemMatch":{"${key}":{"$or":[{"$eq":1}]}}}}`)
    const shapes: Record<string, unknown>[] = [
      decoded('__proto__'), decoded('constructor'), decoded('prototype'), JSON.parse('{"__proto__":{"a":1}}'),
      { 'a.__proto__.b': 1 }, { 'a.constructor': 1 }, { prototype: 1 }, { constructor: { $exists: false } },
      { a: { $elemMatch: { constructor: 1 } } },
    ]
    for (const q of shapes) {
      invalid(q)
      assert.throws(() => assertSafePredicate(q, DEFAULT_LIMITS, 'callerWhere'), isInvalid, Object.keys(q).join())
    }
  })

  it('an own constructor key does not carry a hidden field past the read predicate check', () => {
    const q = { constructor: { $exists: false }, _acl: { $exists: true } }

    assert.throws(() => assertSafePredicate(q, DEFAULT_LIMITS, 'callerWhere'), isInvalid)
    assert.throws(() => assertSafePredicate({ $or: [q] }, DEFAULT_LIMITS, 'callerWhere'), isInvalid)
  })
})

describe('expression work', () => {
  it('the counter is charged as the test reads: a match stops early, a miss reads every element', () => {
    const { array, reads } = countedArray([1, ...zeros(99_999)])

    const hit = outcome({ arr: 1 }, { arr: array })
    assert.equal(hit.result, true)
    assert.equal(reads(), 1)
    assert.ok(hit.used < 10, `work ${hit.used}`)

    const miss = outcome({ arr: 2 }, { arr: array })
    assert.equal(miss.result, false)
    assert.ok(miss.used >= 100_000 && miss.used < 100_010, `work ${miss.used}`)
  })

  it('a test stops the moment the counter passes the limit: it has read no more than the limit allows', () => {
    const { array, reads } = countedArray(zeros(100_000))
    const limits = { ...DEFAULT_LIMITS, exprWork: 1_000_000 }
    const q = { $or: values(1_000, 1).map((v) => ({ arr: v })) }

    assert.throws(() => createSiftTest(q, limits)({ arr: array }, exprWork(limits)), isBudget)
    assert.ok(reads() <= limits.exprWork, `${reads()} element reads`)
    assert.ok(reads() >= limits.exprWork / 2, `${reads()} element reads`)
  })

  it('the counter belongs to the operation: nodes add up, and the node crossing the limit is refused', () => {
    const limits = { ...DEFAULT_LIMITS, exprWork: 30 }
    const test = createSiftTest({ arr: 9 }, limits)
    const work = exprWork(limits)

    assert.equal(test({ arr: [1, 2, 3, 4, 5] }, work), false)
    assert.equal(test({ arr: [1, 2, 3, 4, 5] }, work), false)
    assert.throws(() => test({ arr: values(20, 10) }, work), isBudget)
    assert.equal(test({ arr: values(20, 10) }, exprWork(limits)), false, 'a new operation starts from zero')
  })

  it('every step counts: a field read, an array element visited, a value tested', () => {
    const one = outcome({ 'a.b': -1 }, { a: { b: 1 } }).used
    const deeper = outcome({ 'a.b.c.d': -1 }, { a: { b: { c: { d: 1 } } } }).used
    const elements = outcome({ 'a.b': -1 }, { a: values(1_000).map((b) => ({ b })) }).used

    assert.ok(deeper >= one + 2, 'each field of a path is a step')
    assert.ok(elements >= 2_000, 'each element and each field read in it is a step')
  })

  it('$in and $nin look a value up in a set: the work does not grow with the list', () => {
    const node = { a: values(1_000) }
    const short = outcome({ a: { $in: [-1] } }, node).used

    assert.equal(outcome({ a: { $in: values(3_000, 5_000) } }, node).used, short)
    assert.equal(outcome({ a: { $nin: values(3_000, 5_000) } }, node).used, outcome({ a: { $nin: [-1] } }, node).used)
  })

  it('a string compared unit by unit, in code point order, is charged for the units it walks', () => {
    const prefix = '😀' + 'x'.repeat(800)
    const walked = outcome({ s: { $gt: prefix + 'b' } }, { s: prefix + 'a' })

    assert.equal(walked.result, false)
    assert.ok(walked.used >= prefix.length / 8, `work ${walked.used}`)
  })

  it('an ordinary where over 1000 small nodes stays far below the limit', () => {
    const test = createSiftTest({ _type: 'task', status: { $in: ['open', 'review'] }, 'meta.tags': 'x' }, DEFAULT_LIMITS)
    const work = exprWork(DEFAULT_LIMITS)

    const matched = values(1_000).filter((i) =>
      test({ _type: 'task', _path: `/t/${i}`, status: i % 2 ? 'open' : 'done', meta: { tags: ['x', 'y'] } }, work))

    assert.equal(matched.length, 500)
    assert.ok(work.used < DEFAULT_LIMITS.exprWork / 1_000, `work ${work.used}`)
  })

  it('the work limit is a parameter', () => {
    const q = { arr: -1 }
    const node = { arr: values(100) }
    assert.doesNotThrow(() => createSiftTest(q, DEFAULT_LIMITS)(node, exprWork(DEFAULT_LIMITS)))
    assert.throws(() => createSiftTest(q, DEFAULT_LIMITS)(node, exprWork({ ...DEFAULT_LIMITS, exprWork: 99 })), isBudget)
  })

  it('chains of negations and empty $all are counted per level, not free', () => {
    let chain: Record<string, unknown> = { $all: [] }
    for (let i = 0; i < 150; i++) chain = { $not: chain }

    assert.ok(outcome({ a: chain }, { a: 1 }).used >= 150)
  })
})

// Shapes built to outrun the work bound: each is refused with BUDGET or answered fast.
describe('expression work: adversarial shapes', () => {
  const fast = { timeout: 2_000 }

  it('a 3000-value $in over 100 000 elements is one set lookup per element', fast, () => {
    const { result, used } = outcome({ arr: { $in: values(3_000, 1) } }, { arr: zeros(100_000) })

    assert.equal(result, false)
    assert.ok(used < 100_010, `work ${used}`)
  })

  it('a 1000-branch $or over 100 000 elements is BUDGET', fast, () => {
    budget({ $or: values(1_000, 1).map((v) => ({ arr: v })) }, { arr: zeros(100_000) })
  })

  it('100 000 strings sharing a 4000-unit prefix with a code-point operand are BUDGET', fast, () => {
    const prefix = '😀' + 'x'.repeat(4_000)

    budget({ s: { $gt: prefix + 'b' } }, { s: new Array<string>(100_000).fill(prefix + 'a') })
  })

  it('an object-literal $in over a 12 000-key object is INVALID before any node is tested', fast, () => {
    invalid({ a: { $in: [{ k0: 0 }] } })
  })

  it('1024 nested single-element arrays around 100 000 zeros are one level deep to a condition: a fast answer, no inner reads', fast, () => {
    const { array, reads } = countedArray(zeros(100_000))
    let nested: unknown = array
    for (let i = 0; i < 1_024; i++) nested = [nested]

    assert.equal(outcome({ a: 0 }, { a: nested }).result, false)
    assert.equal(outcome({ a: { $size: 1 } }, { a: nested }).result, true)
    assert.equal(reads(), 0)
  })

  it('$elemMatch with "0" and "length" keys, and its $not and $all forms, charge every element they read', fast, () => {
    for (const key of ['0', 'length']) {
      const rows = values(10).map(() => countedArray(zeros(10_000)))
      const node = { a: rows.map(({ array }) => ({ [key]: array })) }
      const inner = { [key]: { $all: values(3_000, 1).map(() => 0).concat([1]) } }

      for (const q of [{ a: { $elemMatch: inner } }, { a: { $not: { $elemMatch: inner } } }, { a: { $all: [{ $elemMatch: inner }] } }]) {
        const work = exprWork(DEFAULT_LIMITS)
        const before = rows.reduce((sum, row) => sum + row.reads(), 0)
        let result: boolean | 'BUDGET'
        try {
          result = createSiftTest(q, DEFAULT_LIMITS)(node, work)
        } catch (e) {
          if (!isBudget(e)) throw e
          result = 'BUDGET'
        }
        const read = rows.reduce((sum, row) => sum + row.reads(), 0) - before

        assert.ok(result === 'BUDGET' || typeof result === 'boolean')
        assert.ok(read <= work.used, `${key}: ${read} element reads, work ${work.used}`)
      }
    }
  })

  it('1400 paths a.0…a.1399 over 80 000 empty objects: their conjunction answers fast, their disjunction is BUDGET', fast, () => {
    const conjunction: Record<string, unknown> = { 'a.b': 1 }
    for (let i = 0; i < 1_400; i++) conjunction[`a.${i}`] = 1
    const node = { a: Array.from({ length: 80_000 }, () => ({})) }

    assert.equal(outcome(conjunction, node).result, false)
    budget({ $or: values(1_000).map((i) => ({ [`a.${i}`]: 1 })) }, node)
  })

  it('600 empty $elemMatch conditions over 100 000 elements: all of them answer fast, any of them is BUDGET', fast, () => {
    const conditions = Array.from({ length: 600 }, () => ({ a: { $elemMatch: {} } }))

    assert.equal(outcome({ $and: conditions }, { a: zeros(100_000) }).result, false)
    budget({ $or: conditions }, { a: zeros(100_000) })
  })

  it('a path reads own fields only: an inherited array and a __proto__ field are never read', fast, () => {
    const { array, reads } = countedArray(zeros(100_000))
    const q = { $or: values(1_000, 1).map((v) => ({ 'a.arr': v })) }
    const proto = JSON.parse(`{"__proto__":{"arr":[0]}}`)

    assert.equal(outcome(q, { a: Object.create({ arr: array }) }).result, false)
    assert.equal(outcome({ arr: 0 }, proto).result, false)
    assert.equal(reads(), 0)
  })

  it('$not chains run once per level; $all and $not over nested fields are INVALID', fast, () => {
    let not: Record<string, unknown> = { $gt: 1 }
    for (let i = 0; i < 180; i++) not = { $not: not }
    let notFields: Record<string, unknown> = { a: 1 }
    let allFields: Record<string, unknown> = { a: 1 }
    let allChain: Record<string, unknown> = { $gt: 1 }
    for (let i = 0; i < 22; i++) {
      notFields = { a: { $not: notFields } }
      allFields = { a: { $all: [allFields] } }
      allChain = { $all: [allChain] }
    }

    assert.ok(outcome({ a: not }, { a: zeros(10_000) }).used < 11_000)
    for (const q of [notFields, allFields, { a: allChain }]) invalid(q)
  })

  it('a path of 8000 segments over data as deep answers without deepening the call stack', fast, () => {
    const path = values(8_000).map(() => 'a').join('.')
    let data: unknown = 1
    for (let i = 0; i < 7_999; i++) data = [{ a: data }]

    assert.equal(outcome({ [path]: 1 }, { a: data }).result, true)
  })
})
