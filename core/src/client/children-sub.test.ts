import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createLaneCache } from '#client/lane-cache'
import { createInstanceFoundation } from '#kernel/instance'
import { createNodeLane, type NodeLaneFrame } from '#kernel/lane'
import { createMemoryStore } from '#kernel/store/memory'
import { scanBudget } from '#kernel/store/contract'
import { R, type ChangeMember, type ModuleManifest, type NodeCopy, type OpId, type Position } from '#kernel/types'

async function setup(defaultBudget = false) {
  const root = createMemoryStore({ domain: 'children-lane' })
  let saved: Position | undefined, sequence = 0
  const instance = await createInstanceFoundation({ id: 'children-lane', root, writerEpoch: 1,
    counter: { async load() { return saved }, async save(pos) { saved = pos }, async freshEpoch(floor) { return floor + 1 } },
    domains: [{ store: root, epoch: 'children1', persistent: true }], ...defaultBudget ? {} : { budget: scanBudget },
    firstAdmin: { path: '/admin', name: 'admin', password: 'children-password' }, initialCredential: { ttlMs: 60_000 } })
  assert.ok(instance.setupCredential)
  const admin = instance.commands(await instance.auth.openCredential(instance.setupCredential))
  const lane = createNodeLane(instance.nodeLaneOptions(await instance.auth.openCredential(instance.setupCredential)))
  const cache = createLaneCache()
  const key = (): OpId => ({ epoch: instance.writer.intake.epoch, time: Date.now(), nonce: String(++sequence) })
  const commit = (changes: readonly ChangeMember[]) => admin.commit({ opId: key(), changes })
  async function frame(): Promise<NodeLaneFrame> {
    const result = await lane.frames.next(); assert.ok(result.done === false); cache.apply(result.value); return result.value
  }
  await commit([{ op: 'put', node: { $path: '/items', $type: 't.dir' } }]); await frame()
  const paths = (sub: string) => cache.list(sub)?.ids.map(id => {
    const copy = cache.copy(id); assert.ok(copy); return 'node' in copy ? copy.node.$path : copy.path
  })
  return { root, instance, admin, lane, cache, key, commit, frame, paths,
    close() { lane.close(); admin.close(); instance.auth.close() } }
}
function node(copy: NodeCopy) { assert.ok('node' in copy); return copy.node }
const item = (name: string, order: string, fields: Record<string, unknown> = {}): ChangeMember => ({ op: 'put',
  node: { $path: `/items/${name}`, $type: 't.dir', $order: order, ...fields } })
const patch = (path: string, fields: Record<string, unknown>): ChangeMember => ({ op: 'patch', path, ops: { $set: fields } })

