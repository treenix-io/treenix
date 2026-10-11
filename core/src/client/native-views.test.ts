import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { it, type TestContext } from 'node:test'
import { createTwpClient } from '#client/twp'
import { createMemoryBlobStore } from '#kernel/blob-store-memory'
import { createInstance } from '#kernel/instance'
import { drainSession } from '#kernel/session-delivery'
import { createMemoryStore } from '#kernel/store/memory'
import { createTwpServing } from '#protocol/serve'
import { A, R, type Connection, type DeriveHandler, type Frame, type ModuleManifest, type Position, type Preconditions, type Request } from '#kernel/types'

/** Observes native delivery without polling or delaying the producer. */
function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error('Observer is absent') }
  const promise = new Promise<T>(ready => { resolve = ready })
  return { promise, resolve }
}

/** Opens a real instance, Session serving connection, and client with explicit View-node grants. */
async function fixture(t: TestContext, derive: DeriveHandler, executor: 'node' | 'reader') {
  const id = randomUUID()
  const store = createMemoryStore({ domain: id })
  let saved: Position | undefined
  const module: ModuleManifest = {
    id: 'views',
    types: [{ name: 'example.view', module: 'views', version: 0,
      security: 'privileged-capability', schema: { type: 'object', properties: { pattern: { type: 'string' } } }, actions: {} }],
    security: [{ type: 'example.view', context: 'mount', async handler() {
      return executor === 'node'
        ? { kind: 'view', executor: 'node', derive, async close() {} }
        : { kind: 'view', executor: 'reader', derive, async close() {} }
    } }],
    open: [],
  }
  const instance = await createInstance({ id, root: { kind: 'store', store }, modules: [module], blobs: createMemoryBlobStore(),
    provisioning: { writerEpoch: 1, domains: [{ store, epoch: randomUUID(), persistent: false }],
      credentialTtlMs: 60_000, counter: { async load() { return saved }, async save(pos) { saved = pos },
        async freshEpoch(floor) { return floor + 1 } },
      bootstrap: { kind: 'fresh', admin: { path: '/admin', name: 'admin', password: randomUUID() } } } })
  assert.ok(instance.setupCredential)
  const credential = instance.setupCredential
  const admin = await instance.openSession(credential)
  const draining = drainSession(admin)
  const serving = createTwpServing(instance)
  t.after(async () => { serving.close(); await instance.close(); await draining })
  const commit = (changes: Parameters<typeof admin.commit>[0]['changes'], expect?: Preconditions) => admin.commit({
    opId: { epoch: instance.writer.intake.epoch, time: Date.now(), nonce: randomUUID() }, changes, expect,
  }).outcome
  await commit([
    { op: 'put', node: { $path: '/source', $type: 't.dir' } },
    { op: 'put', node: { $path: '/source/a', $type: 't.dir', value: 1, $owner: 'u:source-owner', $acl: [] } },
    { op: 'put', node: { $path: '/source/b', $type: 't.dir', value: 2 } },
    { op: 'put', node: { $path: '/view', $type: 't.dir', '#mount': { $type: 'example.view', pattern: 'result' } } },
  ])
  if (executor === 'node') {
    const declaration = (await admin.read({ node: '/view' })).copies[0]
    assert.ok(declaration !== undefined && 'node' in declaration)
    await commit([{ op: 'patch', path: '/source', ops: { $set: {
      $acl: [{ subject: { group: `n:${declaration.node.$id}` }, grant: R | A }],
    } } }], { nodes: [{ path: declaration.node.$path, rev: declaration.node.$rev }] })
  }
  const opened = await serving.open({ t: 'hi' }, credential, '127.0.0.1')
  const attached = serving.attach(opened.id, credential, '127.0.0.1')
  const sent: Request[] = []
  const seen: Frame[] = []
  const connection: Connection = { frames: {
    async *[Symbol.asyncIterator]() {
      for await (const frame of attached.frames) { seen.push(frame); yield frame }
    },
  }, send(request) {
    sent.push(request)
    serving.dispatch(opened.id, credential, '127.0.0.1', [request])
  } }
  const client = createTwpClient(connection, { close: attached.close, credential })
  t.after(() => client.close())
  await client.ready
  return { client, sent, seen, commit, credential }
}

