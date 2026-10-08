import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { KernelError } from '#errors'
import { applyDelta, applyUpdateOps, computeDelta } from './update-ops'

const invalid = (error: unknown) => error instanceof KernelError && error.code === 'INVALID'

describe('update operators', () => {
  it('sets dotted fields, removes fields, increments numbers and appends one value', () => {
    const before = { title: 'old', meta: { obsolete: true }, count: 3, log: ['start'] }
    const after = applyUpdateOps(before, {
      $set: { title: 'new', 'meta.by': 'alice' },
      $unset: { 'meta.obsolete': true },
      $inc: { count: -2 },
      $push: { log: ['one', 'two'] },
    })

    assert.deepEqual(after, { title: 'new', meta: { by: 'alice' }, count: 1, log: ['start', ['one', 'two']] })
    assert.deepEqual(before, { title: 'old', meta: { obsolete: true }, count: 3, log: ['start'] })
  })

  it('creates missing parents, counters and arrays; unsetting an absent field is a no-op', () => {
    assert.deepEqual(applyUpdateOps({}, {
      $set: { 'meta.name': 'created' }, $inc: { count: 2 }, $push: { log: 'first' }, $unset: { 'absent.field': true },
    }), { meta: { name: 'created' }, count: 2, log: ['first'] })
  })

  it('a failed increment leaves earlier changes and the input uncommitted', () => {
    const before = { title: 'old', count: 'three' }
    assert.throws(() => applyUpdateOps(before, { $set: { title: 'new' }, $inc: { count: 1 } }), invalid)
    assert.deepEqual(before, { title: 'old', count: 'three' })
  })

  it('increment rejects non-numbers, non-finite operands and overflow', () => {
    for (const count of [null, '3', [], {}, false, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(() => applyUpdateOps({ count }, { $inc: { count: 1 } }), invalid)
    }
    for (const count of [Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(() => applyUpdateOps({ count: 0 }, { $inc: { count } }), invalid)
    }
    assert.throws(() => applyUpdateOps({ count: Number.MAX_VALUE }, { $inc: { count: Number.MAX_VALUE } }), invalid)
  })

  it('push rejects a non-array destination', () => {
    for (const log of [null, 'old', 1, {}]) assert.throws(() => applyUpdateOps({ log }, { $push: { log: 1 } }), invalid)
  })

  it('unset preserves array indices by replacing the element with null', () => {
    assert.deepEqual(applyUpdateOps({ list: ['a', 'b', 'c'] }, { $unset: { 'list.1': true } }), { list: ['a', null, 'c'] })
  })

  it('unsetting a missing field below an absent array element is a no-op', () => {
    assert.deepEqual(applyUpdateOps({ list: [{ name: 'first' }] }, { $unset: { 'list.9.name': true } }), { list: [{ name: 'first' }] })
  })

  it('the result does not alias either the input or written values', () => {
    const before = { meta: { nested: 1 }, log: [] }
    const value = { nested: 2 }
    const after = applyUpdateOps(before, { $set: { extra: value }, $push: { log: value } })
    value.nested = 9
    before.meta.nested = 8

    assert.deepEqual(after, { meta: { nested: 1 }, log: [{ nested: 2 }], extra: { nested: 2 } })
  })

  it('rejects conflicting fields across operators and overlapping dotted paths in either order', () => {
    assert.throws(() => applyUpdateOps({ count: 1 }, { $set: { count: 2 }, $inc: { count: 3 } }), invalid)
    assert.throws(() => applyUpdateOps({}, { $set: { meta: {}, 'meta.name': 'x' } }), invalid)
    assert.throws(() => applyUpdateOps({}, { $set: { 'meta.name': 'x', meta: {} } }), invalid)
  })

  it('rejects unsafe paths before changing any field', () => {
    for (const path of ['', '.a', 'a.', 'a..b', 'a\0b', '__proto__.polluted', 'a.constructor.name', 'a.prototype.x']) {
      const before = { title: 'old' }
      assert.throws(() => applyUpdateOps(before, { $set: { title: 'new', [path]: 1 } }), invalid)
      assert.deepEqual(before, { title: 'old' })
    }
    assert.equal(Object.hasOwn(Object.prototype, 'polluted'), false)
  })

  it('rejects prototype keys inside written values and arrays', () => {
    const unsafe = JSON.parse('{"nested":{"__proto__":{"polluted":true}}}')
    assert.throws(() => applyUpdateOps({}, { $set: { value: unsafe } }), invalid)
    assert.throws(() => applyUpdateOps({}, { $push: { log: [unsafe] } }), invalid)
    assert.equal(Object.hasOwn(Object.prototype, 'polluted'), false)
  })

  it('array writes cannot create sparse arrays or use alternative index spellings', () => {
    for (const path of ['list.99999999', 'list.-1', 'list.1.5', 'list.foo', 'list.length', 'list.01', 'list.1e0']) {
      assert.throws(() => applyUpdateOps({ list: ['a'] }, { $set: { [path]: 'bad' } }), invalid)
    }
    assert.deepEqual(applyUpdateOps({ list: ['a'] }, { $set: { 'list.1': 'b' } }), { list: ['a', 'b'] })
  })
})

describe('field deltas', () => {
  it('changes only the differing fields, with no parent/child overlap', () => {
    const before = { meta: { stable: true, name: 'old', obsolete: 1 }, count: 1 }
    const after = { meta: { stable: true, name: 'new' }, count: 2 }
    const delta = computeDelta(before, after)

    assert.deepEqual(delta, { set: { 'meta.name': 'new', count: 2 }, unset: ['meta.obsolete'] })
    assert.deepEqual(applyDelta(before, delta), after)
    assert.equal(before.meta.name, 'old')
  })

  it('equal JSON content produces an empty delta regardless of object key order', () => {
    assert.deepEqual(computeDelta({ a: { x: 1, y: 2 }, list: [1, { x: 2 }] }, { list: [1, { x: 2 }], a: { y: 2, x: 1 } }), {})
  })

  it('an unchanged literal JSON key does not replace otherwise addressable fields', () => {
    const before = { 'literal.key': { stable: true }, count: 1 }
    const after = { 'literal.key': { stable: true }, count: 2 }
    assert.deepEqual(computeDelta(before, after), { set: { count: 2 } })
    assert.deepEqual(applyDelta(before, computeDelta(before, after)), after)
  })

  it('round trips added and removed objects, arrays, nulls and changed value types', () => {
    const images: Record<string, unknown>[] = [
      {}, { a: 1 }, { a: null }, { a: { b: 1, c: 2 } }, { a: { b: { c: 2 } } },
      { a: [1, 2, 3] }, { a: [3] }, { a: [] }, { a: { 'literal.key': 1 } },
      { 'literal.key': 2 }, { '': { field: 3 } },
    ]
    for (const before of images) for (const after of images) {
      assert.deepEqual(applyDelta(before, computeDelta(before, after)), after)
    }
  })

  it('arrays change as one field so removals never shift another delta path', () => {
    const before = { list: ['a', 'b', 'c'], stable: 1 }
    const after = { list: ['c'], stable: 1 }
    assert.deepEqual(computeDelta(before, after), { set: { list: ['c'] } })
    assert.deepEqual(applyDelta(before, computeDelta(before, after)), after)
  })

  it('delta values do not alias the after-image or the applied result', () => {
    const after = { list: [{ value: 1 }] }
    const delta = computeDelta({}, after)
    const applied = applyDelta({}, delta)
    after.list[0].value = 9

    assert.deepEqual(delta, { set: { list: [{ value: 1 }] } })
    assert.deepEqual(applied, { list: [{ value: 1 }] })
  })

  it('rejects parent/child overlap and duplicates across set/unset', () => {
    for (const delta of [
      { set: { a: {}, 'a.b': 1 } }, { set: { 'a.b': 1, a: {} } },
      { set: { a: 1 }, unset: ['a'] }, { unset: ['a.b', 'a'] }, { unset: ['a', 'a'] },
      { set: { '': {}, a: 1 } }, { set: { a: 1, '': {} } },
    ]) assert.throws(() => applyDelta({}, delta), invalid)
  })

  it('rejects unsafe paths and prototype keys in the delta payload', () => {
    assert.throws(() => applyDelta({}, { set: { '__proto__.polluted': 1 } }), invalid)
    assert.throws(() => applyDelta({}, { unset: ['constructor.x'] }), invalid)
    assert.throws(() => applyDelta({}, { set: { value: JSON.parse('{"prototype":{}}') } }), invalid)
    assert.throws(() => applyDelta({}, { unset: [''] }), invalid)
    assert.equal(Object.hasOwn(Object.prototype, 'polluted'), false)
  })

  it('can replace an invalid before-image with safe JSON without traversing its prototype key', () => {
    const before = JSON.parse('{"__proto__":{"polluted":true}}')
    const after = { repaired: true }
    assert.deepEqual(applyDelta(before, computeDelta(before, after)), after)
    assert.equal(Object.hasOwn(Object.prototype, 'polluted'), false)
  })
})
