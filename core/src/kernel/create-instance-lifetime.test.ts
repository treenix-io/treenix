import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { KernelError } from '#errors'
import { createFsBlobStore } from '#kernel/blob-store-fs'
import { createInstance } from '#kernel/instance'
import { createInstance as publicCreateInstance } from '#kernel/index'
import { openPersistentWriter } from '#kernel/persistence'
import { drainSession } from '#kernel/session-delivery'
import { createFsStore } from '#kernel/store/fs'
import { createMemoryStore } from '#kernel/store/memory'
import { scanBudget } from '#kernel/store/contract'
import type { InstanceConfig, ModuleManifest } from '#kernel/types'

const code = (expected: KernelError['code']) => (error: unknown) => error instanceof KernelError && error.code === expected
const module: ModuleManifest = { id: 'review-counter', types: [{ name: 'review.counter', module: 'review-counter',
  security: 'ordinary', version: 0, schema: { type: 'object', properties: { count: { type: 'number' } }, required: ['count'] },
  actions: { increment: { kind: 'write', args: {}, post: { '': { $inc: { count: 1 } } } } } }], security: [], open: [] }

/** Acquires actual borrowed filesystem resources for the public creator. */
async function setup() {
  const parent = fileURLToPath(new URL('../../../../temp/native-provisioning-contract/', import.meta.url))
  await mkdir(parent, { recursive: true })
  const directory = await mkdtemp(join(parent, 'lifetime-'))
  const id = `lifetime:${randomUUID()}`
  const lease = await openPersistentWriter({ directory: join(directory, '.treenix'), instance: id })
  const store = await createFsStore({ directory, lease })
  const blobs = await createFsBlobStore(join(directory, '.treenix', 'blobs'))
  const provisioning = { counter: lease, writerEpoch: lease.writerEpoch,
    domains: [{ store, epoch: lease.epoch, persistent: true }], credentialTtlMs: 60_000 }
  const fresh: InstanceConfig = { id, root: { kind: 'store', store }, blobs, modules: [],
    provisioning: { ...provisioning, bootstrap: { kind: 'fresh', admin: { path: '/admin', name: 'admin', password: 'lifetime-password' } } } }
  const reopen: InstanceConfig = { ...fresh, provisioning: { ...provisioning, bootstrap: { kind: 'reopen' } } }
  async function persisted() {
    return { counter: await lease.load(), journal: (await readFile(join(directory, '.treenix', 'journal.log'))).toString('hex') }
  }
  return { id, directory, store, lease, fresh, reopen, persisted, async close() { await store.close(); await lease.close() } }
}

it('refuses unsupported roots and an absent root binding without accepting effects', { timeout: 10000 }, async t => {
  const f = await setup(); t.after(f.close)
  let effects = 0
  const options: readonly { config: InstanceConfig; error: KernelError['code'] }[] = [
    { config: { ...f.fresh, root: { kind: 'view', executor: 'reader', derive: async () => { effects++; return { members: [] } } } }, error: 'UNAVAILABLE' },
    { config: { ...f.fresh, root: { kind: 'authority', authority: { kind: 'federation', connect: async () => { effects++; throw new Error('Unexpected connection') } } } }, error: 'UNAVAILABLE' },
    { config: { ...f.fresh, rootExternal: 'trusted' }, error: 'UNAVAILABLE' },
    { config: { ...f.fresh, provisioning: { ...f.fresh.provisioning, domains: [{ store: createMemoryStore({ domain: 'foreign' }), epoch: 'foreign', persistent: false }] } }, error: 'INVALID' },
  ]
  const before = await f.persisted()
  for (const input of options) {
    await assert.rejects(publicCreateInstance(input.config), code(input.error))
    assert.deepEqual(await f.persisted(), before)
  }
  assert.equal(effects, 0)
  assert.deepEqual((await f.store.scan({ range: { subtree: '/' }, budget: scanBudget() })).items, [])
})

it('rejects explicit reopen against empty storage and fresh against accepted storage without another fence', { timeout: 10000 }, async t => {
  const f = await setup(); t.after(f.close)
  const empty = await f.persisted()
  await assert.rejects(publicCreateInstance(f.reopen), code('INVALID'))
  assert.deepEqual(await f.persisted(), empty)
  const initial = await publicCreateInstance(f.fresh); initial.close()
  const accepted = await f.persisted()
  await assert.rejects(publicCreateInstance(f.fresh), code('INVALID'))
  assert.deepEqual(await f.persisted(), accepted)
})

