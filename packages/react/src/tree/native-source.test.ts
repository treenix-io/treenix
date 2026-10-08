import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTwpClient } from '@treenx/core/client/twp'
import { KernelError } from '@treenx/core/errors'
import type { Connection, Frame, NodeCopy, Request, SubSelector } from '@treenx/core/kernel/types'
import { createNativeTreeSource, type NativeMount, type NativeSnapshot } from '#tree/native-source'

const at = { instance: 'source', epoch: 1, seq: 1 }
function copy(id: string, path: string, value = 1, ver = 'v1'): NodeCopy {
  return { node: { $id: id, $path: path, $type: 't.dir', $rev: `rev:${ver}`, value }, bits: 7, ver }
}
function fixture() {
  const sent: Request[] = [], queue: Frame[] = [], listeners = new Set<() => void>()
  let wake: () => void = () => {}, closed = false
  const connection: Connection = { send(request) { sent.push(request); for (const listener of listeners) listener() }, frames: (async function* () {
    while (!closed) {
      const frame = queue.shift()
      if (frame === undefined) await new Promise<void>(resolve => { wake = resolve })
      else yield frame
    }
  })() }
  const client = createTwpClient(connection, { close() { closed = true; wake() } }), source = createNativeTreeSource(client)
  function push(frame: Frame) { queue.push(frame); wake() }
  push({ t: 'welcome', principal: 'u:source', intake: 'source-intake' })
  async function sub(index: number): Promise<Extract<Request, { t: 'sub' }>> {
    while (true) {
      const requests = sent.filter((request): request is Extract<Request, { t: 'sub' }> => request.t === 'sub')
      if (requests[index] !== undefined) return requests[index]
      await new Promise<void>(resolve => {
        const done = () => { listeners.delete(done); resolve() }
        listeners.add(done)
      })
    }
  }
  return { client, source, sent, push, sub, close() { source.close(); client.close() } }
}
function changed(handle: NativeMount, check: (snapshot: NativeSnapshot) => boolean): Promise<NativeSnapshot> {
  const current = handle.getSnapshot()
  if (check(current)) return Promise.resolve(current)
  return new Promise(resolve => {
    const unsubscribe = handle.subscribe(() => {
      const snapshot = handle.getSnapshot()
      if (check(snapshot)) { unsubscribe(); resolve(snapshot) }
    })
  })
}
function snap(sub: string, copies: readonly NodeCopy[], next?: string): Extract<Frame, { t: 'snap' }> {
  return { t: 'snap', sub, gen: 1, list: copies.map(item => 'node' in item ? item.node.$id : item.id), copies, at: [at],
    ...(next === undefined ? {} : { next }) }
}

