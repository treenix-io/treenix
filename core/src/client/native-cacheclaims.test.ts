import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { describe, it, type TestContext } from 'node:test'
import { openTwpHttp, type TwpHttpClientOptions } from '#client/http-twp'
import { createLaneCache, type LaneCache } from '#client/lane-cache'
import { createTwpClient } from '#client/twp'
import { KernelError } from '#errors'
import { createMemoryBlobStore } from '#kernel/blob-store-memory'
import { createInstance } from '#kernel/instance'
import { drainSession } from '#kernel/session-delivery'
import { createMemoryStore } from '#kernel/store/memory'
import {
  R,
  W,
  type CacheClaim,
  type ChangeMember,
  type Connection,
  type Credential,
  type Frame,
  type ModuleManifest,
  type NodeCopy,
  type OpId,
  type Position,
  type Request,
} from '#kernel/types'
import { createTwpServing } from '#protocol/serve'
import { decodeRequests } from '#protocol/twp'
import { createTwpHttpServer } from '#server/http-twp'

/** Installs real native data and drains only the administrator's independent lane. */
async function fixture(t: TestContext) {
  const id = `cache-claims:${randomUUID()}`
  const store = createMemoryStore({ domain: id })
  let saved: Position | undefined
  let issued = 0
  const password = randomUUID()
  const module: ModuleManifest = {
    id: 'cache-claims',
    security: [],
    open: [],
    types: [
      {
        name: 'claims.item',
        module: 'cache-claims',
        version: 0,
        security: 'ordinary',
        schema: {},
        actions: {},
      },
    ],
  }
  const instance = await createInstance({
    id,
    root: { kind: 'store', store },
    modules: [module],
    blobs: createMemoryBlobStore(),
    provisioning: {
      counter: {
        async load() { return saved },
        async save(position) { saved = position },
        async freshEpoch(floor) { issued = Math.max(issued, floor) + 1; return issued },
      },
      writerEpoch: 1,
      domains: [{ store, epoch: randomUUID(), persistent: false }],
      credentialTtlMs: 60_000,
      bootstrap: { kind: 'fresh', admin: { path: '/admin', name: 'admin', password } },
    },
  })
  const serving = createTwpServing(instance)
  const deliveries: Promise<void>[] = []
  t.after(async () => {
    serving.close()
    await instance.close()
    await Promise.all(deliveries)
  })
  assert.ok(instance.setupCredential)
  const credential = instance.setupCredential
  const admin = await instance.openSession(credential)
  deliveries.push(drainSession(admin))
  const key = (): OpId => ({
    epoch: instance.writer.intake.epoch,
    time: Date.now(),
    nonce: randomUUID(),
  })
  await admin.commit({
    opId: key(),
    changes: [
      {
        op: 'put',
        node: {
          $path: '/items',
          $type: 't.dir',
          $acl: [{ subject: { group: 'public' }, grant: R }],
        },
      },
      { op: 'put', node: { $path: '/items/a', $type: 'claims.item', value: 1 } },
      {
        op: 'put',
        node: {
          $path: '/stable',
          $type: 'claims.item',
          value: 7,
          $acl: [{ subject: { group: 'public' }, grant: R }],
        },
      },
    ],
  }).outcome
  const commit = (changes: readonly ChangeMember[]) => admin.commit({ opId: key(), changes }).outcome
  return { instance, serving, admin, credential, key, commit, store, module, password }
}

interface ClientOptions {
  readonly cache?: LaneCache
  readonly claims?: readonly CacheClaim[]
}

/** Observes only frames delivered by the actual connection. */
function record(connection: Connection) {
  const seen: Frame[] = []
  const observed: Connection = {
    frames: {
      async *[Symbol.asyncIterator]() {
        for await (const frame of connection.frames) {
          seen.push(frame)
          yield frame
        }
      },
    },
    send: connection.send,
  }
  return { connection: observed, seen }
}

