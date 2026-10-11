import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTwpClient } from '@treenx/core/client/twp'
import { KernelError } from '@treenx/core/errors'
import type { Connection, Frame, NodeCopy, Request } from '@treenx/core/kernel/types'
import { createLaneTreeSource } from '#tree/lane-source'
import type { PathSnapshot } from '#tree/tree-source'

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
  const client = createTwpClient(connection, { close() { closed = true; wake() } }), source = createLaneTreeSource(client)
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
/** Wait for the actual public path notification. */
function changed(source: ReturnType<typeof createLaneTreeSource>, path: string, check: (snapshot: PathSnapshot) => boolean): Promise<PathSnapshot> {
  const current = source.getPathSnapshot(path)
  if (check(current)) return Promise.resolve(current)
  return new Promise(resolve => {
    const unsubscribe = source.subscribePath(path, () => {
      const snapshot = source.getPathSnapshot(path)
      if (check(snapshot)) { unsubscribe(); resolve(snapshot) }
    })
  })
}
function snap(sub: string, copies: readonly NodeCopy[], next?: string): Extract<Frame, { t: 'snap' }> {
  return { t: 'snap', sub, gen: 1, list: copies.map(item => 'node' in item ? item.node.$id : item.id), copies, at: [at],
    ...(next === undefined ? {} : { next }) }
}

describe('public native lane source', { timeout: 10_000 }, () => {
  it('accepts once while retaining exactly one canonical coverage owner until disposal', async t => {
    const f = fixture(); t.after(f.close)
    const first = f.source.mountPath('/item', { once: true })
    const second = f.source.mountPath('/item')
    const sub = await f.sub(0), ready = changed(f.source, '/item', value => value.status === 'ready')
    f.push(snap(sub.sub, [copy('item', '/item')])); await ready
    assert.equal(f.source.getPathSnapshot('/item').data?.value, 1)
    assert.equal(f.sent.filter(request => request.t === 'sub').length, 1)
    assert.equal(f.sent.some(request => request.t === 'read'), false)
    first.dispose(); assert.equal(f.sent.some(request => request.t === 'unsub'), false)
    second.dispose(); assert.deepEqual(f.sent.at(-1), { t: 'unsub', sub: sub.sub })
  })

  it('clears an accepted path on end and surfaces the actual failure', async t => {
    const f = fixture(); t.after(f.close)
    const handle = f.source.mountPath('/item'); t.after(handle.dispose)
    const sub = await f.sub(0), ready = changed(f.source, '/item', value => value.status === 'ready')
    f.push(snap(sub.sub, [copy('item', '/item')])); await ready
    const ended = changed(f.source, '/item', value => value.status === 'error')
    f.push({ t: 'end', sub: sub.sub, error: new KernelError('UNAUTHENTICATED', 'Actor revoked') })
    const result = await ended
    assert.equal(result.data, undefined)
    assert.ok(result.error instanceof KernelError)
    assert.equal(result.error.code, 'UNAUTHENTICATED')
  })

  it('borrows child coverage and promotes the path when its last window closes', async t => {
    const f = fixture(); t.after(f.close)
    const children = f.source.mountChildren('/items', { limit: 1, watch: false, watchNew: true })
    const sub = await f.sub(0)
    assert.deepEqual(sub.selector, { children: '/items', window: { limit: 1 } })
    const ready = new Promise<void>(resolve => {
      const off = children.subscribe!(() => { if (children.getSnapshot!().phase === 'ready') { off(); resolve() } })
    })
    f.push(snap(sub.sub, [copy('a', '/items/a')])); await ready
    const path = f.source.mountPath('/items/a', { once: true })
    assert.equal(f.source.getPathSnapshot('/items/a').data?.$path, '/items/a')
    assert.equal(f.sent.filter(request => request.t === 'sub').length, 1)
    children.dispose()
    const promoted = await f.sub(1)
    assert.deepEqual(promoted.selector, { node: '/items/a' })
    assert.equal(f.sent.some(request => request.t === 'read'), false)
    path.dispose()
  })
  it('clears mounted presentation on source close and tolerates later disposal', async t => {
    const f = fixture(); t.after(f.close)
    const path = f.source.mountPath('/item');
    const sub = await f.sub(0), ready = changed(f.source, '/item', value => value.status === 'ready')
    f.push(snap(sub.sub, [copy('item', '/item')])); await ready
    let notified = false
    const off = f.source.subscribePath('/item', () => { notified = true })
    f.source.close()
    assert.equal(notified, true)
    assert.equal(f.source.getPathSnapshot('/item').data, undefined)
    assert.ok(f.source.getPathSnapshot('/item').error instanceof KernelError)
    assert.equal(f.source.getChildrenSnapshot('/items').data.length, 0)
    assert.equal(f.sent.filter(request => request.t === 'unsub').length, 1)
    assert.throws(() => f.source.mountPath('/later'), error => error instanceof KernelError && error.code === 'CANCELLED')
    off(); path.dispose()
  })
  it('preserves healthy siblings with explicit projection failures and settles completed absence', async t => {
    const f = fixture(); t.after(f.close)
    const children = f.source.mountChildren('/items', { limit: 1 });
    const sub = await f.sub(0)
    const failed = new Promise<void>(resolve => {
      const off = children.subscribe!(() => { if (children.getSnapshot!().phase === 'ready') { off(); resolve() } })
    })
    f.push(snap(sub.sub, [copy('good', '/items/good'), { id: 'bad', path: '/items/bad', ver: 'bad', error: new KernelError('INVALID', 'Projection failed') }]))
    await failed
    const snapshot = children.getSnapshot!()
    assert.deepEqual(snapshot.data.map(node => node.$path), ['/items/good'])
    assert.equal(snapshot.error, null)
    assert.equal(snapshot.errors?.[0].path, '/items/bad')
    assert.equal(snapshot.errors?.[0].error.code, 'INVALID')
    const path = f.source.mountPath('/missing')
    const absentSub = await f.sub(1), absent = changed(f.source, '/missing', value => value.status === 'not_found')
    f.push(snap(absentSub.sub, [])); await absent
    assert.equal(f.source.getPathSnapshot('/missing').error, null)
    assert.equal(f.source.getPathSnapshot('/missing').data, undefined)
    path.dispose(); children.dispose()
  })
})


