import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { it, type TestContext } from 'node:test'
import { registerType } from '#comp'
import { register, unregister } from '#core/registry'
import { KernelError } from '#errors'
import { createMemoryBlobStore } from '#kernel/blob-store-memory'
import { createInstance } from '#kernel/instance'
import { collectModule, registerKernel } from '#kernel/manifest'
import { drainSession } from '#kernel/session-delivery'
import { createMemoryStore } from '#kernel/store/memory'
import type { Node, Position, PositionCounter, ServiceHandler, Session } from '#kernel/types'

/** Synchronize with actual acquisition, invalidation and cleanup events. */
function event() {
  let resolve = () => {}
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

/** Supply a real monotonic counter for an ephemeral deployment. */
function counter(instance: string): PositionCounter {
  let position: Position | undefined
  let epoch = 0
  return {
    async load() { return position },
    async save(next, writerEpoch) {
      assert.equal(writerEpoch, 1)
      assert.equal(next.instance, instance)
      position = next
    },
    async freshEpoch(floor) { return epoch = Math.max(epoch, floor) + 1 },
  }
}

/** Start with no marker and install an actual registered service owner. */
async function fixture(t: TestContext, handler: ServiceHandler) {
  const module = await collectModule(`service-contract:${randomUUID()}`, () => {
    class Autostart {}
    registerType('autostart', Autostart, { security: 'user-capability' })
    register('autostart', 'schema', () => ({ $id: 'autostart', type: 'object', properties: { label: { type: 'string' } } }))
    registerKernel('autostart', 'service', handler)
  })
  const id = `service:${randomUUID()}`
  const store = createMemoryStore({ domain: id })
  const instance = await createInstance({
    id, root: { kind: 'store', store }, blobs: createMemoryBlobStore(), modules: [module],
    provisioning: {
      writerEpoch: 1, counter: counter(id), domains: [{ store, epoch: randomUUID(), persistent: false }],
      credentialTtlMs: 60_000,
      bootstrap: { kind: 'fresh', admin: { path: '/admin', name: 'admin', password: randomUUID() } },
    },
  })
  assert.ok(instance.setupCredential)
  const admin = await instance.openSession(instance.setupCredential)
  const delivery = drainSession(admin)
  let closing: Promise<void> | undefined

  /** Closes the instance once, then waits for its admin delivery lane. */
  function close() { return closing ??= instance.close().then(() => delivery) }
  t.after(async () => {
    await close()
    unregister('autostart', 'class')
    unregister('autostart', 'schema')
  })
  const key = () => ({ epoch: instance.writer.intake.epoch, time: Date.now(), nonce: randomUUID() })

  /** Installs the marker that starts the registered bootstrap service. */
  async function marker(label = 'first') {
    await admin.commit({ opId: key(), changes: [{ op: 'put', node: { $path: '/sys/autostart', $type: 't.autostart', label } }] }).outcome
  }
  return { instance, admin, key, marker, close }
}

/** Let the genuine service own its entire lane and completion task. */
function consume(session: Session): Promise<void> {
  return (async () => {
    for await (const frame of session.lane) if (frame.t === 'fail') throw frame.error
  })()
}

it('activates a later marker and releases its actual session once on removal', { timeout: 5_000 }, async t => {
  const started = event(), stopped = event()
  let count = 0
  let owned: Session | undefined
  const current = await fixture(t, async (_node, session) => {
    owned = session
    const done = consume(session)
    started.resolve()
    return { done, async stop() { count++; try { await done } finally { stopped.resolve() } } }
  })
  await current.marker()
  await started.promise
  await current.admin.commit({ opId: current.key(), changes: [{ op: 'remove', path: '/sys/autostart' }] }).outcome
  await stopped.promise
  assert.equal(count, 1)
  const ended = owned
  assert.ok(ended)
  await assert.rejects(async () => ended.read({ node: '/' }), error => error instanceof KernelError && error.code === 'UNAUTHENTICATED')
  await current.close()
  assert.equal(count, 1)
})

it('closes a paused real handler and releases a handle returned afterward once', { timeout: 5_000 }, async t => {
  const started = event(), release = event(), stopped = event()
  let count = 0
  let owned: Session | undefined
  const current = await fixture(t, async (_node, session) => {
    owned = session
    const done = consume(session)
    started.resolve()
    await release.promise
    return { done, async stop() { count++; try { await done } finally { stopped.resolve() } } }
  })
  await current.marker()
  await started.promise
  await current.close()
  const ended = owned
  assert.ok(ended)
  await assert.rejects(async () => ended.read({ node: '/' }), error => error instanceof KernelError && error.code === 'CANCELLED')
  release.resolve()
  await stopped.promise
  assert.equal(count, 1)
})

it('invalidates a paused configuration before starting its accepted replacement', { timeout: 5_000 }, async t => {
  const started = event(), replacement = event(), release = event(), lateStopped = event()
  const labels: unknown[] = []
  let old: Session | undefined
  let lateStops = 0
  const current = await fixture(t, async (node, session) => {
    labels.push(node.label)
    const done = consume(session)
    if (node.label === 'first') {
      old = session
      started.resolve()
      await release.promise
      return { done, async stop() { lateStops++; try { await done } finally { lateStopped.resolve() } } }
    }
    replacement.resolve()
    return { done, async stop() { await done } }
  })
  await current.marker()
  await started.promise
  await current.admin.commit({ opId: current.key(), changes: [{ op: 'patch', path: '/sys/autostart', ops: { $set: { label: 'second' } } }] }).outcome
  await replacement.promise
  const ended = old
  assert.ok(ended)
  await assert.rejects(async () => ended.read({ node: '/' }), error => error instanceof KernelError && error.code === 'CANCELLED')
  release.resolve()
  await lateStopped.promise
  assert.deepEqual(labels, ['first', 'second'])
  assert.equal(lateStops, 1)
})

it('keeps service identities and cleanup independent across actual instances', { timeout: 5_000 }, async t => {
  const firstStarted = event(), secondStarted = event()
  const firstStopped = event(), secondStopped = event()
  const nodes: Node[] = []
  const handler = (started: ReturnType<typeof event>, stopped: ReturnType<typeof event>): ServiceHandler => async (node, session) => {
    nodes.push(node)
    assert.equal(session.actor.principal, `n:${node.$id}`)
    const done = consume(session)
    started.resolve()
    return { done, async stop() { try { await done } finally { stopped.resolve() } } }
  }
  const first = await fixture(t, handler(firstStarted, firstStopped))
  const second = await fixture(t, handler(secondStarted, secondStopped))
  await first.marker()
  await second.marker()
  await Promise.all([firstStarted.promise, secondStarted.promise])
  assert.notEqual(nodes[0].$id, nodes[1].$id)
  await first.close()
  await firstStopped.promise
  assert.equal((await second.admin.read({ node: '/sys/autostart' })).copies.length, 1)
  await second.close()
  await secondStopped.promise
})