/** Records actual served frames while leaving their production and correlation unchanged. */
async function connectClient(
  t: TestContext,
  f: Awaited<ReturnType<typeof fixture>>,
  credential: Credential | undefined,
  options: ClientOptions = {},
) {
  const origin = '127.0.0.1'
  const claims = options.claims ?? options.cache?.reconnectClaims(credential)
  const opened = await f.serving.open(
    { t: 'hi', ...(claims === undefined ? {} : { cache: claims }) },
    credential,
    origin,
  )
  const effective = credential ?? opened.credential
  assert.ok(effective)
  const attached = f.serving.attach(opened.id, effective, origin)
  const { seen, connection } = record({
    frames: attached.frames,
    send(request: Request) { f.serving.dispatch(opened.id, effective, origin, [request]) },
  })
  const client = createTwpClient(connection, {
    close: attached.close,
    cache: options.cache,
    credential: effective,
  })
  t.after(() => client.close())
  await client.ready
  return { client, seen, origin, credential: effective, connection, attached }
}

/** Opens the native POST/SSE server on an actual ephemeral loopback socket. */
async function listen(
  t: TestContext,
  f: Awaited<ReturnType<typeof fixture>>,
  onHello?: (body: Buffer) => void,
) {
  const http = createTwpHttpServer({
    instance: f.instance,
    allowedOrigins: ['http://claims.test'],
    credentialTtlMs: 60_000,
  })
  if (onHello !== undefined) http.server.on('request', request => {
    if (request.method === 'POST' && request.url === '/twp' && request.headers['twp-lane'] === undefined) {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.once('end', () => onHello(Buffer.concat(chunks)))
    }
  })
  t.after(() => http.close())
  http.server.listen(0, '127.0.0.1')
  await once(http.server, 'listening')
  const address = http.server.address()
  assert.ok(address !== null && typeof address === 'object')
  return `http://127.0.0.1:${address.port}`
}

/** Connects the borrowed cache through actual HTTP handshake and SSE delivery. */
async function connectHttp(
  t: TestContext,
  url: string,
  options: Omit<TwpHttpClientOptions, 'url'>,
) {
  const transport = await openTwpHttp({ ...options, url })
  const { seen, connection } = record(transport)
  const client = createTwpClient(connection, {
    close: transport.close,
    cache: options.cache,
    credential: options.credential,
  })
  t.after(() => client.close())
  await client.ready
  return { client, seen }
}

/** Gets the actual snapshot for one correlated subscription. */
function snapshot(seen: readonly Frame[], id: string) {
  let found: Extract<Frame, { t: 'snap' }> | undefined
  for (const frame of seen) if (frame.t === 'snap' && frame.sub === id) found = frame
  assert.ok(found)
  return found
}

/** Requires a visible ordinary copy and exposes its typed native node. */
function node(copy: NodeCopy | undefined) {
  assert.ok(copy && 'node' in copy)
  return copy.node
}

/** Matches an expected kernel error code. */
const code = (expected: KernelError['code']) => (error: unknown) =>
  error instanceof KernelError && error.code === expected