it('keeps patch predictions across foreign canonical frames until their exact outcomes settle', async t => {
  const f = fixture(); t.after(f.close);
  const handle = f.source.mountPath('/item'); t.after(handle.dispose);
  const subscription = await f.sub(0), ready = changed(f.source, '/item', value => value.status === 'ready');
  f.push(snap(subscription.sub, [copy('item', '/item')])); await ready;
  const predictedFirst = changed(f.source, '/item', value => value.data?.value === 2);
  const first = f.source.effects.patchNode('/item', { value: 2 });
  await predictedFirst;
  const predictedSecond = changed(f.source, '/item', value => value.data?.other === 9);
  const second = f.source.effects.patchNode('/item', { other: 9 });
  await predictedSecond;
  const commits = f.sent.filter((request): request is Extract<Request, { t: 'commit' }> => request.t === 'commit');
  assert.equal(commits.length, 2);
  const foreign = new Promise<void>(resolve => {
    const off = f.source.subscribePath('/item', () => { const copy = f.client.cache.at('/item'); if (copy !== undefined && 'node' in copy && copy.node.value === 100) { off(); resolve(); } });
  });
  f.push({ t: 'pos', pos: { ...at, seq: 2 }, changes: [{ op: 'patch', id: 'item', base: 'v1', ver: 'foreign', bits: 7,
    delta: { set: { value: 100, $rev: 'foreign-revision' } } }] });
  await foreign;
  assert.equal(f.source.getPathSnapshot('/item').data?.value, 2);
  assert.equal(f.source.getPathSnapshot('/item').data?.$rev, 'rev:v1');
  const refusal = assert.rejects(first, error => error instanceof KernelError && error.code === 'FORBIDDEN');
  f.push({ t: 'fail', req: commits[0].req, error: new KernelError('FORBIDDEN', 'Refused patch') });
  await refusal;
  assert.equal(f.source.getPathSnapshot('/item').data?.value, 1);
  assert.equal(f.source.getPathSnapshot('/item').data?.other, 9);
  f.push({ t: 'done', req: commits[1].req }); await second;
  assert.equal(f.source.getPathSnapshot('/item').data?.value, 100);
  assert.equal(f.source.getPathSnapshot('/item').data?.other, undefined);
  assert.equal(f.source.getPathSnapshot('/item').data?.$rev, 'foreign-revision');
});