describe('canonical native React source', { timeout: 10_000 }, () => {
  it('keeps a stable snapshot under unrelated positions and replaces it for a changed projected version', async t => {
    const f = fixture(); t.after(f.close)
    const handle = f.source.mount({ node: '/item' }); t.after(() => handle.dispose())
    const sub = await f.sub(0), ready = changed(handle, snapshot => snapshot.phase === 'ready')
    f.push(snap(sub.sub, [copy('item', '/item')])); const before = await ready
    const pending = f.source.commit({ changes: [] })
    f.push({ t: 'pos', pos: { ...at, seq: 2 }, changes: [] }); f.push({ t: 'done', req: pending.id, pos: { ...at, seq: 2 } })
    await pending.outcome
    assert.equal(handle.getSnapshot(), before)
    const updated = changed(handle, snapshot => snapshot.members[0]?.ver === 'v2')
    f.push({ t: 'pos', pos: { ...at, seq: 3 }, changes: [{ op: 'put', copy: copy('item', '/item', 2, 'v2') }] })
    const after = await updated
    assert.notEqual(after, before); assert.equal('node' in after.members[0] && after.members[0].node.value, 2)
    assert.equal(handle.getSnapshot(), after)
  })

  it('shares one exact subscription across multiple mounts and releases it only after the last disposal', async t => {
    const f = fixture(); t.after(f.close)
    const first = f.source.mount({ node: '/item' }), second = f.source.mount({ node: '/item' })
    const sub = await f.sub(0), ready = changed(first, snapshot => snapshot.phase === 'ready')
    f.push(snap(sub.sub, [copy('item', '/item')])); await ready
    assert.equal(first.getSnapshot(), second.getSnapshot())
    first.dispose(); assert.equal(f.sent.some(request => request.t === 'unsub'), false)
    second.dispose(); assert.deepEqual(f.sent.at(-1), { t: 'unsub', sub: sub.sub })
    assert.equal(second.getSnapshot().error?.code, 'CANCELLED'); assert.deepEqual(second.getSnapshot().members, [])
    assert.equal(f.source.getSnapshot({ node: '/item' }).members.length, 0)
  })

  it('keeps same-parent query windows separate and appends with the actual last-page cursor', async t => {
    const f = fixture(); t.after(f.close)
    const one: SubSelector = { children: '/items', where: { value: { $gt: 0 } }, window: { limit: 1 } }
    const two: SubSelector = { children: '/items', where: { value: { $lt: 0 } }, window: { limit: 2 } }
    const first = f.source.mount(one), second = f.source.mount(two)
    const a = await f.sub(0), b = await f.sub(1)
    const aReady = changed(first, snapshot => snapshot.phase === 'ready'), bReady = changed(second, snapshot => snapshot.phase === 'ready')
    f.push(snap(a.sub, [copy('a', '/items/a')], 'actual-cursor'))
    f.push(snap(b.sub, [copy('b', '/items/b', -1)])); await Promise.all([aReady, bReady])
    assert.deepEqual(first.getSnapshot().members.map(item => 'node' in item ? item.node.$id : item.id), ['a'])
    assert.deepEqual(second.getSnapshot().members.map(item => 'node' in item ? item.node.$id : item.id), ['b'])
    first.loadMore(); const page = await f.sub(2)
    assert.deepEqual(page.selector, { ...one, window: { limit: 1, after: 'actual-cursor' } })
    const appended = changed(first, snapshot => snapshot.phase === 'ready' && snapshot.members.length === 2)
    f.push(snap(page.sub, [copy('c', '/items/c')])); await appended
    assert.equal(first.getSnapshot().next, undefined); assert.equal(second.getSnapshot().members.length, 1)
    first.dispose(); second.dispose()
  })

  it('keeps the default page limit in the cursor scope when appending an implicit window', async t => {
    const f = fixture(); t.after(f.close)
    const handle = f.source.mount({ children: '/items' }), sub = await f.sub(0)
    assert.deepEqual(sub.selector, { children: '/items', window: { limit: 100 } })
    const ready = changed(handle, snapshot => snapshot.phase === 'ready')
    f.push(snap(sub.sub, [copy('first', '/items/first')], 'scoped-cursor')); await ready
    handle.loadMore()
    const page = await f.sub(1)
    assert.deepEqual(page.selector, { children: '/items', window: { limit: 100, after: 'scoped-cursor' } })
    assert.equal(f.source.getSnapshot({ children: '/items' }), handle.getSnapshot())
    handle.dispose()
  })

  it('represents member and included schema errors without converting them into nodes', async t => {
    const f = fixture(); t.after(f.close)
    const handle = f.source.mount({ children: '/items', include: [{ path: '/included' }] })
    const sub = await f.sub(0), ready = changed(handle, snapshot => snapshot.phase === 'ready')
    const bad: NodeCopy = { id: 'bad', path: '/items/bad', ver: 'bad1', error: new KernelError('INVALID', 'Invalid stored component') }
    const included: NodeCopy = { id: 'included', path: '/included', ver: 'inc1', error: new KernelError('INVALID', 'Invalid included component') }
    f.push({ t: 'snap', sub: sub.sub, gen: 1, list: ['bad'], copies: [bad, included], covered: ['bad', 'included'], at: [at] })
    const snapshot = await ready
    assert.deepEqual(snapshot.members, [bad]); assert.deepEqual(snapshot.included, [included]); assert.equal(snapshot.phase, 'ready')
    handle.dispose()
  })

  it('borrows a covered path and opens its own subscription when the covering window evicts it', async t => {
    const f = fixture(); t.after(f.close)
    const children = f.source.mount({ children: '/items', window: { limit: 1, evict: true } })
    const childSub = await f.sub(0), ready = changed(children, snapshot => snapshot.phase === 'ready')
    f.push(snap(childSub.sub, [copy('a', '/items/a')])); await ready
    const node = f.source.mount({ node: '/items/a' })
    assert.equal(node.getSnapshot().phase, 'ready')
    assert.equal(f.sent.filter(request => request.t === 'sub').length, 1)
    f.push({ t: 'pos', pos: { ...at, seq: 2 }, changes: [{ op: 'list', sub: childSub.sub, gen: 1, diff: [{ remove: 'a' }], covered: [] }, { op: 'del', id: 'a' }] })
    const ownSub = await f.sub(1), restored = changed(node, snapshot => snapshot.phase === 'ready')
    assert.deepEqual(ownSub.selector, { node: '/items/a' })
    f.push(snap(ownSub.sub, [copy('a', '/items/a')])); await restored
    children.dispose(); assert.equal(node.getSnapshot().members.length, 1)
    node.dispose()
  })

  it('clears a reset immediately and never restores a disposed resource from a late snapshot', async t => {
    const f = fixture(); t.after(f.close)
    const selector: SubSelector = { node: '/item' }, handle = f.source.mount(selector)
    const sub = await f.sub(0), ready = changed(handle, snapshot => snapshot.phase === 'ready')
    f.push(snap(sub.sub, [copy('item', '/item')])); await ready
    const reset = changed(handle, snapshot => snapshot.phase === 'loading')
    f.push({ t: 'reset', sub: sub.sub, gen: 2 }); const empty = await reset
    assert.deepEqual(empty.members, []); assert.deepEqual(empty.generations, [2])
    handle.dispose()
    f.push({ ...snap(sub.sub, [copy('item', '/item')]), gen: 2 })
    const pending = f.source.commit({ changes: [] })
    f.push({ t: 'pos', pos: { ...at, seq: 2 }, changes: [] }); f.push({ t: 'done', req: pending.id, pos: { ...at, seq: 2 } })
    await pending.outcome; assert.equal(f.source.getSnapshot(selector).members.length, 0)
  })

  it('preserves refusal after a successful snapshot and clears the old visible copies', async t => {
    const f = fixture(); t.after(f.close)
    const handle = f.source.mount({ node: '/item' }), sub = await f.sub(0), ready = changed(handle, snapshot => snapshot.phase === 'ready')
    f.push(snap(sub.sub, [copy('item', '/item')])); await ready
    const refused = changed(handle, snapshot => snapshot.phase === 'error')
    f.push({ t: 'end', sub: sub.sub, error: new KernelError('UNAUTHENTICATED', 'Actor revoked') })
    const snapshot = await refused
    assert.equal(snapshot.error?.code, 'UNAUTHENTICATED'); assert.deepEqual(snapshot.members, [])
    handle.dispose()
  })
})
