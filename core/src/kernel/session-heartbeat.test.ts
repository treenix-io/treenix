import assert from 'node:assert/strict'
import { it } from 'node:test'
import { KernelError } from '#errors'
import { createMemoryBlobStore } from '#kernel/blob-store-memory'
import { createInstanceFoundation } from '#kernel/instance'
import { createSessionFactory } from '#kernel/session-factory'
import { createMemoryStore } from '#kernel/store/memory'
import type { ModuleManifest, Position } from '#kernel/types'

const code = (expected: KernelError['code']) => (error: unknown) => error instanceof KernelError && error.code === expected

/** Builds actual node admissions and lane quota without a transport or substitute session. */
async function fixture() {
  const root = createMemoryStore({ domain: 'owned-heartbeat' })
  let saved: Position | undefined
  const instance = await createInstanceFoundation({ id: 'owned-heartbeat', root, writerEpoch: 1,
    domains: [{ store: root, epoch: 'heartbeat1', persistent: false }],
    counter: { async load() { return saved }, async save(pos) { saved = pos }, async freshEpoch(floor) { return floor + 1 } },
    firstAdmin: { path: '/admin', name: 'admin', password: 'owned-heartbeat-password' },
    initialCredential: { ttlMs: 600_000 }, blobs: createMemoryBlobStore() })
  assert.ok(instance.setupCredential)
  const credential = instance.setupCredential
  const admin = instance.commands(await instance.auth.openCredential(credential))
  const module: ModuleManifest = { id: 'heartbeat-cap', security: [], open: [], types: [{
    name: 'heartbeat.cap', module: 'heartbeat-cap', security: 'user-capability', version: 0,
    schema: {}, actions: { run: { kind: 'setuid', args: {}, handler: async () => undefined } },
  }] }
  await admin.commit({ opId: { epoch: instance.writer.intake.epoch, time: Date.now(), nonce: 'type' },
    changes: [{ op: 'put', node: { $path: '/sys/types/heartbeat.cap', $type: 't.type',
      name: 'heartbeat.cap', module: module.id, security: 'user-capability' } }] })
  instance.registry.publish(module)
  await admin.commit({ opId: { epoch: instance.writer.intake.epoch, time: Date.now(), nonce: 'worker' },
    changes: [{ op: 'put', node: { $path: '/worker', $type: 'heartbeat.cap' } }] })
  const factory = createSessionFactory({ auth: instance.auth, limits: instance.limits,
    lane: instance.nodeLaneOptions })
  return { instance, factory, credential }
}

it('keeps an owned node lane idle while public node and credential lanes expire', async t => {
  const f = await fixture()
  t.after(async () => { f.factory.close(); await f.instance.close() })
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() })
  const owned = await f.factory.openNode('/worker', { heartbeat: false })
  const publicNode = await f.factory.openNode('/worker')
  const credential = await f.factory.openCredential(f.credential)
  t.mock.timers.tick(f.instance.limits().heartbeatMs + 1)
  assert.equal(owned.admission.signal.aborted, false)
  assert.equal(publicNode.admission.signal.aborted, true)
  assert.equal(credential.admission.signal.aborted, true)
  assert.equal((await owned.session.frames.next()).value?.t, 'welcome')
  owned.session.close()
  assert.equal(owned.admission.signal.aborted, true)
  assert.equal((await owned.session.frames.next()).done, true)
})

it('releases owned node quota on explicit close and authorization revocation', async t => {
  const f = await fixture()
  t.after(async () => { f.factory.close(); await f.instance.close() })
  const factory = createSessionFactory({ auth: f.instance.auth,
    limits: () => ({ ...f.instance.limits(), maxLanes: 1 }), lane: f.instance.nodeLaneOptions })
  t.after(() => factory.close())
  const first = await factory.openNode('/worker', { heartbeat: false })
  await assert.rejects(factory.openNode('/worker', { heartbeat: false }), code('BUDGET'))
  first.session.close()
  const second = await factory.openNode('/worker', { heartbeat: false })
  second.admission.close(new KernelError('UNAUTHENTICATED', 'Authorization revoked'))
  assert.equal(second.admission.signal.aborted, true)
  await assert.rejects(async () => second.session.read({ node: '/worker' }), code('UNAUTHENTICATED'))
  const third = await factory.openNode('/worker', { heartbeat: false })
  factory.close()
  assert.equal(third.admission.signal.aborted, true)
})
