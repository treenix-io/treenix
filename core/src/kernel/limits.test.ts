import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { KernelError } from '#errors'
import { readLimits } from './limits'
import { DEFAULT_LIMITS, type Node } from './types'

const isInvalid = (e: unknown) => e instanceof KernelError && e.code === 'INVALID'

const limitsNode = (fields: Record<string, unknown>): Node =>
  ({ $path: '/sys/limits', $id: 'limits', $type: 'limits', $rev: '1', ...fields })

describe('readLimits', () => {
  it('a node without limit fields yields DEFAULT_LIMITS', () => {
    assert.deepEqual(readLimits(limitsNode({})), DEFAULT_LIMITS)
  })

  it('present fields override their defaults, absent ones keep them', () => {
    const limits = readLimits(limitsNode({ readNodes: 500, exprWork: 0, actionDepth: 2 }))

    assert.deepEqual(limits, { ...DEFAULT_LIMITS, readNodes: 500, exprWork: 0, actionDepth: 2 })
  })

  it('the expression work and nested-call depth defaults are the spec parameters', () => {
    assert.equal(DEFAULT_LIMITS.exprWork, 10_000_000)
    assert.equal(DEFAULT_LIMITS.actionDepth, 8)
  })

  it('system fields and named components are not limits', () => {
    const node = limitsNode({ $acl: [], $owner: 'u:admin', $order: 'V', '#note': { $type: 'note', text: 'raised for import' } })
    assert.deepEqual(readLimits(node), DEFAULT_LIMITS)
  })

  it('an unknown field is INVALID', () => {
    assert.throws(() => readLimits(limitsNode({ readNode: 500 })), isInvalid)
  })

  it('the static expression cost is no longer a limit', () => {
    assert.equal(Object.hasOwn(DEFAULT_LIMITS, 'exprCost'), false)
    assert.throws(() => readLimits(limitsNode({ exprCost: 10_000 })), isInvalid)
  })

  it('a negative, non-finite or non-numeric value is INVALID', () => {
    for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY, '100', null, true])
      assert.throws(() => readLimits(limitsNode({ nodeBytes: value })), isInvalid, String(value))
  })

  it('DEFAULT_LIMITS stays untouched by an overlay', () => {
    const before = { ...DEFAULT_LIMITS }
    readLimits(limitsNode({ changeSet: 5 }))
    assert.deepEqual(DEFAULT_LIMITS, before)
  })
})
