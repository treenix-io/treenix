import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { KernelError } from '#errors'
import { assertPost } from './post'

const isInvalid = (e: unknown) => e instanceof KernelError && e.code === 'INVALID'

const invalid = (post: unknown) => assert.throws(() => assertPost(post), isInvalid, JSON.stringify(post))

describe('assertPost', () => {
  it('accepts the four operators on the own node and on needs targets', () => {
    const post = {
      '': { $set: { status: 'done', 'meta.by': 'x' }, $inc: { count: 1 }, $unset: { draft: true }, $push: { log: { at: 1 } } },
      stock: { $inc: { qty: -2 } },
    }

    assert.doesNotThrow(() => assertPost(post))
  })

  it('a post that changes nothing is a post', () => {
    assert.doesNotThrow(() => assertPost({}))
    assert.doesNotThrow(() => assertPost({ '': {} }))
  })

  it('a post or a target that is not an object of operators is INVALID', () => {
    for (const post of [null, 'count', ['count'], { '': ['count'] }, { '': 'count' }]) invalid(post)
  })

  it('an operator outside $set, $unset, $inc and $push is INVALID', () => {
    invalid({ '': { $rename: { a: 'b' } } })
    invalid({ '': { $where: { a: 1 } } })
    invalid({ '': { status: 'done' } })
  })

  it('an operator without fields is INVALID', () => {
    invalid({ '': { $set: {} } })
    invalid({ '': { $set: 'status' } })
  })

  it('$unset takes true and $inc a finite number', () => {
    invalid({ '': { $unset: { draft: 1 } } })
    for (const by of ['1', Number.NaN, Number.POSITIVE_INFINITY, null]) invalid({ '': { $inc: { count: by } } })
  })

  it('an empty segment or a prototype key in a field or target is INVALID', () => {
    for (const field of ['', 'a..b', '.a', 'a.', 'a.__proto__.b', 'constructor']) invalid({ '': { $set: { [field]: 1 } } })
    invalid(JSON.parse('{"__proto__": {"$set": {"a": 1}}}'))
  })

  it('a field touched twice, or with a field inside it, is INVALID in one target and fine across targets', () => {
    invalid({ '': { $set: { count: 0 }, $inc: { count: 1 } } })
    invalid({ '': { $set: { meta: {} }, $unset: { 'meta.by': true } } })
    invalid({ '': { $unset: { 'meta.by': true }, $set: { meta: {} } } })

    assert.doesNotThrow(() => assertPost({ '': { $set: { meta: {}, metadata: 1, 'meta-x.by': 2 } } }))
    assert.doesNotThrow(() => assertPost({ '': { $inc: { count: 1 } }, stock: { $inc: { count: 1 } } }))
  })
})