describe('native children subscriptions', { timeout: 15_000 }, () => {
  it('uses the canonical order and shares copies with existing node subscriptions', async t => {
    const f = await setup(); t.after(f.close)
    await f.commit([item('z', 'B'), item('b', 'A'), item('a', 'A')])
    f.lane.sub({ node: '/items/a' }); const first = await f.frame(); assert.ok(first.t === 'snap')
    const sub = f.lane.sub({ children: '/items' }), snap = await f.frame(); assert.ok(snap.t === 'snap')
    assert.deepEqual(f.paths(sub), ['/items/a', '/items/b', '/items/z'])
    assert.equal(snap.copies.some(copy => 'node' in copy && copy.node.$path === '/items/a'), false)
    assert.deepEqual(new Set(snap.covered), new Set(snap.list))
  })

  it('changes filtered membership without deleting a copy another subscription covers', async t => {
    const f = await setup(); t.after(f.close)
    await f.commit([item('a', 'A', { selected: false }), item('b', 'B', { selected: true })])
    f.lane.sub({ node: '/items/a' }); await f.frame()
    const sub = f.lane.sub({ children: '/items', where: { selected: true } }); await f.frame()
    const b = f.cache.at('/items/b')
    await f.commit([patch('/items/a', { selected: true })])
    const entered = await f.frame(); assert.ok(entered.t === 'pos')
    assert.deepEqual(new Set(f.paths(sub)), new Set(['/items/a', '/items/b']))
    assert.equal(entered.changes.filter(change => change.op === 'patch').length, 1)
    assert.equal(entered.changes.some(change => change.op === 'put'), false)
    assert.deepEqual(f.cache.at('/items/b'), b)
    await f.commit([patch('/items/a', { selected: false })])
    const exited = await f.frame(); assert.ok(exited.t === 'pos')
    assert.deepEqual(f.paths(sub), ['/items/b'])
    assert.equal(exited.changes.some(change => change.op === 'del'), false)
    assert.ok(f.cache.at('/items/a'))
  })

  it('freezes the initial window as a range and permits new members inside it', async t => {
    const f = await setup(); t.after(f.close)
    await f.commit([item('a', 'A'), item('b', 'B'), item('c', 'C')])
    const sub = f.lane.sub({ children: '/items', window: { limit: 2 } }); const snap = await f.frame(); assert.ok(snap.t === 'snap')
    assert.deepEqual(f.paths(sub), ['/items/a', '/items/b']); assert.ok(snap.next)
    await f.commit([item('between', 'AV'), item('outside', 'D')]); await f.frame()
    assert.deepEqual(new Set(f.paths(sub)), new Set(['/items/a', '/items/b', '/items/between']))
    assert.equal(f.cache.at('/items/outside'), undefined)
  })

  it('narrows an evicting range and never widens it after members leave', async t => {
    const f = await setup(); t.after(f.close)
    await f.commit([item('a', 'A'), item('b', 'B'), item('c', 'C')])
    const sub = f.lane.sub({ children: '/items', window: { limit: 2, evict: true } }); await f.frame()
    await f.commit([item('between', 'AV')]); await f.frame()
    assert.deepEqual(new Set(f.paths(sub)), new Set(['/items/a', '/items/between']))
    await f.commit([patch('/items/b', { $order: 'Az' })]); await f.frame()
    assert.deepEqual(new Set(f.paths(sub)), new Set(['/items/a', '/items/between']))
    await f.commit([{ op: 'remove', path: '/items/between' }]); await f.frame()
    assert.deepEqual(f.paths(sub), ['/items/a'])
    await f.commit([patch('/items/c', { value: 'changed outside' })]); await f.frame()
    assert.deepEqual(f.paths(sub), ['/items/a'])
    await f.commit([item('inside', 'AU')]); await f.frame()
    assert.deepEqual(new Set(f.paths(sub)), new Set(['/items/a', '/items/inside']))
  })

  it('accepts the first matching member after an empty window snapshot', async t => {
    const f = await setup(); t.after(f.close)
    const sub = f.lane.sub({ children: '/items', window: { limit: 1, evict: true } }); await f.frame()
    assert.deepEqual(f.paths(sub), [])
    await f.commit([item('first', 'A')]); await f.frame()
    assert.deepEqual(f.paths(sub), ['/items/first'])
  })

  it('does not narrow a window when only another subscription grows beyond coverage', async t => {
    const f = await setup(); t.after(f.close)
    await f.commit([patch('/sys/limits', { laneCoverageBytes: 3500 }), item('a', 'A'), item('b', 'B'),
      { op: 'put', node: { $path: '/foreign', $type: 't.dir', value: 'small' } }])
    const window = f.lane.sub({ children: '/items', window: { limit: 2, evict: true } }); await f.frame()
    const foreign = f.lane.sub({ node: '/foreign' }); await f.frame()
    await f.commit([patch('/foreign', { value: 'x'.repeat(5000) })])
    const end = await f.frame(); assert.ok(end.t === 'end'); assert.equal(end.sub, foreign); assert.equal(end.error.code, 'BUDGET')
    await f.frame(); assert.deepEqual(f.paths(window), ['/items/a', '/items/b'])
    await f.commit([patch('/items/a', { value: 'still covered' })]); await f.frame()
    assert.deepEqual(f.paths(window), ['/items/a', '/items/b'])
  })

  it('evicts unique extreme members when its own grown image exceeds coverage', async t => {
    const f = await setup(); t.after(f.close)
    await f.commit([patch('/sys/limits', { laneCoverageBytes: 4000 }),
      item('a', 'A', { value: 'x'.repeat(800) }), item('b', 'B', { value: 'x'.repeat(800) }), item('c', 'C', { value: 'x'.repeat(800) })])
    const sub = f.lane.sub({ children: '/items', window: { limit: 3, evict: true } }); const snap = await f.frame(); assert.ok(snap.t === 'snap')
    await f.commit([patch('/items/a', { value: 'x'.repeat(5000) })])
    const changed = await f.frame(); assert.ok(changed.t === 'pos')
    assert.deepEqual(f.paths(sub), []); assert.deepEqual(f.cache.claims(), [])
    await f.commit([item('earlier', '1')]); await f.frame()
    assert.deepEqual(f.paths(sub), [])
  })

  it('ends the first subscription beyond the configured count', async t => {
    const f = await setup(); t.after(f.close)
    for (let i = 0; i < 100; i++) { f.lane.sub({ children: '/items' }); const snap = await f.frame(); assert.ok(snap.t === 'snap') }
    const sub = f.lane.sub({ children: '/items' }), end = await f.frame()
    assert.ok(end.t === 'end'); assert.equal(end.sub, sub); assert.equal(end.error.code, 'BUDGET')
  })

  it('replaces ref include coverage and preserves a target covered elsewhere', async t => {
    const f = await setup(); t.after(f.close)
    await f.commit([item('a', 'A', { friend: '/left' }), { op: 'put', node: { $path: '/left', $type: 't.dir', value: 1 } },
      { op: 'put', node: { $path: '/right', $type: 't.dir', value: 2 } }])
    f.lane.sub({ node: '/left' }); await f.frame()
    const sub = f.lane.sub({ children: '/items', include: [{ ref: 'friend' }] }); const snap = await f.frame(); assert.ok(snap.t === 'snap')
    assert.equal(snap.covered?.length, 2); assert.deepEqual(f.paths(sub), ['/items/a'])
    await f.commit([patch('/items/a', { friend: '/right' })]); const changed = await f.frame(); assert.ok(changed.t === 'pos')
    assert.ok(f.cache.at('/left')); assert.equal(node(f.cache.at('/right')!).value, 2)
    const list = changed.changes.find(change => change.op === 'list' && change.sub === sub); assert.ok(list?.op === 'list')
    assert.equal(list.covered?.includes(node(f.cache.at('/left')!).$id), false)
    assert.equal(list.covered?.includes(node(f.cache.at('/right')!).$id), true)
  })

  it('tracks an initially absent include and fixed includes with an empty member list', async t => {
    const f = await setup(); t.after(f.close)
    await f.commit([{ op: 'put', node: { $path: '/fixed', $type: 't.dir', value: 'fixed' } }, item('a', 'A', { friend: '/later' })])
    const refs = f.lane.sub({ children: '/items', include: [{ ref: 'friend' }] }); await f.frame()
    const empty = f.lane.sub({ children: '/items', where: { selected: true }, include: [{ path: '/fixed' }] }); const snap = await f.frame(); assert.ok(snap.t === 'snap')
    assert.deepEqual(snap.list, []); assert.equal(snap.covered?.length, 1); assert.ok(f.cache.at('/fixed'))
    await f.commit([{ op: 'put', node: { $path: '/later', $type: 't.dir', value: 'new' } }]); await f.frame()
    assert.ok(f.cache.at('/later')); assert.deepEqual(f.paths(refs), ['/items/a']); assert.deepEqual(f.paths(empty), [])
  })

  it('updates one child under a budget too small to reread its sibling list', async t => {
    const f = await setup(true); t.after(f.close)
    await f.commit(Array.from({ length: 20 }, (_, i) => item(String(i), 'A', { value: i })))
    const sub = f.lane.sub({ children: '/items' }); await f.frame()
    await f.commit([patch('/sys/limits', { readNodes: 8 }), patch('/items/0', { value: 'updated' })])
    const changed = await f.frame(); assert.ok(changed.t === 'pos')
    assert.equal(f.paths(sub)?.length, 20); assert.equal(node(f.cache.at('/items/0')!).value, 'updated')
    assert.equal(changed.changes.filter(change => change.op === 'patch').length, 1)
  })

  it('keeps fixed include updates within their own read budget', async t => {
    const f = await setup(true); t.after(f.close)
    await f.commit([...Array.from({ length: 20 }, (_, i) => item(String(i), 'A')),
      { op: 'put', node: { $path: '/fixed', $type: 't.dir', value: 1 } }])
    const sub = f.lane.sub({ children: '/items', include: [{ path: '/fixed' }] }); await f.frame()
    await f.commit([patch('/sys/limits', { readNodes: 8 }), patch('/fixed', { value: 2 })])
    const changed = await f.frame(); assert.ok(changed.t === 'pos')
    assert.equal(f.paths(sub)?.length, 20); assert.equal(node(f.cache.at('/fixed')!).value, 2)
    assert.equal(changed.changes.filter(change => change.op === 'patch').length, 1)
  })

  it('removes hidden include chains and recovers their current values after a grant', async t => {
    const f = await setup(); t.after(f.close)
    const grant = [{ subject: { group: 'public' }, grant: R }]
    await f.commit([patch('/items', { $acl: grant }), item('a', 'A', { friend: '/links/first' }),
      { op: 'put', node: { $path: '/links', $type: 't.dir', $acl: grant } },
      { op: 'put', node: { $path: '/links/first', $type: 't.dir', friend: '/links/second', value: 'old first' } },
      { op: 'put', node: { $path: '/links/second', $type: 't.dir', value: 'old second' } }])
    const lane = createNodeLane(f.instance.nodeLaneOptions(await f.instance.auth.openCredential()))
    t.after(() => lane.close()); await lane.frames.next()
    const cache = createLaneCache(), sub = lane.sub({ children: '/items', include: [{ ref: 'friend', then: [{ ref: 'friend' }] }] })
    async function pull() { const frame = await lane.frames.next(); assert.ok(frame.done === false); cache.apply(frame.value); return frame.value }
    const snap = await pull(); assert.ok(snap.t === 'snap'); assert.equal(snap.covered?.length, 3)
    await f.commit([patch('/links', { $acl: [] })]); await pull()
    assert.equal(cache.at('/links/first'), undefined); assert.equal(cache.at('/links/second'), undefined)
    await f.commit([patch('/links/first', { value: 'hidden first' }), patch('/links/second', { value: 'hidden second' })])
    const hidden = await pull(); assert.ok(hidden.t === 'pos')
    assert.equal(hidden.changes.some(change => change.op === 'put' || change.op === 'patch'), false)
    await f.commit([patch('/links', { $acl: grant })]); await pull()
    assert.equal(node(cache.at('/links/first')!).value, 'hidden first'); assert.equal(node(cache.at('/links/second')!).value, 'hidden second')
    assert.equal(cache.list(sub)?.covered?.length, 3)
  })

  it('shares every error-copy sort field across selectors covering the same node', async t => {
    t.mock.method(console, 'error', () => {})
    const f = await setup(); t.after(f.close)
    const manifest: ModuleManifest = { id: 'children-records', types: [{ name: 'children.record', module: 'children-records',
      version: 0, security: 'ordinary', schema: {}, actions: {} }], security: [], open: [] }
    await f.commit([{ op: 'put', node: { $path: '/sys/types/children.record', $type: 't.type',
      name: 'children.record', module: 'children-records', security: 'ordinary' } }])
    f.instance.registry.publish(manifest)
    await f.commit([{ op: 'put', node: { $path: '/items/error', $type: 'children.record', score: 9, price: 4 } }])
    f.instance.registry.publish({ ...manifest, types: manifest.types.map(type => ({ ...type, schema: { required: ['needed'] } })) })
    const score = f.lane.sub({ children: '/items', sort: [['score', 1]] }); const first = await f.frame(); assert.ok(first.t === 'snap')
    const price = f.lane.sub({ children: '/items', sort: [['price', -1]] }); const second = await f.frame(); assert.ok(second.t === 'snap')
    const copy = f.cache.at('/items/error'); assert.ok(copy && 'error' in copy)
    assert.equal(copy.error.code, 'INVALID'); assert.ok(copy.sort); assert.equal(copy.sort.score, 9); assert.equal(copy.sort.price, 4)
    assert.deepEqual(f.paths(score), ['/items/error']); assert.deepEqual(f.paths(price), ['/items/error'])
    assert.equal(second.copies.length, 1); assert.equal(second.copies[0].ver, first.copies[0].ver)
  })

  it('preserves transferred coverage when the old subscription closes during preparation', async t => {
    const f = await setup(); t.after(f.close)
    await f.commit([item('a', 'A'), { op: 'put', node: { $path: '/other', $type: 't.dir' } }])
    let enter!: () => void, release!: () => void, hold = false
    const entered = new Promise<void>(resolve => { enter = resolve }), released = new Promise<void>(resolve => { release = resolve })
    const native = f.instance.nodeLaneOptions(await f.instance.auth.openCredential(f.instance.setupCredential))
    const lane = createNodeLane({ ...native, read: run => native.read(async source => {
      const result = await run(source)
      if (hold) { hold = false; enter(); await released }
      return result
    }) })
    t.after(() => lane.close()); await lane.frames.next()
    const cache = createLaneCache()
    async function pull() { const frame = await lane.frames.next(); assert.ok(frame.done === false); cache.apply(frame.value); return frame.value }
    const from = lane.sub({ node: '/items/a' }); const initial = await pull(); assert.ok(initial.t === 'snap')
    const into = lane.sub({ children: '/other' }); await pull()
    await f.commit([{ op: 'move', from: '/items/a', to: '/other/a' }])
    hold = true; const transfer = pull(); await entered; lane.unsub(from); release()
    const changed = await transfer; assert.ok(changed.t === 'pos'); assert.ok(cache.at('/other/a'))
    const control = await pull(); assert.ok(control.t === 'pos' && control.coverage === true)
    assert.equal(control.changes.some(change => change.op === 'del' && change.id === initial.list[0]), false)
    assert.deepEqual(cache.list(into)?.ids, initial.list); assert.ok(cache.at('/other/a'))
  })

  it('releases copies hidden by a new registry ACL projection after resetting children', async t => {
    const f = await setup(); t.after(f.close)
    const manifest: ModuleManifest = { id: 'children-visibility', types: [{ name: 'children.visible', module: 'children-visibility',
      version: 0, security: 'ordinary', schema: {}, actions: {} }], security: [], open: [] }
    await f.commit([{ op: 'put', node: { $path: '/sys/types/children.visible', $type: 't.type',
      name: 'children.visible', module: 'children-visibility', security: 'ordinary' } },
      patch('/items', { $acl: [{ subject: { group: 'public' }, grant: R }] })])
    f.instance.registry.publish(manifest)
    await f.commit([{ op: 'put', node: { $path: '/items/a', $type: 'children.visible', value: 'old' } }])
    const lane = createNodeLane(f.instance.nodeLaneOptions(await f.instance.auth.openCredential()))
    t.after(() => lane.close()); await lane.frames.next()
    const cache = createLaneCache()
    async function pull() { const frame = await lane.frames.next(); assert.ok(frame.done === false); cache.apply(frame.value); return frame.value }
    const sub = lane.sub({ children: '/items' }); const initial = await pull(); assert.ok(initial.t === 'snap')
    f.instance.registry.publish({ ...manifest, security: [{ type: 'children.visible', context: 'acl', handler: () => 0 }] })
    const reset = await pull(); assert.ok(reset.t === 'reset')
    const snap = await pull(); assert.ok(snap.t === 'snap'); assert.deepEqual(snap.list, [])
    lane.accept({ t: 'read', req: 'after-reset', selector: { node: '/items' } })
    let frame = await pull()
    while (frame.t === 'pos' && frame.coverage === true) frame = await pull()
    assert.ok(frame.t === 'done' && frame.req === 'after-reset')
    assert.deepEqual(cache.list(sub)?.covered, []); assert.equal(cache.at('/items/a'), undefined); assert.deepEqual(cache.claims(), [])
  })

  it('evicts the last unique member while a shared member holds the range boundary', async t => {
    const f = await setup(); t.after(f.close)
    await f.commit([item('a', 'A'), item('b', 'B')])
    const shared = f.lane.sub({ node: '/items/b' }); await f.frame()
    const window = f.lane.sub({ children: '/items', window: { limit: 2, evict: true } }); await f.frame()
    await f.commit([item('inside', '1')]); const changed = await f.frame(); assert.ok(changed.t === 'pos')
    assert.deepEqual(new Set(f.paths(window)), new Set(['/items/inside', '/items/b']))
    assert.deepEqual(f.paths(shared), ['/items/b']); assert.equal(f.cache.at('/items/a'), undefined)
    await f.commit([patch('/items/a', { value: 'updated evicted candidate' })]); const retry = await f.frame(); assert.ok(retry.t === 'pos')
    assert.deepEqual(new Set(f.paths(window)), new Set(['/items/inside', '/items/b'])); assert.equal(f.cache.at('/items/a'), undefined)
  })
})
