import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import type { ServerResponse } from 'node:http'
import { connect } from 'node:net'
import { describe, it, type TestContext } from 'node:test'
import { createTwpClient } from '#client/twp'
import { openTwpHttp } from '#client/http-twp'
import { KernelError } from '#errors'
import { createMemoryBlobStore } from '#kernel/blob-store-memory'
import { createInstance } from '#kernel/instance'
import { drainSession } from '#kernel/session-delivery'
import { createMemoryStore } from '#kernel/store/memory'
import type { Connection, Frame, ModuleManifest, OpId, Position, TypeDef } from '#kernel/types'
import { createTwpHttpServer } from '#server/http-twp'

const code = (expected: KernelError['code']) => (error: unknown) =>
  error instanceof KernelError && error.code === expected

/** Resolves when the real handler or accepted journal reaches the observed point. */
function event() {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

/** Opens real canonical sessions while leaving the caller's lane entirely pull-owned. */
async function fixture(t: TestContext, actions: TypeDef['actions']) {
  const id = `lane-stream:${randomUUID()}`
  const store = createMemoryStore({ domain: id })
  let position: Position | undefined
  let issued = 0
  const module: ModuleManifest = {
    id: 'lane-stream',
    types: [
      {
        name: 'lane.stream',
        module: 'lane-stream',
        version: 0,
        security: 'ordinary',
        schema: {},
        actions,
      },
    ],
    security: [],
    open: [],
  }
  const instance = await createInstance({
    id,
    root: { kind: 'store', store },
    modules: [module],
    blobs: createMemoryBlobStore(),
    provisioning: {
      counter: {
        async load() {
          return position
        },
        async save(value) {
          position = value
        },
        async freshEpoch(floor) {
          issued = Math.max(issued, floor) + 1
          return issued
        },
      },
      writerEpoch: 1,
      domains: [{ store, epoch: randomUUID(), persistent: false }],
      credentialTtlMs: 60_000,
      bootstrap: {
        kind: 'fresh',
        admin: { path: '/admin', name: 'admin', password: randomUUID() },
      },
    },
  })
  const deliveries: Promise<void>[] = []
  t.after(async () => {
    await instance.close()
    await Promise.all(deliveries)
  })
  assert.ok(instance.setupCredential)
  const admin = await instance.openSession(instance.setupCredential)
  deliveries.push(drainSession(admin))
  /** Creates mutation keys from this fixture's current writer intake. */
  const key = (): OpId => ({
    epoch: instance.writer.intake.epoch,
    time: Date.now(),
    nonce: randomUUID(),
  })
  await admin.commit({
    opId: key(),
    changes: [{ op: 'put', node: { $path: '/counter', $type: 'lane.stream', count: 0 } }],
  }).outcome
  const lane = await instance.openSession(instance.setupCredential)
  const welcome = await lane.frames.next()
  assert.ok(!welcome.done && welcome.value.t === 'welcome')

  /** Takes a frame from the actual caller without an additional lane pump. */
  async function frame(): Promise<Frame> {
    const result = await lane.frames.next()
    assert.equal(result.done, false)
    assert.ok(!result.done)
    return result.value
  }

  return { instance, store, admin, lane, key, frame }
}

/** Connects the actual lane and client while recording only the finite test's frame tags. */
async function clientFor(
  t: TestContext,
  f: Awaited<ReturnType<typeof fixture>>,
  mismatchRequest = false,
) {
  assert.ok(f.instance.setupCredential)
  const lane = await f.instance.openSession(f.instance.setupCredential)
  const seen: Frame['t'][] = []
  const connection: Connection = {
    frames: {
      async *[Symbol.asyncIterator]() {
        for await (const frame of lane.frames) {
          seen.push(frame.t)
          yield frame
        }
      },
    },
    send(request) {
      assert.notEqual(request.t, 'hi')
      assert.ok(request.t !== 'hi')
      if (mismatchRequest && request.t === 'act')
        lane.accept({ ...request, req: 'different-request' })
      else lane.accept(request)
    },
  }
  const client = createTwpClient(connection, { close: () => lane.close() })
  t.after(() => client.close())
  await client.ready
  return { client, seen }
}

/** Serves the genuine instance on an ephemeral loopback address. */
async function httpFor(t: TestContext, f: Awaited<ReturnType<typeof fixture>>) {
  const http = createTwpHttpServer({
    instance: f.instance,
    allowedOrigins: ['http://stream.test'],
    credentialTtlMs: 60_000,
  })
  t.after(() => http.close())
  http.server.listen(0, '127.0.0.1')
  await once(http.server, 'listening')
  const address = http.server.address()
  assert.ok(address !== null && typeof address === 'object')
  assert.ok(f.instance.setupCredential)
  const connection = await openTwpHttp({
    url: `http://127.0.0.1:${address.port}`,
    credential: f.instance.setupCredential,
  })
  t.after(connection.close)
  return { http, connection, port: address.port, credential: f.instance.setupCredential }
}

describe('stream pieces through the owning native lane', { timeout: 10_000 }, () => {
  it('takes each wire piece only after coverage and holds the next generator step', async (t) => {
    let resumed = 0
    const f = await fixture(t, {
      progress: {
        kind: 'write',
        args: {},
        async *handler(ctx) {
          resumed++
          ctx.change.patch('/counter', { $set: { count: 1 } })
          yield 'first'
          resumed++
          ctx.change.patch('/counter', { $set: { count: 2 } })
          yield 'second'
          resumed++
          return 'finished'
        },
      },
    })
    f.lane.accept({
      t: 'act',
      req: 'progress',
      path: '/counter',
      action: 'progress',
      args: {},
      opId: f.key(),
    })
    const firstPosition = await f.frame()
    assert.ok(firstPosition.t === 'pos' && firstPosition.coverage !== true)
    assert.equal(resumed, 1)
    const firstNode = (await f.admin.read({ node: '/counter' })).copies[0]
    assert.ok('node' in firstNode)
    assert.equal(firstNode.node.count, 1)

    const firstPiece = await f.frame()
    assert.ok(firstPiece.t === 'chunk')
    assert.equal(firstPiece.req, 'progress')
    assert.equal(firstPiece.data, 'first')
    const secondPosition = await f.frame()
    assert.ok(secondPosition.t === 'pos' && secondPosition.coverage !== true)
    assert.equal(resumed, 2)
    assert.notDeepEqual(secondPosition.pos, firstPosition.pos)
    const secondPiece = await f.frame()
    assert.ok(secondPiece.t === 'chunk')
    assert.equal(secondPiece.req, 'progress')
    assert.equal(secondPiece.data, 'second')
    const finalPosition = await f.frame()
    assert.ok(finalPosition.t === 'pos' && finalPosition.coverage !== true)
    const done = await f.frame()
    assert.ok(done.t === 'done')
    assert.equal(done.req, 'progress')
    assert.deepEqual(done.pos, finalPosition.pos)
    assert.equal(done.value, 'finished')
    assert.equal(resumed, 3)
  })

  it('bounds an unread client piece and applies its covering cache position before delivery', async (t) => {
    let resumed = 0
    const f = await fixture(t, {
      progress: {
        kind: 'write',
        args: {},
        async *handler(ctx) {
          for (let count = 1; count <= 3; count++) {
            resumed++
            ctx.change.patch('/counter', { $set: { count } })
            yield count
          }
          return 'finished'
        },
      },
    })
    const second = event(),
      third = event()
    const unobserve = f.instance.writer.stream.observe((record) => {
      if (record.t !== 'commit') return
      for (const entry of record.record.entries) {
        if (entry.path !== '/counter' || entry.change.t !== 'update') continue
        if (entry.change.delta.count?.to === 2) second.resolve()
        if (entry.change.delta.count?.to === 3) third.resolve()
      }
    })
    t.after(unobserve)
    const c = await clientFor(t, f)
    const sub = c.client.sub({ node: '/counter' }, () => {})
    await sub.ready
    const pending = c.client.act({ path: '/counter', action: 'progress', args: {} })
    await second.promise
    assert.equal(resumed, 2)
    assert.equal(c.seen.filter((tag) => tag === 'chunk').length, 1)
    const first = c.client.cache.at('/counter')
    assert.ok(first && 'node' in first)
    assert.equal(first.node.count, 1)
    const accepted = (await f.admin.read({ node: '/counter' })).copies[0]
    assert.ok('node' in accepted)
    assert.equal(accepted.node.count, 2)

    const pieces = pending.chunks[Symbol.asyncIterator]()
    assert.deepEqual(await pieces.next(), { done: false, value: 1 })
    await third.promise
    assert.equal(resumed, 3)
    assert.equal(c.seen.filter((tag) => tag === 'chunk').length, 2)
    const secondCopy = c.client.cache.at('/counter')
    assert.ok(secondCopy && 'node' in secondCopy)
    assert.equal(secondCopy.node.count, 2)
    assert.deepEqual(await pieces.next(), { done: false, value: 2 })
    assert.deepEqual(await pieces.next(), { done: false, value: 3 })
    assert.deepEqual(await pieces.next(), { done: true, value: undefined })
    const done = await pending.outcome
    assert.equal(done.value, 'finished')
    assert.ok(done.pos)
    assert.deepEqual(c.client.cache.watermark(done.pos.instance), done.pos)
    assert.equal(c.client.failure(), undefined)
  })

  it('returning a client piece consumer cancels only its request and wakes another read', async (t) => {
    const second = event(),
      ended = event()
    let returned = 0
    const f = await fixture(t, {
      progress: {
        kind: 'read',
        args: {},
        async *handler() {
          try {
            yield 'first'
            second.resolve()
            yield 'second'
            assert.fail('Cancelled generator resumed')
          } finally {
            returned++
            ended.resolve()
          }
        },
      },
    })
    const c = await clientFor(t, f)
    const pending = c.client.act({ path: '/counter', action: 'progress', args: {} })
    const cancelled = assert.rejects(pending.outcome, code('CANCELLED'))
    await second.promise
    const read = c.client.read({ node: '/counter' })
    const pieces = pending.chunks[Symbol.asyncIterator]()
    assert.ok(pieces.return)
    await pieces.return()
    await cancelled
    await ended.promise
    assert.equal(returned, 1)
    const result = await read
    assert.ok('node' in result.copies[0])
    assert.equal(result.copies[0].node.count, 0)
    assert.equal(c.client.failure(), undefined)
  })

  it('rejects a genuinely produced piece whose request differs from the client owner', async (t) => {
    const f = await fixture(t, {
      progress: {
        kind: 'read',
        args: {},
        async *handler() {
          yield 'first'
          return 'finished'
        },
      },
    })
    const c = await clientFor(t, f, true)
    const pending = c.client.act({ path: '/counter', action: 'progress', args: {} })
    await assert.rejects(pending.outcome, code('INVALID'))
    assert.equal(c.client.failure()?.code, 'INVALID')
    assert.deepEqual(c.client.cache.claims(), [])
  })

  it('refuses a wire stream in the ordinary direct-session pump', async (t) => {
    const ended = event()
    let returned = 0
    const f = await fixture(t, {
      progress: {
        kind: 'read',
        args: {},
        async *handler() {
          try {
            yield 'first'
            assert.fail('Unowned stream resumed')
          } finally {
            returned++
            ended.resolve()
          }
        },
      },
    })
    const refused = assert.rejects(drainSession(f.lane), code('INVALID'))
    f.lane.accept({
      t: 'act',
      req: 'unowned',
      path: '/counter',
      action: 'progress',
      args: {},
      opId: f.key(),
    })
    await refused
    await ended.promise
    assert.equal(returned, 1)
    assert.throws(() => f.lane.read({ node: '/counter' }), code('CANCELLED'))
  })

  it('keeps the canonical accepted wire outcome when its client cancels before publication', async (t) => {
    const accepted = event(),
      publish = event()
    t.after(() => publish.resolve())
    const f = await fixture(t, {
      progress: {
        kind: 'write',
        args: {},
        async *handler(ctx) {
          ctx.change.patch('/counter', { $set: { count: 1 } })
          yield 'first'
          ctx.change.patch('/counter', { $set: { count: 2 } })
          return 'finished'
        },
      },
    })
    const c = await clientFor(t, f)
    const subscription = c.client.sub({ node: '/counter' }, () => {})
    await subscription.ready
    const opId = c.client.key()
    const persist = f.store.commit.bind(f.store)
    t.mock.method(f.store, 'commit', async (commit: Parameters<typeof persist>[0]) => {
      await persist(commit)
      if (
        commit.record.decision?.opId.nonce === opId.nonce &&
        commit.record.decision.outcome !== undefined
      ) {
        accepted.resolve()
        await publish.promise
      }
    })
    const pending = c.client.act({ path: '/counter', action: 'progress', args: {}, opId })
    assert.deepEqual(await pending.chunks[Symbol.asyncIterator]().next(), {
      done: false,
      value: 'first',
    })
    await accepted.promise
    c.client.cancel(pending.id)
    publish.resolve()
    const outcome = await pending.outcome
    assert.equal(outcome.value, 'finished')
    assert.ok(outcome.pos)
    assert.deepEqual(c.client.cache.watermark(outcome.pos.instance), outcome.pos)
    const result = await c.client.read({ node: '/counter' })
    assert.ok('node' in result.copies[0])
    assert.equal(result.copies[0].node.count, 2)
    assert.equal(c.client.failure(), undefined)
  })

  it('delivers accepted writing pieces and their final value through actual HTTP and client', async (t) => {
    const f = await fixture(t, {
      progress: {
        kind: 'write',
        args: {},
        async *handler(ctx) {
          ctx.change.patch('/counter', { $set: { count: 1 } })
          yield 'first'
          ctx.change.patch('/counter', { $set: { count: 2 } })
          yield 'second'
          return 'finished'
        },
      },
    })
    const h = await httpFor(t, f)
    const client = createTwpClient(h.connection, { close: h.connection.close })
    t.after(() => client.close())
    await client.ready
    const subscription = client.sub({ node: '/counter' }, () => {})
    await subscription.ready
    const pending = client.act({ path: '/counter', action: 'progress', args: {} })
    const pieces: unknown[] = []
    const [outcome] = await Promise.all([
      pending.outcome,
      (async () => {
        for await (const piece of pending.chunks) pieces.push(piece)
      })(),
    ])
    assert.deepEqual(pieces, ['first', 'second'])
    assert.equal(outcome.value, 'finished')
    assert.ok(outcome.pos)
    assert.deepEqual(client.cache.watermark(outcome.pos.instance), outcome.pos)
    const copy = client.cache.at('/counter')
    assert.ok(copy && 'node' in copy)
    assert.equal(copy.node.count, 2)
    assert.equal(client.failure(), undefined)
  })

  it('holds the next native wire pull until an actual paused HTTP socket drains', async (t) => {
    const second = event(),
      finished = event()
    let resumed = 0
    const payload = 'x'.repeat(8 * 1024 * 1024)
    const f = await fixture(t, {
      progress: {
        kind: 'read',
        args: {},
        async *handler() {
          for (let step = 1; step <= 3; step++) {
            resumed++
            if (step === 2) second.resolve()
            yield payload
          }
          resumed++
          finished.resolve()
          return 'finished'
        },
      },
    })
    await f.admin.commit({
      opId: f.key(),
      changes: [
        { op: 'patch', path: '/sys/limits', ops: { $set: { requestBytes: 16 * 1024 * 1024 } } },
      ],
    }).outcome
    const h = await httpFor(t, f)
    let response: ServerResponse | undefined
    h.http.server.on('request', (request, output) => {
      if (request.url?.startsWith('/twp/lane/')) response = output
    })
    const socket = connect(h.port, '127.0.0.1')
    t.after(() => socket.destroy())
    await once(socket, 'connect')
    socket.write(
      `GET /twp/lane/${h.connection.lane} HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${h.credential.token}\r\nConnection: close\r\n\r\n`,
    )
    await once(socket, 'data')
    socket.pause()
    h.connection.send({
      t: 'act',
      req: 'slow-http',
      path: '/counter',
      action: 'progress',
      args: {},
      opId: f.key(),
    })
    await second.promise
    assert.equal(resumed, 2)
    assert.ok(response)
    assert.equal(response.writableNeedDrain, true)

    const drained = once(response, 'drain')
    socket.resume()
    await drained
    await finished.promise
    assert.equal(resumed, 4)
    const unchanged = (await f.admin.read({ node: '/counter' })).copies[0]
    assert.ok('node' in unchanged)
    assert.equal(unchanged.node.count, 0)
  })
})
