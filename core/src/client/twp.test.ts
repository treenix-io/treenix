import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTwpClient } from '#client/twp'
import { KernelError } from '#errors'
import { createInstanceFoundation } from '#kernel/instance'
import { createNodeLane } from '#kernel/lane'
import { scanBudget } from '#kernel/store/contract'
import { createMemoryStore } from '#kernel/store/memory'
import type { Connection, Frame, Position, Request } from '#kernel/types'

function connection() {
  const sent: Request[] = [], queue: Frame[] = []
  let wake: () => void = () => {}, closed = false
  const wire: Connection = { send: request => { sent.push(request) }, frames: (async function* () {
    while (!closed) {
      const frame = queue.shift()
      if (frame === undefined) await new Promise<void>(resolve => { wake = resolve })
      else yield frame
    }
  })() }
  const client = createTwpClient(wire, { close() { closed = true; wake() } })
  queue.push({ t: 'welcome', principal: 'u:admin', intake: 'intake' }); wake()
  return { client, sent, push(frame: Frame) { queue.push(frame); wake() } }
}
const pos = { instance: 'client', epoch: 1, seq: 1 }
const code = (expected: KernelError['code']) => (error: unknown) => error instanceof KernelError && error.code === expected

describe('native TWP client', () => {
  it('delivers history images through the native lane and client read API', async t => {
    const root = createMemoryStore({ domain: 'client-history' })
    let saved: Position | undefined
    const instance = await createInstanceFoundation({ id: 'client-history', root, writerEpoch: 1,
      counter: { async load() { return saved }, async save(value) { saved = value }, async freshEpoch(floor) { return floor + 1 } },
      domains: [{ store: root, epoch: 'history1', persistent: false }], budget: scanBudget,
      firstAdmin: { path: '/admin', name: 'admin', password: 'client-password' }, initialCredential: { ttlMs: 60_000 } })
    t.after(() => instance.auth.close()); assert.ok(instance.setupCredential)
    const lane = createNodeLane(instance.nodeLaneOptions(await instance.auth.openCredential(instance.setupCredential)))
    t.after(() => lane.close())
    const client = createTwpClient({ frames: lane.frames, send(request) {
      assert.ok(request.t !== 'hi'); lane.accept(request)
    } })
    t.after(() => client.close()); await client.ready
    const result = await client.read({ history: '/', window: { limit: 1 } })
    assert.equal(result.history?.length, 1)
    assert.equal(result.copies.length, 0)
    assert.ok(result.history?.[0].address.pos)
  })
  it('correlates only after the covering position and preserves the exact supplied retry key', async t => {
    const f = connection(); t.after(() => f.client.close()); await f.client.ready
    const key = { epoch: 'intake', time: 123, nonce: 'retry' }
    const pending = f.client.commit({ changes: [], opId: key })
    const request = f.sent.at(-1)
    assert.ok(request?.t === 'commit')
    assert.deepEqual(request.opId, key)
    f.push({ t: 'pos', pos, changes: [] }); f.push({ t: 'done', req: pending.id, pos, value: 'accepted' })
    assert.deepEqual(await pending.outcome, { pos, value: 'accepted' })
  })

  it('fails loudly if a mutation outcome precedes its position', async t => {
    const f = connection(); t.after(() => f.client.close()); await f.client.ready
    const pending = f.client.commit({ changes: [] })
    const ended = assert.rejects(pending.outcome, code('INVALID'))
    f.push({ t: 'done', req: pending.id, pos })
    await ended
    assert.deepEqual(f.client.cache.claims(), [])
  })

  it('preserves a request refusal and still accepts the next projected read', async t => {
    const f = connection(); t.after(() => f.client.close()); await f.client.ready
    const first = f.client.read({ node: '/missing' }), ended = assert.rejects(first, code('NOT_FOUND'))
    const request = f.sent.at(-1); assert.ok(request?.t === 'read')
    f.push({ t: 'fail', req: request.req, error: { code: 'NOT_FOUND', message: 'Missing' } }); await ended
    const next = f.client.read({ children: '/' }), nextRequest = f.sent.at(-1); assert.ok(nextRequest?.t === 'read')
    const result = { list: [], copies: [], at: [pos] }
    f.push({ t: 'done', req: nextRequest.req, value: result })
    assert.deepEqual(await next, result)
  })

  it('settles a pending subscription on disposal and retains the healthy connection', async t => {
    const f = connection(); t.after(() => f.client.close()); await f.client.ready
    const sub = f.client.sub({ node: '/' }, () => {})
    const ended = assert.rejects(sub.ready, code('CANCELLED'))
    sub.close(); await ended
    assert.deepEqual(f.sent.at(-1), { t: 'unsub', sub: sub.id })
    const pending = f.client.commit({ changes: [] })
    f.push({ t: 'pos', pos, changes: [] }); f.push({ t: 'done', req: pending.id, pos })
    assert.deepEqual(await pending.outcome, { pos, value: undefined })
  })

  it('keeps a disposed subscription absent when its produced snapshot arrives late', async t => {
    const root = createMemoryStore({ domain: 'client-late-snap' })
    let saved: Position | undefined
    const instance = await createInstanceFoundation({ id: 'client-late-snap', root, writerEpoch: 1,
      counter: { async load() { return saved }, async save(value) { saved = value }, async freshEpoch(floor) { return floor + 1 } },
      domains: [{ store: root, epoch: 'late1', persistent: true }], budget: scanBudget,
      firstAdmin: { path: '/admin', name: 'admin', password: 'client-password' }, initialCredential: { ttlMs: 60_000 } })
    t.after(() => instance.auth.close())
    assert.ok(instance.setupCredential)
    const lane = createNodeLane(instance.nodeLaneOptions(await instance.auth.openCredential(instance.setupCredential)))
    t.after(() => lane.close())
    function signal() {
      let resolve: () => void = () => {}
      const promise = new Promise<void>(done => { resolve = done })
      return { promise, resolve }
    }
    const captured = signal(), release = signal(), applied = signal(), ordinary = signal()
    const frames: AsyncIterable<Frame> = { async *[Symbol.asyncIterator]() {
      for await (const frame of lane.frames) {
        if (frame.t === 'snap') { captured.resolve(); await release.promise }
        try { yield frame }
        finally { if (frame.t === 'pos' && frame.coverage !== true) ordinary.resolve() }
        if (frame.t === 'pos' && frame.coverage === true) applied.resolve()
      }
    } }
    let unsubscribe: Extract<Request, { t: 'unsub' }> | undefined
    const wire: Connection = { frames, send(request) {
      if (request.t === 'sub') {
        assert.ok('node' in request.selector && request.selector.include === undefined)
        lane.accept({ t: 'sub', sub: request.sub, selector: { node: request.selector.node } })
      } else if (request.t === 'unsub') unsubscribe = request
      else if (request.t === 'read') {
        assert.ok(!('history' in request.selector))
        lane.accept({ t: 'read', req: request.req, selector: request.selector })
      }
      else assert.fail('Unexpected request')
    } }
    const client = createTwpClient(wire, { close: () => lane.close() }); t.after(() => client.close())
    await client.ready
    const sub = client.sub({ node: '/sys/limits' }, () => {})
    const refused = assert.rejects(sub.ready, code('CANCELLED'))
    await captured.promise; sub.close(); await refused
    const admin = instance.commands(await instance.auth.openCredential(instance.setupCredential))
    await admin.commit({ opId: { epoch: instance.writer.intake.epoch, time: Date.now(), nonce: 'limits-update' },
      changes: [{ op: 'patch', path: '/sys/limits', ops: { $set: { queryMs: 1100 } } }] })
    release.resolve(); await ordinary.promise
    assert.equal(client.cache.list(sub.id), undefined)
    assert.ok(unsubscribe); lane.accept(unsubscribe); await applied.promise
    assert.equal(client.cache.at('/sys/limits'), undefined)
    assert.equal(client.cache.list(sub.id), undefined)
    assert.deepEqual(client.cache.claims(), [])
    const read = await client.read({ node: '/sys/limits' })
    assert.ok('node' in read.copies[0]); assert.equal(read.copies[0].node.queryMs, 1100)
  })
})