describe('authenticated native cache claims', { timeout: 10_000 }, () => {
  it('accepts the actual prior lane claims under the same explicit credential', async t => {
    const f = await fixture(t)
    const previous = await connectClient(t, f, f.credential)
    const subscription = previous.client.sub({ node: '/items/a' }, () => {})
    await subscription.ready
    const copy = previous.client.cache.at('/items/a')
    assert.ok(copy && 'node' in copy)
    assert.equal(copy.node.value, 1)
    const claims = previous.client.cache.claims()
    assert.equal(claims.length, 1)
    assert.deepEqual(claims[0], { id: copy.node.$id, ver: copy.ver })
    previous.client.close()

    const reopened = await f.serving.open({ t: 'hi', cache: claims }, f.credential, previous.origin)
    assert.ok(reopened.id)
    f.serving.attach(reopened.id, f.credential, previous.origin).close()
  })

  it('omits matching ordinary copies while adopting only current authenticated coverage', async t => {
    const f = await fixture(t), cache = createLaneCache()
    const previous = await connectClient(t, f, f.credential, { cache })
    const first = previous.client.sub({ node: '/items/a' }, () => {})
    await first.ready
    const original = cache.at('/items/a')
    assert.ok(original)
    const instanceId = snapshot(previous.seen, first.id).at[0].instance
    previous.client.close()
    assert.equal(cache.at('/items/a'), undefined)
    assert.equal(cache.list(first.id), undefined)
    assert.equal(cache.watermark(instanceId), undefined)
    assert.equal(cache.claims().length, 0)

    const current = await connectClient(t, f, f.credential, { cache })
    assert.equal(cache.at('/items/a'), undefined)
    const watching = current.client.sub({ node: '/items/a' }, () => {})
    await watching.ready
    const snap = snapshot(current.seen, watching.id)
    assert.deepEqual(snap.copies, [])
    assert.deepEqual(snap.covered, snap.list)
    assert.deepEqual(cache.at('/items/a'), original)
    assert.deepEqual(cache.list(watching.id)?.ids, snap.list)
    assert.deepEqual(cache.list(watching.id)?.covered, snap.list)
    await f.commit([{ op: 'patch', path: '/items/a', ops: { $inc: { value: 1 } } }])
    await current.client.read({ node: '/items' })
    assert.equal(node(cache.at('/items/a')).value, 2)
    assert.equal(current.client.failure(), undefined)
  })

  it('sends the changed image after revision or rights differ from a retained claim', async t => {
    const f = await fixture(t), cache = createLaneCache()
    const previous = await connectClient(t, f, undefined, { cache })
    const first = previous.client.sub({ node: '/items/a' }, () => {})
    await first.ready
    const original = cache.at('/items/a')
    assert.ok(original)
    previous.client.close()
  await f.commit([
    { op: 'patch', path: '/items/a', ops: { $set: { value: 9 } } },
    {
      op: 'patch',
      path: '/items',
      ops: { $set: { $acl: [{ subject: { group: 'public' }, grant: R | W }] } },
    },
  ])
    const current = await connectClient(t, f, previous.credential, { cache })
    const watching = current.client.sub({ node: '/items/a' }, () => {})
    await watching.ready
    const snap = snapshot(current.seen, watching.id)
    assert.equal(snap.copies.length, 1)
    assert.notEqual(snap.copies[0].ver, original.ver)
    assert.ok('node' in snap.copies[0])
    assert.equal(snap.copies[0].bits, R | W)
    assert.equal(node(cache.at('/items/a')).value, 9)
  })

  it('sends current rights when the claimed node revision itself is unchanged', async t => {
    const f = await fixture(t), cache = createLaneCache()
    const previous = await connectClient(t, f, undefined, { cache })
    const first = previous.client.sub({ node: '/items/a' }, () => {})
    await first.ready
    const original = cache.at('/items/a')
    assert.ok(original)
    const revision = node(original).$rev
    previous.client.close()
  await f.commit([
    {
      op: 'patch',
      path: '/items',
      ops: { $set: { $acl: [{ subject: { group: 'public' }, grant: R | W }] } },
    },
  ])

    const current = await connectClient(t, f, previous.credential, { cache })
    const watching = current.client.sub({ node: '/items/a' }, () => {})
    await watching.ready
    const snap = snapshot(current.seen, watching.id)
    assert.equal(snap.copies.length, 1)
    assert.equal(node(snap.copies[0]).$rev, revision)
    assert.notEqual(snap.copies[0].ver, original.ver)
    assert.ok('node' in snap.copies[0])
    assert.equal(snap.copies[0].bits, R | W)
  })

  it('does not adopt a claimed node hidden before its new subscription starts', async t => {
    const f = await fixture(t), cache = createLaneCache()
    const previous = await connectClient(t, f, undefined, { cache })
    const first = previous.client.sub({ children: '/items' }, () => {})
    await first.ready
    const id = node(cache.at('/items/a')).$id
    previous.client.close()
  await f.commit([
    {
      op: 'patch',
      path: '/items/a',
      ops: { $set: { $acl: [{ subject: { group: 'public' }, deny: R }] } },
    },
  ])
    const current = await connectClient(t, f, previous.credential, { cache })
    const watching = current.client.sub({ children: '/items' }, () => {})
    await watching.ready
    const snap = snapshot(current.seen, watching.id)
    assert.deepEqual(snap.list, [])
    assert.deepEqual(snap.covered, [])
    assert.deepEqual(snap.copies, [])
    assert.equal(cache.copy(id), undefined)
    assert.equal(cache.at('/items/a'), undefined)
    await assert.rejects(current.client.read({ node: '/items/a' }), code('NOT_FOUND'))
  })

  it('sends a new projection after the published schema changes', async t => {
    const f = await fixture(t), cache = createLaneCache()
    const previous = await connectClient(t, f, f.credential, { cache })
    const first = previous.client.sub({ node: '/items/a' }, () => {})
    await first.ready
    const original = cache.at('/items/a')
    assert.ok(original)
    previous.client.close()
    f.instance.registry.publish({ ...f.module, types: f.module.types.map(def => ({ ...def,
      schema: { type: 'object', required: ['value'], properties: { value: { type: 'number' } } },
    })) })
    const current = await connectClient(t, f, f.credential, { cache })
    const watching = current.client.sub({ node: '/items/a' }, () => {})
    await watching.ready
    const snap = snapshot(current.seen, watching.id)
    assert.equal(snap.copies.length, 1)
    assert.notEqual(snap.copies[0].ver, original.ver)
    assert.equal(node(cache.at('/items/a')).value, 1)
  })

  it('always sends malformed copies with the sort fields of the current selector', async t => {
    const f = await fixture(t), cache = createLaneCache()
    f.instance.registry.publish({ ...f.module, types: f.module.types.map(def => ({ ...def,
      schema: { type: 'object', properties: { value: { type: 'string' } } },
    })) })
    const previous = await connectClient(t, f, f.credential, { cache })
    const first = previous.client.sub({ children: '/items', sort: [['value', 1]] }, () => {})
    await first.ready
    const original = cache.at('/items/a')
    assert.ok(original && 'error' in original)
    assert.equal(original.error.code, 'INVALID')
    previous.client.close()
    const current = await connectClient(t, f, f.credential, { cache })
    const watching = current.client.sub({ children: '/items', sort: [['$path', 1]] }, () => {})
    await watching.ready
    const snap = snapshot(current.seen, watching.id)
    assert.equal(snap.copies.length, 1)
    const copy = snap.copies[0]
    assert.ok('error' in copy)
    assert.equal(copy.error.code, 'INVALID')
    assert.ok(copy.sort)
    assert.equal(copy.sort.$path, '/items/a')
  })

  it('retains overlapping claimed coverage and sends a full copy after the last unsubscribe', async t => {
    const f = await fixture(t), cache = createLaneCache()
    const previous = await connectClient(t, f, f.credential, { cache })
    const first = previous.client.sub({ node: '/items/a' }, () => {})
    await first.ready
    const id = node(cache.at('/items/a')).$id
    previous.client.close()
    const current = await connectClient(t, f, f.credential, { cache })
    const direct = current.client.sub({ node: '/items/a' }, () => {})
    await direct.ready
    assert.deepEqual(snapshot(current.seen, direct.id).copies, [])
    const children = current.client.sub({ children: '/items' }, () => {})
    await children.ready
    direct.close()
    await current.client.read({ node: '/items' })
    assert.equal(node(cache.copy(id)).value, 1)
    assert.deepEqual(cache.list(children.id)?.covered, [id])
    children.close()
    await current.client.read({ node: '/items' })
    assert.equal(cache.copy(id), undefined)
    assert.ok(
      current.seen.some(
        frame =>
          frame.t === 'pos' &&
          frame.coverage === true &&
          frame.changes.some(change => change.op === 'del' && change.id === id),
      ),
    )
    const again = current.client.sub({ node: '/items/a' }, () => {})
    await again.ready
    assert.equal(snapshot(current.seen, again.id).copies.length, 1)
    assert.equal(node(cache.copy(id)).value, 1)
  })

  it('consumes a retained claim when an include first arrives through an ordinary put', async t => {
    const f = await fixture(t), cache = createLaneCache()
    const previous = await connectClient(t, f, f.credential, { cache })
    const oldRoot = previous.client.sub({ node: '/items/a' }, () => {})
    const oldFriend = previous.client.sub({ node: '/stable' }, () => {})
    await Promise.all([oldRoot.ready, oldFriend.ready])
    const friendId = node(cache.at('/stable')).$id
    previous.client.close()
    const current = await connectClient(t, f, f.credential, { cache })
    const root = current.client.sub({ node: '/items/a', include: [{ ref: 'friend' }] }, () => {})
    await root.ready
    assert.equal(cache.copy(friendId), undefined)
    await f.commit([{ op: 'patch', path: '/items/a', ops: { $set: { friend: '/stable' } } }])
    await current.client.read({ node: '/items' })
    assert.equal(node(cache.copy(friendId)).value, 7)
    assert.ok(
      current.seen.some(
        frame =>
          frame.t === 'pos' &&
          frame.changes.some(
            change =>
              change.op === 'put' &&
              'node' in change.copy &&
              change.copy.node.$id === friendId,
          ),
      ),
    )
    await f.commit([{ op: 'patch', path: '/items/a', ops: { $unset: { friend: true } } }])
    await current.client.read({ node: '/items' })
    assert.equal(cache.copy(friendId), undefined)
    const friend = current.client.sub({ node: '/stable' }, () => {})
    await friend.ready
    assert.equal(snapshot(current.seen, friend.id).copies.length, 1)
    assert.equal(node(cache.copy(friendId)).value, 7)
    assert.equal(current.client.failure(), undefined)
  })

  it('starts with full current copies after a principal changes instead of adopting old candidates', async t => {
    const f = await fixture(t), cache = createLaneCache()
    const previous = await connectClient(t, f, f.credential, { cache })
    const first = previous.client.sub({ node: '/items/a' }, () => {})
    await first.ready
    previous.client.close()
    const issued = await f.serving.open({ t: 'hi' }, undefined, '127.0.0.1')
    assert.ok(issued.credential)
    f.serving.attach(issued.id, issued.credential, '127.0.0.1').close()
    const current = await connectClient(t, f, issued.credential, { cache })
    assert.notEqual((await current.client.ready).principal, `u:${f.instance.bootstrap.adminId}`)
    assert.equal(cache.at('/items/a'), undefined)
    const watching = current.client.sub({ node: '/items/a' }, () => {})
    await watching.ready
    const snap = snapshot(current.seen, watching.id)
    assert.equal(snap.copies.length, 1)
    assert.ok('node' in snap.copies[0])
    assert.equal(snap.copies[0].bits, R)
    assert.equal(node(cache.at('/items/a')).$acl, undefined)
  })

  it('rejects duplicate or oversized claims before reserving a new lane', async t => {
    const f = await fixture(t)
    const previous = await connectClient(t, f, f.credential)
    const watching = previous.client.sub({ node: '/items/a' }, () => {})
    await watching.ready
    const [claim] = previous.client.cache.claims()
    assert.ok(claim)
    previous.client.close()
    await f.commit([{ op: 'patch', path: '/sys/limits', ops: { $set: { maxLanes: 2 } } }])
    await assert.rejects(
      f.serving.open({ t: 'hi', cache: [claim, claim] }, f.credential, previous.origin),
      code('INVALID'),
    )
    await assert.rejects(
      f.serving.open(
        { t: 'hi', cache: [{ ...claim, ver: claim.ver.repeat(10_000) }] },
        f.credential,
        previous.origin,
      ),
      code('BUDGET'),
    )
    const reopened = await f.serving.open({ t: 'hi', cache: [claim] }, f.credential, previous.origin)
    assert.ok(reopened.id)
    f.serving.attach(reopened.id, f.credential, previous.origin).close()
  })

  it('refuses a second consumer of an active cache and releases ownership for a real reconnect', async t => {
    const f = await fixture(t), cache = createLaneCache()
    const previous = await connectClient(t, f, f.credential, { cache })
    const watching = previous.client.sub({ node: '/items/a' }, () => {})
    await watching.ready
    assert.throws(() => cache.reconnectClaims(f.credential), code('CONFLICT'))
    const opened = await f.serving.open({ t: 'hi' }, f.credential, previous.origin)
    const extra = f.serving.attach(opened.id, f.credential, previous.origin)
    assert.throws(
      () =>
        createTwpClient(
          {
            frames: extra.frames,
            send(request) {
              f.serving.dispatch(opened.id, f.credential, previous.origin, [request])
            },
          },
          { cache, credential: f.credential, close: extra.close },
        ),
      code('CONFLICT'),
    )
    extra.close()
    previous.client.close()
    const current = await connectClient(t, f, f.credential, { cache })
    const next = current.client.sub({ node: '/items/a' }, () => {})
    await next.ready
    assert.deepEqual(snapshot(current.seen, next.id).copies, [])
    assert.equal(node(cache.at('/items/a')).value, 1)
  })

  it('keeps a claimed image pinned under real cache pressure and releases its last coverage', async t => {
    const f = await fixture(t), cache = createLaneCache()
    const previous = await connectClient(t, f, f.credential, { cache })
    const first = previous.client.sub({ node: '/items/a' }, () => {})
    await first.ready
    const id = node(cache.at('/items/a')).$id
    previous.client.close()
    const current = await connectClient(t, f, f.credential, { cache })
    const watching = current.client.sub({ node: '/items/a' }, () => {})
    await watching.ready
    assert.deepEqual(snapshot(current.seen, watching.id).copies, [])
    await f.commit([{ op: 'put', node: { $path: '/pressure', $type: 't.dir' } }])
    const payload = 'x'.repeat(150_000)
    for (let offset = 0; offset < 64; offset += 2) {
      await f.commit(
        [offset, offset + 1].map(index => ({
          op: 'put',
          node: { $path: `/pressure/${index}`, $type: 't.dir', payload },
        })),
      )
    }
    await current.client.read({ node: '/items' })
    assert.ok(f.instance.writer.cache.get(id))
    assert.equal(node(cache.copy(id)).value, 1)
    watching.close()
    await current.client.read({ node: '/items' })
    assert.equal(cache.copy(id), undefined)

    const changed = 'y'.repeat(150_000)
    for (let offset = 64; offset < 128; offset += 2) {
      await f.commit(
        [offset, offset + 1].map(index => ({
          op: 'put',
          node: { $path: `/pressure/${index}`, $type: 't.dir', payload: changed },
        })),
      )
    }
    assert.equal(f.instance.writer.cache.get(id), undefined)
    const again = current.client.sub({ node: '/items/a' }, () => {})
    await again.ready
    assert.equal(snapshot(current.seen, again.id).copies.length, 1)
    assert.equal(node(cache.copy(id)).value, 1)
  })

  it('starts fresh projection generations without reviving consumed hello claims', async t => {
    const f = await fixture(t), cache = createLaneCache()
    const previous = await connectClient(t, f, f.credential, { cache })
    const first = previous.client.sub({ node: '/items/a' }, () => {})
    await first.ready
    previous.client.close()
    const current = await connectClient(t, f, f.credential, { cache })
    const watching = current.client.sub({ node: '/items/a' }, () => {})
    await watching.ready
    const initial = snapshot(current.seen, watching.id)
    assert.deepEqual(initial.copies, [])
    f.instance.registry.publish({ ...f.module, types: f.module.types.map(def => ({ ...def,
      schema: { type: 'object', required: ['value'], properties: { value: { type: 'number' } } },
    })) })
    await current.client.read({ node: '/items' })
    const renewed = snapshot(current.seen, watching.id)
    assert.ok(renewed.gen > initial.gen)
    assert.equal(renewed.copies.length, 1)
    assert.deepEqual(renewed.covered, initial.covered)
    assert.equal(cache.list(watching.id)?.gen, renewed.gen)
    assert.equal(node(cache.at('/items/a')).value, 1)
    assert.equal(current.client.failure(), undefined)
  })

  it('hands a borrowed cache to a real HTTP reconnect after its previous client closes', async t => {
    const f = await fixture(t), cache = createLaneCache()
    const url = await listen(t, f)
    const previous = await connectHttp(t, url, { cache, credential: f.credential })
    const first = previous.client.sub({ node: '/items/a' }, () => {})
    await first.ready
    await assert.rejects(openTwpHttp({ url, cache, credential: f.credential }), code('CONFLICT'))
    previous.client.close()
    assert.equal(cache.at('/items/a'), undefined)
    const current = await connectHttp(t, url, { cache, credential: f.credential })
    assert.equal(cache.list(first.id), undefined)
    assert.equal(cache.at('/items/a'), undefined)
    const watching = current.client.sub({ node: '/items/a' }, () => {})
    await watching.ready
    assert.deepEqual(snapshot(current.seen, watching.id).copies, [])
    assert.equal(node(cache.at('/items/a')).value, 1)

    previous.client.close()
    await f.commit([{ op: 'patch', path: '/items/a', ops: { $inc: { value: 1 } } }])
    await current.client.read({ node: '/items' })
    assert.equal(node(cache.at('/items/a')).value, 2)
    assert.equal(current.client.failure(), undefined)
  })

  it('sends full copies when HTTP authentication uses an ambient cookie without explicit identity', async t => {
    const f = await fixture(t), cache = createLaneCache()
    const url = await listen(t, f)
    const previous = await connectHttp(t, url, { cache, credential: f.credential })
    const first = previous.client.sub({ node: '/items/a' }, () => {})
    await first.ready
    previous.client.close()
    const login = await fetch(`${url}/auth/login`, { method: 'POST', headers: {
      'Content-Type': 'application/json', Origin: 'http://claims.test',
    }, body: JSON.stringify({ account: '/admin', password: f.password }) })
    assert.equal(login.status, 200)
    const cookie = login.headers.get('Set-Cookie')
    assert.ok(cookie)
    const current = await connectHttp(t, url, {
      cache,
      headers: { Cookie: cookie.split(';')[0], Origin: 'http://claims.test' },
    })
    assert.equal((await current.client.ready).principal, `u:${f.instance.bootstrap.adminId}`)
    assert.equal(cache.at('/items/a'), undefined)
    const watching = current.client.sub({ node: '/items/a' }, () => {})
    await watching.ready
    assert.equal(snapshot(current.seen, watching.id).copies.length, 1)
    assert.equal(node(cache.at('/items/a')).value, 1)
    assert.equal(current.client.failure(), undefined)
  })

  it('bounds actual HTTP claims while retaining full current data outside the offered prefix', async t => {
    const f = await fixture(t), cache = createLaneCache()
    await f.commit(Array.from({ length: 12 }, (_, index) => ({ op: 'put', node: {
      $path: `/items/claim${index}`, $type: 'claims.item', value: index,
    } })))
    await f.commit([{ op: 'patch', path: '/sys/limits', ops: { $set: { readNodes: 10 } } }])
    const previous = await connectClient(t, f, f.credential, { cache })
    for (let index = 0; index < 12; index++) {
      const subscription = previous.client.sub({ node: `/items/claim${index}` }, () => {})
      await subscription.ready
    }
    assert.equal(cache.claims().length, 12)
    previous.client.close()
    const bodies: Buffer[] = []
    const url = await listen(t, f, body => bodies.push(body))
    const options = { url, credential: f.credential, cache, limits: f.instance.limits() }
    const transport = await openTwpHttp(options)
    const { seen, connection } = record(transport)
    const current = createTwpClient(connection, {
      close: transport.close,
      cache,
      credential: f.credential,
    })
    t.after(() => current.close())
    await current.ready
    assert.equal(bodies.length, 1)
    assert.ok(bodies[0].byteLength <= options.limits.requestBytes)
    const requests = decodeRequests(bodies[0], options.limits.requestBytes)
    assert.equal(requests.length, 1)
    const hello = requests[0]
    assert.equal(hello.t, 'hi')
    assert.ok(hello.t === 'hi' && hello.cache)
    assert.ok(hello.cache.length > 0 && hello.cache.length <= options.limits.readNodes)
    assert.equal(hello.credential?.token, f.credential.token)
    const offered = new Set(hello.cache.map(claim => claim.id))
    let omitted = 0, full = 0
    for (let index = 0; index < 12; index++) {
      const subscription = current.sub({ node: `/items/claim${index}` }, () => {})
      await subscription.ready
      const snap = snapshot(seen, subscription.id)
      assert.equal(snap.list.length, 1)
      assert.deepEqual(snap.covered, snap.list)
      assert.equal(snap.copies.length, offered.has(snap.list[0]) ? 0 : 1)
      if (snap.copies.length === 0) omitted++
      else full++
      assert.equal(node(cache.at(`/items/claim${index}`)).value, index)
      assert.ok(f.instance.writer.cache.get(snap.list[0]))
    }
    assert.ok(omitted > 0 && full > 0)
    assert.equal(current.failure(), undefined)
  })

  it('includes the real issued credential envelope in the HTTP claim byte bound', async t => {
    const f = await fixture(t), cache = createLaneCache()
    await f.commit(Array.from({ length: 4 }, (_, index) => ({ op: 'put', node: {
      $path: `/items/byte${index}`, $type: 'claims.item', value: index,
    } })))
    const previous = await connectClient(t, f, undefined, { cache })
    for (let index = 0; index < 4; index++) {
      const subscription = previous.client.sub({ node: `/items/byte${index}` }, () => {})
      await subscription.ready
    }
    const claims = cache.claims()
    assert.equal(claims.length, 4)
    const byteLimit = Buffer.byteLength(
      JSON.stringify({ t: 'hi', credential: previous.credential, cache: claims.slice(0, 3) }),
    )
    previous.client.close()
    await f.commit([{ op: 'patch', path: '/sys/limits', ops: { $set: { requestBytes: byteLimit } } }])
    const bodies: Buffer[] = []
    const url = await listen(t, f, body => bodies.push(body))
    const options = { url, credential: previous.credential, cache, limits: f.instance.limits() }
    const transport = await openTwpHttp(options)
    const { seen, connection } = record(transport)
    const current = createTwpClient(connection, {
      close: transport.close,
      cache,
      credential: previous.credential,
    })
    t.after(() => current.close())
    await current.ready
    assert.equal(bodies.length, 1)
    assert.equal(bodies[0].byteLength, byteLimit)
    const requests = decodeRequests(bodies[0], byteLimit)
    assert.equal(requests.length, 1)
    const hello = requests[0]
    assert.ok(hello.t === 'hi' && hello.cache)
    assert.equal(hello.credential?.token, previous.credential.token)
    assert.deepEqual(hello.cache, claims.slice(0, 3))
    assert.ok(Buffer.byteLength(JSON.stringify({ ...hello, cache: claims })) > byteLimit)

    for (let index = 0; index < 4; index++) {
      const subscription = current.sub({ node: `/items/byte${index}` }, () => {})
      await subscription.ready
      const snap = snapshot(seen, subscription.id)
      assert.equal(snap.copies.length, index < 3 ? 0 : 1)
      assert.deepEqual(snap.covered, snap.list)
      assert.equal(node(cache.at(`/items/byte${index}`)).value, index)
    }
    assert.equal(current.failure(), undefined)
  })
})