it('closes owned lanes while preserving borrowed resources and canonical outcomes through reacquisition', { timeout: 10000 }, async t => {
  assert.equal(publicCreateInstance, createInstance)
  const f = await setup(); t.after(f.close)
  const first = await createInstance({ ...f.fresh, modules: [module] }); t.after(() => first.close())
  assert.ok(first.setupCredential)
  const session = await first.openSession(first.setupCredential), delivery = drainSession(session)
  const epoch = first.writer.intake.epoch
  await session.commit({ changes: [{ op: 'put', node: { $path: '/counter', $type: 'review.counter', count: 0 } }],
    opId: { epoch, time: Date.now(), nonce: 'initial' } }).outcome
  const key = { epoch, time: Date.now(), nonce: 'increment' }
  const outcome = await session.act({ path: '/counter', action: 'increment', args: {}, opId: key }).outcome
  const accepted = await first.source.node('/counter'); assert.ok(accepted)
  const adminId = first.bootstrap.adminId
  first.close(); await delivery
  await assert.rejects(first.openSession(first.setupCredential), code('UNAVAILABLE'))
  assert.equal((await f.store.scan({ range: { node: '/counter' }, budget: scanBudget() })).items[0].count, 1)
  assert.ok(await f.lease.load())
  await assert.rejects(openPersistentWriter({ directory: join(f.directory, '.treenix'), instance: f.id }), code('CONFLICT'))
  await f.close()

  const lease = await openPersistentWriter({ directory: join(f.directory, '.treenix'), instance: f.id })
  const store = await createFsStore({ directory: f.directory, lease })
  t.after(async () => { await store.close(); await lease.close() })
  const reopened = await createInstance({ ...f.reopen, root: { kind: 'store', store }, modules: [module],
    provisioning: { ...f.reopen.provisioning, counter: lease, writerEpoch: lease.writerEpoch,
      domains: [{ store, epoch: lease.epoch, persistent: true }] } })
  t.after(() => reopened.close())
  assert.equal(reopened.bootstrap.adminId, adminId)
  assert.equal(reopened.setupCredential, undefined)
  assert.deepEqual(await reopened.source.node('/counter'), accepted)
  const credential = await reopened.auth.login({ account: '/admin', password: 'lifetime-password' })
  const second = await reopened.openSession(credential), secondDelivery = drainSession(second)
  assert.deepEqual(await second.act({ path: '/counter', action: 'increment', args: {}, opId: key }).outcome, outcome)
  assert.deepEqual(await reopened.source.node('/counter'), accepted)
  second.close(); await secondDelivery
})

for (const revoked of ['blocked', 'deleted'] as const) {
  it(`reopens a ${revoked} first admin without reminting identity or setup credentials`, { timeout: 10000 }, async t => {
    const f = await setup(); t.after(f.close)
    const first = await createInstance(f.fresh); assert.ok(first.setupCredential)
    t.after(() => first.close())
    const session = await first.openSession(first.setupCredential), delivery = drainSession(session)
    const key = { epoch: first.writer.intake.epoch, time: Date.now(), nonce: 'revoke' }
    const accepted = await session.commit({ opId: key, changes: revoked === 'blocked'
      ? [{ op: 'patch', path: '/admin', ops: { $set: { status: 'blocked' } } }]
      : [{ op: 'remove', path: '/admin' }] }).outcome
    assert.ok(accepted.pos)
    first.close(); await assert.rejects(delivery, code('UNAUTHENTICATED'))
    const reopened = await createInstance(f.reopen); t.after(() => reopened.close())
    assert.equal(reopened.bootstrap.adminId, first.bootstrap.adminId)
    assert.equal(reopened.setupCredential, undefined)
    assert.equal((await reopened.source.nodeById(first.bootstrap.adminId))?.status, revoked === 'blocked' ? 'blocked' : undefined)
    await assert.rejects(reopened.openSession(first.setupCredential), code('UNAUTHENTICATED'))
  })
}
