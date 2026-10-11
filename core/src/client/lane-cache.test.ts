import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { KernelError } from '#errors'
import { createLaneCache } from '#client/lane-cache'
import type { ComputedNode, ErrorCopy, Frame, NodeCopy } from '#kernel/types'

const pos = (seq: number) => ({ instance: 'client', epoch: 1, seq })
const copy = (count: number): NodeCopy => ({ node: { $path: '/counter', $id: 'counter', $type: 'counter', $rev: String(count), count }, bits: 7, ver: String(count) })
const snapshot = (sub = 'one', gen = 1): Frame => ({ t: 'snap', sub, gen, list: ['counter'], copies: [copy(0)], at: [pos(0)] })
const code = (expected: KernelError['code']) => (error: unknown) => error instanceof KernelError && error.code === expected

describe('native lane cache', () => {
  it('keeps View ownership inside its generation and clears it on reset, ordinary snapshots and end', () => {
    const cache = createLaneCache()
    const owner = { path: '/trash', component: '#deleted' }
    cache.apply({ t: 'snap', sub: 'view', gen: 1, list: [], copies: [], rows: [], at: [pos(0)], viewOwner: owner })
    assert.deepEqual(cache.list('view')?.viewOwner, owner)
    cache.apply({ t: 'pos', pos: pos(1), changes: [{ op: 'list', sub: 'view', gen: 1, diff: [] }] })
    assert.deepEqual(cache.list('view')?.viewOwner, owner)
    cache.apply({ t: 'result', sub: 'view', gen: 1, diff: [], copies: [], at: [pos(1)] })
    assert.equal(cache.list('view')?.viewOwner, undefined)
    cache.apply({ t: 'result', sub: 'view', gen: 1, diff: [], copies: [], at: [pos(1)], viewOwner: owner })
    assert.deepEqual(cache.list('view')?.viewOwner, owner)
    cache.apply({ t: 'reset', sub: 'view', gen: 2 })
    assert.equal(cache.list('view')?.viewOwner, undefined)
    cache.apply({ t: 'result', sub: 'view', gen: 1, diff: [], copies: [], at: [pos(1)], viewOwner: owner })
    assert.equal(cache.list('view')?.viewOwner, undefined)
    cache.apply({ t: 'snap', sub: 'view', gen: 2, list: [], copies: [], at: [pos(1)] })
    assert.equal(cache.list('view')?.viewOwner, undefined)
    cache.apply({ t: 'end', sub: 'view', error: new KernelError('CANCELLED', 'Subscription closed') })
    assert.equal(cache.list('view'), undefined)
  })

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
    assert.deepEqual(cache.list('one'), { gen: 2, ids: [], covered: [], phase: 'loading' })
  })

  it('keeps include coverage and real cursors separate from direct members', () => {
    const cache = createLaneCache(), related: NodeCopy = { node: { $path: '/related', $id: 'related', $type: 't.dir', $rev: '0' }, bits: 7, ver: '0' }
    cache.apply({ t: 'snap', sub: 'page', gen: 1, list: ['counter'], covered: ['counter', 'related'],
      copies: [copy(0), related], at: [pos(0)], next: 'cursor' })
    assert.deepEqual(cache.list('page'), { gen: 1, at: [pos(0)], ids: ['counter'], covered: ['counter', 'related'], phase: 'ready', next: 'cursor' })
    cache.apply({ t: 'pos', pos: pos(1), changes: [{ op: 'list', sub: 'page', gen: 1, diff: [], covered: ['counter'] }] })
    assert.deepEqual(cache.list('page'), { gen: 1, at: [pos(1)], ids: ['counter'], covered: ['counter'], phase: 'ready' })
    assert.deepEqual(cache.copy('related'), related)
    cache.apply({ t: 'reset', sub: 'page', gen: 2 })
    assert.equal(cache.list('page')?.phase, 'loading')
    cache.apply({ t: 'snap', sub: 'page', gen: 2, list: [], copies: [], at: [pos(1)] })
    assert.equal(cache.list('page')?.phase, 'ready')
  })

  it('sorts malformed and valid members with the same JSON ranks and path order', () => {
    const cache = createLaneCache(), malformed: NodeCopy = { id: 'bad', path: '/bad', error: new KernelError('INVALID', 'Bad node'),
      sort: { 'nested.order': 1 }, ver: 'bad' }, valid: NodeCopy = { node: { $path: '/valid', $id: 'valid', $type: 't.dir', $rev: '0',
        nested: { order: 2 } }, bits: 7, ver: '0' }
    cache.apply({ t: 'snap', sub: 'sorted', gen: 1, list: ['valid', 'bad'], copies: [valid, malformed], at: [pos(0)] })
    assert.deepEqual(cache.ordered(['valid', 'bad'], [['nested.order', 1]]), [malformed, valid])
    assert.deepEqual(cache.ordered(['valid', 'bad'], [['nested.order', -1]]), [valid, malformed])
    assert.throws(() => cache.ordered(['missing'], []), code('INVALID'))
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

describe('subscription View data', () => {
  const computed: ComputedNode = {
    $path: '/source',
    $id: 'source',
    $type: 't.dir',
    $rev: '0',
    value: 4
  }
  const view = (sub = 'view', gen = 1): Frame => ({
    t: 'snap',
    sub,
    gen,
    list: ['source'],
    copies: [],
    computed: [computed],
    rows: [{ key: 'total', value: 4 }],
    at: [pos(0)]
  })

  it('keeps computed nodes and rows local to their subscription, outside ordinary claims', () => {
    const cache = createLaneCache()
    cache.apply(snapshot())
    cache.apply(view())
    cache.apply(view('other'))
    assert.deepEqual(cache.list('view')?.computed, [computed])
    assert.deepEqual(cache.list('view')?.rows, [{ key: 'total', value: 4 }])
    assert.equal(cache.copy('source'), undefined)
    assert.equal(cache.at('/source'), undefined)
    assert.deepEqual(cache.claims(), [{ id: 'counter', ver: '0' }])
    cache.apply({
      t: 'result',
      sub: 'view',
      gen: 1,
      diff: [{ remove: 'source' }],
      copies: [],
      computed: [],
      rows: [{ key: 'replacement', value: 0 }],
      at: [pos(1)]
    })
    assert.deepEqual(cache.list('view')?.computed, [])
    assert.deepEqual(cache.list('view')?.rows, [{ key: 'replacement', value: 0 }])
    assert.deepEqual(cache.list('other')?.computed, [computed])
    cache.apply({ t: 'result', sub: 'view', gen: 1, diff: [], copies: [], at: [pos(2)] })
    assert.deepEqual(cache.list('view')?.rows, [{ key: 'replacement', value: 0 }])
    cache.apply({ t: 'result', sub: 'view', gen: 1, diff: [], copies: [], rows: [], at: [pos(3)] })
    assert.deepEqual(cache.list('view')?.rows, [])
  })

  it('merges changed whole nodes while retaining unchanged members and explicit include coverage', () => {
    const cache = createLaneCache()
    const included: ComputedNode = {
      ...computed,
      $id: 'included',
      $path: '/included'
    }
    const second: ComputedNode = {
      ...computed,
      $id: 'second',
      $path: '/second',
      value: 8
    }
    cache.apply({
      t: 'snap',
      sub: 'view',
      gen: 1,
      list: ['source', 'second'],
      covered: ['source', 'second', 'included'],
      copies: [],
      computed: [computed, second, included],
      rows: [{ key: 'total', value: 12 }],
      at: []
    })
    cache.apply({
      t: 'result',
      sub: 'view',
      gen: 1,
      diff: [],
      covered: ['source', 'second', 'included'],
      copies: [],
      computed: [{ ...computed, $rev: '1', value: 5 }],
      at: []
    })
    assert.deepEqual(cache.list('view')?.computed, [{ ...computed, $rev: '1', value: 5 }, second, included])
    assert.deepEqual(cache.orderedComputed('view', [['value', -1]]), [
      second,
      { ...computed, $rev: '1', value: 5 }
    ])
    assert.throws(() => cache.orderedComputed('missing', []), code('INVALID'))
    assert.deepEqual(cache.list('view')?.rows, [{ key: 'total', value: 12 }])
    cache.apply({
      t: 'result',
      sub: 'view',
      gen: 1,
      diff: [{ remove: 'source' }],
      covered: ['second', 'included'],
      copies: [],
      at: []
    })
    assert.deepEqual(cache.list('view')?.computed, [second, included])
    cache.apply({
      t: 'result',
      sub: 'view',
      gen: 1,
      diff: [],
      covered: ['second'],
      copies: [],
      at: []
    })
    assert.deepEqual(cache.list('view')?.computed, [second])
  })

  it('discards View data at generation and subscription lifetime boundaries', () => {
    const cache = createLaneCache()
    cache.attach({ token: 'credential' })
    cache.apply(snapshot())
    cache.apply(view())
    cache.apply({ t: 'reset', sub: 'view', gen: 2 })
    cache.apply(view('view', 1))
    cache.apply({
      t: 'result',
      sub: 'view',
      gen: 1,
      diff: [],
      copies: [],
      computed: [computed],
      rows: [{ key: 'stale' }],
      at: []
    })
    assert.deepEqual(cache.list('view'), { gen: 2, ids: [], covered: [], phase: 'loading' })
    assert.throws(() => cache.orderedComputed('view', []), code('INVALID'))
    cache.apply(view('view', 2))
    cache.apply({ t: 'snap', sub: 'view', gen: 3, list: [], copies: [], at: [] })
    assert.equal(cache.list('view')?.computed, undefined)
    assert.equal(cache.list('view')?.rows, undefined)
    cache.apply(view('ended'))
    cache.apply({ t: 'end', sub: 'ended', error: new KernelError('BUDGET', 'Coverage exhausted') })
    assert.equal(cache.list('ended'), undefined)
    cache.apply(view('forgotten'))
    cache.forget('forgotten')
    assert.equal(cache.list('forgotten'), undefined)
    cache.apply(view('retained'))
    cache.detach(true)
    assert.equal(cache.list('retained'), undefined)
    assert.deepEqual(cache.reconnectClaims({ token: 'credential' }), [{ id: 'counter', ver: '0' }])
  })
})


it('keeps View errors outside ordinary cache and clears opposite same-ID owned payloads', () => {
  const cache = createLaneCache()
  cache.attach({ token: 'credential' })
  cache.apply(snapshot())
  const error: ErrorCopy = { id: 'counter', path: '/counter', ver: 'view', error: new KernelError('INVALID', 'View projection failed') }
  const node: ComputedNode = { $id: 'counter', $path: '/counter', $type: 'counter', $rev: 'computed', count: 9 }
  cache.apply({ t: 'snap', sub: 'view', gen: 1, list: ['counter'], covered: ['counter'], copies: [], viewErrors: [error], at: [] })
  assert.deepEqual(cache.orderedView('view', []), [{ kind: 'copy', copy: error }])
  assert.deepEqual(cache.at('/counter'), copy(0))
  assert.deepEqual(cache.claims(), [{ id: 'counter', ver: '0' }])
  cache.apply({ t: 'result', sub: 'view', gen: 1, diff: [], copies: [], computed: [node], at: [] })
  assert.deepEqual(cache.list('view')?.viewErrors, [])
  assert.deepEqual(cache.orderedView('view', []), [{ kind: 'computed', node }])
  cache.apply({ t: 'result', sub: 'view', gen: 1, diff: [], copies: [], viewErrors: [error], at: [] })
  assert.deepEqual(cache.list('view')?.computed, [])
  assert.deepEqual(cache.orderedView('view', []), [{ kind: 'copy', copy: error }])
  cache.apply({ t: 'snap', sub: 'reader-view', gen: 1, list: ['counter'], copies: [], viewErrors: [error], at: [] })
  cache.apply({ t: 'result', sub: 'reader-view', gen: 1, diff: [], copies: [copy(1)], at: [] })
  assert.deepEqual(cache.list('reader-view')?.viewErrors, [])
  assert.deepEqual(cache.orderedView('reader-view', []), [{ kind: 'copy', copy: copy(1) }])
  cache.apply({ t: 'result', sub: 'view', gen: 1, diff: [], copies: [], viewErrors: [error], at: [] })
  cache.apply({ t: 'result', sub: 'view', gen: 1, diff: [], copies: [], at: [] })
  assert.deepEqual(cache.list('view')?.viewErrors, [error])
  cache.apply({ t: 'result', sub: 'view', gen: 1, diff: [{ remove: 'counter' }], covered: [], copies: [], at: [] })
  assert.deepEqual(cache.list('view')?.viewErrors, [])
  cache.apply({ t: 'reset', sub: 'view', gen: 2 })
  assert.equal(cache.list('view')?.viewErrors, undefined)
  cache.apply({ t: 'snap', sub: 'missing-owned', gen: 1, list: ['counter'], copies: [], computed: [], at: [] })
  assert.throws(() => cache.orderedView('missing-owned', []), code('INVALID'))
  for (const sub of ['ended-error', 'forgotten-error', 'detached-error'])
    cache.apply({ t: 'snap', sub, gen: 1, list: ['counter'], copies: [], viewErrors: [error], at: [] })
  cache.apply({ t: 'end', sub: 'ended-error', error: new KernelError('CANCELLED', 'Closed') })
  cache.forget('forgotten-error')
  assert.equal(cache.list('ended-error'), undefined)
  assert.equal(cache.list('forgotten-error'), undefined)
  cache.detach(true)
  assert.equal(cache.list('detached-error'), undefined)
  assert.deepEqual(cache.reconnectClaims({ token: 'credential' }), [{ id: 'counter', ver: '1' }])
})
