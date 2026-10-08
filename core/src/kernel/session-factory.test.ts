import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { KernelError } from '#errors'
import { createMemoryBlobStore } from '#kernel/blob-store-memory'
import { createInstanceFoundation } from '#kernel/instance'
import { R, W, type Instance, type ModuleManifest, type Position } from '#kernel/types'

const code = (expected: KernelError['code']) => (error: unknown) => error instanceof KernelError && error.code === expected

async function fixture() {
  const root = (await import('#kernel/store/memory')).createMemoryStore({ domain: 'session-factory' })
  let saved: Position | undefined
  const instance = await createInstanceFoundation({ id: 'session-factory', root, writerEpoch: 1,
    domains: [{ store: root, epoch: 'sessions1', persistent: false }],
    counter: { async load() { return saved }, async save(pos) { saved = pos }, async freshEpoch(floor) { return floor + 1 } },
    firstAdmin: { path: '/admin', name: 'admin', password: 'session-factory-password' }, initialCredential: { ttlMs: 60_000 },
    blobs: createMemoryBlobStore() })
  assert.ok(instance.setupCredential)
  return { instance, root, credential: instance.setupCredential }
}

describe('public native session factory', { timeout: 10_000 }, () => {
  it('returns the real Session and settles its mutation only after covering pos and done delivery', async t => {
    const f = await fixture(); t.after(() => f.instance.close())
    const instance: Instance = f.instance
    const session = await instance.openSession(f.credential)
    const frames = session.lane[Symbol.asyncIterator]()
    const welcome = await frames.next()
    assert.ok(!welcome.done && welcome.value.t === 'welcome')
    const pending = session.commit({ opId: { epoch: welcome.value.intake, time: Date.now(), nonce: 'public-commit' },
      changes: [{ op: 'put', node: { $path: '/value', $type: 't.dir', count: 1 } }] })
    let settled = false
    void pending.outcome.then(() => { settled = true })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(settled, false)
    const pos = await frames.next()
    assert.ok(!pos.done && pos.value.t === 'pos' && !pos.value.coverage)
    assert.equal(settled, false)
    const done = await frames.next()
    assert.ok(!done.done && done.value.t === 'done' && done.value.req === pending.id)
    assert.deepEqual((await pending.outcome).pos, pos.value.pos)
    assert.deepEqual((await instance.openSession(f.credential)).actor, session.actor)
    assert.ok('node' in (await session.read({ node: '/value' })).copies[0])
    const chunks: unknown[] = []
    for await (const chunk of pending.chunks) chunks.push(chunk)
    assert.deepEqual(chunks, [])
    assert.equal(typeof session.upload, 'function')
    assert.equal(typeof session.download, 'function')
    assert.equal(instance.stream, f.instance.writer.stream)
    await frames.return?.()
    await assert.rejects(async () => session.read({ node: '/value' }), code('CANCELLED'))
  })

  it('issues anonymous credentials on welcome and preserves that identity on reconnect', async t => {
    const f = await fixture(); t.after(() => f.instance.close())
    const first = await f.instance.openSession()
    const welcome = await first.frames.next()
    assert.ok(!welcome.done && welcome.value.t === 'welcome' && welcome.value.credential)
    const second = await f.instance.openSession(welcome.value.credential)
    assert.deepEqual(second.actor, first.actor)
    await assert.rejects(f.instance.openSession({ token: 'invalid' }), code('UNAUTHENTICATED'))
  })

  it('opens the node door with only its actual grants and rejects an ordinary node', async t => {
    const f = await fixture(); t.after(() => f.instance.close())
    const admin = f.instance.commands(await f.instance.auth.openCredential(f.credential))
    const key = (nonce: string) => ({ epoch: f.instance.writer.intake.epoch, time: Date.now(), nonce })
    const module: ModuleManifest = { id: 'factory-cap', types: [{ name: 'factory.cap', module: 'factory-cap',
      security: 'user-capability', version: 0, schema: {}, actions: { run: { kind: 'setuid', args: {}, handler: async () => undefined } } }], security: [], open: [] }
    await admin.commit({ opId: key('cap-type'), changes: [{ op: 'put', node: { $path: '/sys/types/factory.cap', $type: 't.type',
      name: 'factory.cap', module: module.id, security: 'user-capability' } }] })
    f.instance.registry.publish(module)
    await admin.commit({ opId: key('cap-node'), changes: [{ op: 'put', node: { $path: '/worker', $type: 'factory.cap' } },
      { op: 'put', node: { $path: '/allowed', $type: 't.dir' } }, { op: 'put', node: { $path: '/other', $type: 't.dir' } }] })
    const worker = await admin.read({ node: '/worker' })
    const copy = worker.copies[0]; assert.ok('node' in copy)
    const principal = `n:${copy.node.$id}` as const
    await admin.commit({ opId: key('cap-grant'), expect: { nodes: [{ path: '/worker', rev: copy.node.$rev }] },
      changes: [{ op: 'patch', path: '/allowed', ops: { $set: { $acl: [{ subject: { group: principal }, grant: R | W }] } } }] })
    const session = await f.instance.openNodeSession('/worker')
    assert.equal(session.actor.principal, principal)
    assert.deepEqual(session.actor.claims, [principal])
    assert.ok('node' in (await session.read({ node: '/allowed' })).copies[0])
    await assert.rejects(session.read({ node: '/other' }), code('NOT_FOUND'))
    await assert.rejects(f.instance.openNodeSession('/allowed'), code('INVALID'))
  })
})