it('delivers node View data through the native client without ordinary copies or refetching', { timeout: 10_000 }, async t => {
  const { client, sent, commit, credential } = await fixture(t, async (_view, _request, read) => {
    const result = await read.read({ children: '/source' })
    return { members: result.copies.map(copy => {
      assert.ok('node' in copy)
      if (copy.node.$path === '/source/a') {
        assert.equal(copy.node.$owner, 'u:source-owner')
        assert.deepEqual(copy.node.$acl, [])
      }
      return copy.node.$path
    }), rows: [{ key: 'count', value: result.list.length }] }
  }, 'node')
  const changed = deferred<void>()
  const removed = deferred<void>()
  const sub = client.sub({ children: '/view/result' }, () => {
    const state = client.cache.list(sub.id)
    if (state?.computed?.some(node => node.value === 3)) changed.resolve()
    if (state?.rows?.some(row => row.value === 1)) removed.resolve()
  })
  await sub.ready
  const initial = client.cache.list(sub.id)
  assert.ok(initial?.computed)
  assert.equal(initial.computed.length, 2)
  assert.deepEqual(initial.rows, [{ key: 'count', value: 2 }])
  assert.deepEqual(client.cache.orderedComputed(sub.id, [['value', 1]]).map(node => node.value), [1, 2])
  for (const node of initial.computed) {
    assert.equal(node.$acl, undefined)
    assert.equal(node.$owner, undefined)
    assert.equal(client.cache.copy(node.$id), undefined)
    assert.equal(client.cache.at(node.$path), undefined)
  }
  assert.deepEqual(client.cache.claims(), [])

  await commit([{ op: 'patch', path: '/source/a', ops: { $set: { value: 3 } } }])
  await changed.promise
  const updated = client.cache.list(sub.id)
  assert.ok(updated?.computed)
  assert.deepEqual(updated.computed.map(node => node.value).sort(), [2, 3])
  assert.deepEqual(client.cache.orderedComputed(sub.id, [['value', 1]]).map(node => node.value), [2, 3])
  await commit([{ op: 'remove', path: '/source/b' }])
  await removed.promise
  assert.equal(client.cache.list(sub.id)?.computed?.length, 1)
  assert.deepEqual(client.cache.list(sub.id)?.rows, [{ key: 'count', value: 1 }])
  assert.equal(sent.some(request => request.t === 'read'), false)
  assert.deepEqual(client.cache.claims(), [])
  sub.close()
  assert.equal(client.cache.list(sub.id), undefined)
  const remaining = client.sub({ children: '/view/result' }, () => {})
  await remaining.ready
  assert.equal(client.cache.list(remaining.id)?.computed?.length, 1)
  client.close()
  assert.equal(client.cache.list(remaining.id), undefined)
  assert.deepEqual(client.cache.reconnectClaims(credential), [])
})

it('publishes a captured reader result without rolling back a newer shared client copy', { timeout: 10_000 }, async t => {
  const captured = deferred<void>()
  const resume = deferred<void>()
  t.after(() => resume.resolve())
  let runs = 0
  const { client, seen, commit } = await fixture(t, async (_view, _request, read) => {
    const source = (await read.read({ node: '/source/a' })).copies[0]
    assert.ok(source !== undefined && 'node' in source)
    if (++runs === 2) {
      captured.resolve()
      await resume.promise
    }
    return { members: [source.node.$path], rows: [{ key: 'value', value: source.node.value }] }
  }, 'reader')
  const ordinaryUpdated = deferred<void>()
  const ordinary = client.sub({ node: '/source/a' }, () => {
    const copy = client.cache.at('/source/a')
    assert.ok(copy !== undefined && 'node' in copy)
    if (copy.node.value === 2) ordinaryUpdated.resolve()
  })
  await ordinary.ready
  const initial = client.cache.at('/source/a')
  assert.ok(initial !== undefined && 'node' in initial)
  assert.equal(initial.node.value, 1)
  const olderPublished = deferred<{ readonly value: unknown; readonly ids: readonly string[] }>()
  const newerPublished = deferred<unknown>()
  const view = client.sub({ children: '/view/result' }, () => {
    const frame = seen.at(-1)
    if (frame?.t !== 'result' || frame.sub !== view.id) return
    const list = client.cache.list(view.id)
    assert.ok(list)
    const copy = client.cache.at('/source/a')
    assert.ok(copy !== undefined && 'node' in copy)
    if (list.rows?.some(row => row.value === 1)) olderPublished.resolve({ value: copy.node.value, ids: list.ids })
    if (list.rows?.some(row => row.value === 2)) newerPublished.resolve(copy.node.value)
  })
  await view.ready
  assert.deepEqual(client.cache.list(view.id)?.rows, [{ key: 'value', value: 1 }])
  await commit([{ op: 'patch', path: '/source/a', ops: { $set: { wake: true } } }])
  await captured.promise
  await commit([{ op: 'patch', path: '/source/a', ops: { $set: { value: 2 } } }])
  await ordinaryUpdated.promise
  const delivered = client.cache.at('/source/a')
  assert.ok(delivered !== undefined && 'node' in delivered)
  assert.equal(delivered.node.value, 2)

  resume.resolve()
  await view.ready
  assert.deepEqual(await olderPublished.promise, { value: 2, ids: [initial.node.$id] })
  assert.equal(await newerPublished.promise, 2)
  assert.equal(runs, 3)
  const converged = client.cache.at('/source/a')
  assert.ok(converged !== undefined && 'node' in converged)
  assert.equal(converged.node.value, 2)
})
