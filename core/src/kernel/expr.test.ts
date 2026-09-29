import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { KernelError } from '#errors'
import { assertSafeSiftQuery, createSiftTest, estimateCost } from './expr'
import { DEFAULT_LIMITS } from './types'

const isBudget = (e: unknown) => e instanceof KernelError && e.code === 'BUDGET'
const isInvalid = (e: unknown) => e instanceof KernelError && e.code === 'INVALID'

const values = (n: number) => Array.from({ length: n }, (_, i) => i)

describe('expression limits', () => {
  it('$in, $nin and $all weigh their number of values', () => {
    for (const op of ['$in', '$nin', '$all'])
      assert.ok(estimateCost({ tag: { [op]: values(5_000) } }) >= 5_000, op)

    assert.ok(estimateCost({ tag: { $in: values(10) } }) < estimateCost({ tag: { $in: values(100) } }))
  })

  it('every branch of a logical operator is counted', () => {
    const branch = { tag: { $in: values(10) } }
    assert.ok(estimateCost({ $or: [branch, branch, branch] }) >= 3 * estimateCost(branch))
  })

  it('an $in with a million values is refused with BUDGET before a tester exists', () => {
    const q = { tag: { $in: values(1_000_000) } }
    const sizeUnbounded = { ...DEFAULT_LIMITS, exprBytes: Number.MAX_SAFE_INTEGER }

    assert.throws(() => assertSafeSiftQuery(q), isBudget)
    assert.throws(() => createSiftTest(q), isBudget)
    assert.throws(() => createSiftTest(q, sizeUnbounded), isBudget, 'the cost estimate alone refuses it')
  })

  it('a 17 KiB expression is refused with BUDGET before a tester exists', () => {
    const q = { name: 'x'.repeat(17 * 1024) }
    assert.ok(estimateCost(q) <= DEFAULT_LIMITS.exprCost)

    assert.throws(() => assertSafeSiftQuery(q), isBudget)
    assert.throws(() => createSiftTest(q), isBudget)
  })

  it('size is counted in UTF-8 bytes, not characters', () => {
    const q = { name: 'я'.repeat(9 * 1024) }
    assert.throws(() => createSiftTest(q), isBudget)
  })

  it('an expression within both limits compiles and evaluates on storage-shaped nodes', () => {
    const test = createSiftTest({ $type: 'item', tag: { $in: values(1_000) } })
    assert.equal(test({ _type: 'item', tag: 999 }), true)
    assert.equal(test({ _type: 'item', tag: 1_000 }), false)
  })

  it('the limits are a parameter: lowered limits refuse what the defaults admit', () => {
    const q = { tag: { $in: values(100) } }
    assert.doesNotThrow(() => assertSafeSiftQuery(q))
    assert.throws(() => assertSafeSiftQuery(q, { ...DEFAULT_LIMITS, exprCost: 50 }), isBudget)
    assert.throws(() => assertSafeSiftQuery(q, { ...DEFAULT_LIMITS, exprBytes: 64 }), isBudget)
  })

  it('code and regex operators stay INVALID on the compile path', () => {
    for (const q of [{ $where: 'true' }, { name: { $regex: 'x' } }, { name: /x/ }])
      assert.throws(() => createSiftTest(q), isInvalid, String(Object.keys(q)))
  })
})
