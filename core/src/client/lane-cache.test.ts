import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { KernelError } from '#errors'
import { createLaneCache } from '#client/lane-cache'
import type { Frame, NodeCopy } from '#kernel/types'

const pos = (seq: number) => ({ instance: 'client', epoch: 1, seq })
const copy = (count: number): NodeCopy => ({ node: { $path: '/counter', $id: 'counter', $type: 'counter', $rev: String(count), count }, bits: 7, ver: String(count) })
const snapshot = (sub = 'one', gen = 1): Frame => ({ t: 'snap', sub, gen, list: ['counter'], copies: [copy(0)], at: [pos(0)] })
const code = (expected: KernelError['code']) => (error: unknown) => error instanceof KernelError && error.code === expected

describe('native lane cache', () => {
  it('applies a patch once and rejects an ordinary duplicate position', () => {
    const cache = createLaneCache()
    cache.apply(snapshot())
    const frame: Frame = { t: 'pos', pos: pos(1), changes: [{ op: 'patch', id: 'counter', base: '0', ver: '1', bits: 7,
      delta: { set: { count: 1, $rev: '1' } } }] }
    cache.apply(frame)
    assert.deepEqual(cache.at('/counter'), copy(1))
    assert.throws(() => cache.apply(frame), code('INVALID'))
  })

  it('releases coverage at the delivered watermark without advancing completion', () => {
    const cache = createLaneCache()
    cache.apply(snapshot())
    cache.apply({ t: 'pos', pos: pos(0), coverage: true, changes: [{ op: 'del', id: 'counter' }] })
    assert.equal(cache.at('/counter'), undefined)
    assert.deepEqual(cache.watermark('client'), pos(0))
    assert.throws(() => cache.apply({ t: 'pos', pos: pos(1), coverage: true, changes: [] }), code('INVALID'))
  })

  it('refuses the whole frame when a patch has an unknown base', () => {
    const cache = createLaneCache()
    cache.apply(snapshot())
    assert.throws(() => cache.apply({ t: 'pos', pos: pos(1), changes: [{ op: 'del', id: 'counter' },
      { op: 'patch', id: 'counter', base: 'other', delta: { set: { count: 2 } }, ver: '2', bits: 7 }] }), code('CONFLICT'))
    assert.deepEqual(cache.at('/counter'), copy(0))
    assert.deepEqual(cache.watermark('client'), pos(0))
  })

  it('drops stale generations and keeps membership separate from shared copies', () => {
    const cache = createLaneCache()
    cache.apply(snapshot())
    cache.apply(snapshot('two'))
    cache.apply({ t: 'pos', pos: pos(1), changes: [{ op: 'list', sub: 'one', gen: 1, diff: [{ remove: 'counter' }] }] })
    assert.deepEqual(cache.list('one')?.ids, [])
    assert.deepEqual(cache.list('two')?.ids, ['counter'])
    assert.deepEqual(cache.at('/counter'), copy(0))
    cache.apply({ t: 'reset', sub: 'one', gen: 2 })
    cache.apply(snapshot('one', 1))
    assert.deepEqual(cache.list('one'), { gen: 2, ids: [] })
  })

  it('clears all copies and lists when a new principal opens the client', () => {
    const cache = createLaneCache()
    cache.apply({ t: 'welcome', principal: 'u:alice', intake: 'intake' })
    cache.apply(snapshot())
    cache.apply({ t: 'welcome', principal: 'u:bob', intake: 'intake' })
    assert.deepEqual(cache.claims(), [])
    assert.equal(cache.list('one'), undefined)
    assert.equal(cache.at('/counter'), undefined)
  })
})
