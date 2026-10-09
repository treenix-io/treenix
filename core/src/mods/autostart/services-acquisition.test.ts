import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { it, type TestContext } from 'node:test'
import { registerType } from '#comp'
import { register, unregister } from '#core/registry'
import { createMemoryBlobStore } from '#kernel/blob-store-memory'
import { createInstance } from '#kernel/instance'
import { collectModule, registerKernel, type CollectedModule } from '#kernel/manifest'
import { drainSession } from '#kernel/session-delivery'
import { createMemoryStore } from '#kernel/store/memory'
import { A, R, W, type ChangeMember, type Node, type Position, type PositionCounter, type Preconditions, type Session } from '#kernel/types'

let autostartModule: Promise<CollectedModule> | undefined

/** Reuse the genuine cached native module manifest across isolated instances. */
function autostart(): Promise<CollectedModule> {
  return autostartModule ??= collectModule('@treenx/core/autostart', () => import('#mods/autostart/kernel'))
}

/** Wait for a real read continuation or handler invocation. */
function event() {
  let resolve = () => {}

  const promise = new Promise<void>(done => { resolve = done })

  return { promise, resolve }
}

/** Provision a real memory deployment with its monotonic position counter. */
function counter(): PositionCounter {
  let position: Position | undefined
  let epoch = 0

  return {
    async load() { return position },
    async save(next) { position = next },
    async freshEpoch(floor) { return epoch = Math.max(epoch, floor) + 1 },
  }
}

/** Install genuine service declarations and administer them through an actual session. */
async function fixture(t: TestContext, discoveryAdmin = false) {
  const type = `acquisition.worker-${randomUUID()}`
  const starts: string[] = []
  const started = event()

  const module = await collectModule(`acquisition:${randomUUID()}`, () => {
    class Worker {}
    registerType(type, Worker, { security: 'user-capability' })
    register(type, 'schema', () => ({ $id: type, type: 'object', properties: {} }))
    registerKernel(type, 'service', async (node: Node, session: Session) => {
      assert.equal(session.actor.principal, `n:${node.$id}`)
      starts.push(node.$id)
      const done = (async () => {
        for await (const frame of session.lane) assert.notEqual(frame.t, 'fail')
      })()
      started.resolve()
      return { done, async stop() { await done } }
    })
  })

  const id = `acquisition:${randomUUID()}`
  const store = createMemoryStore({ domain: id })

  const instance = await createInstance({
    id, root: { kind: 'store', store }, blobs: createMemoryBlobStore(), modules: [await autostart(), module],
    provisioning: {
      writerEpoch: 1, counter: counter(), domains: [{ store, epoch: randomUUID(), persistent: false }],
      credentialTtlMs: 60_000,
      bootstrap: { kind: 'fresh', admin: { path: '/admin', name: 'admin', password: randomUUID() } },
    },
  })

  assert.ok(instance.setupCredential)
  const admin = await instance.openSession(instance.setupCredential)
  const delivery = drainSession(admin)
  const cleanup: (() => void)[] = []
  t.after(async () => {
    for (const restore of cleanup) restore()
    await instance.close()
    await delivery
    unregister(type, 'class')
    unregister(type, 'schema')
  })

  /** Publish one accepted atomic declaration change. */
  async function commit(changes: readonly ChangeMember[], expect?: Preconditions) {
    await admin.commit({
      opId: { epoch: instance.writer.intake.epoch, time: Date.now(), nonce: randomUUID() },
      changes,
      expect,
    }).outcome
  }

  await commit([
    { op: 'put', node: { $path: '/services', $type: 't.dir' } },
    { op: 'put', node: { $path: '/services/worker', $type: type } },
    { op: 'put', node: { $path: '/services/next', $type: type } },
    { op: 'put', node: { $path: '/sys/autostart', $type: 't.autostart' } },
  ])
  const workerCopy = (await admin.read({ node: '/services/worker' })).copies[0]
  const nextCopy = (await admin.read({ node: '/services/next' })).copies[0]
  const ownerCopy = (await admin.read({ node: '/sys/autostart' })).copies[0]

  assert.ok('node' in workerCopy && 'node' in nextCopy && 'node' in ownerCopy)
  const worker = workerCopy.node, next = nextCopy.node, owner = ownerCopy.node

  await commit([
    ...[worker, next].map(node => ({
      op: 'patch' as const, path: node.$path, ops: { $set: { $acl: [
        { subject: { group: `n:${node.$id}` }, grant: R | W },
        { subject: { group: `n:${owner.$id}` }, grant: discoveryAdmin ? R | A : R },
      ] } },
    })),
    { op: 'patch', path: owner.$path, ops: { $set: { $acl: [{ subject: { group: `n:${owner.$id}` }, grant: R }] } } },
  ], { nodes: [worker, next, owner].map(node => ({ path: node.$path, rev: node.$rev })) })
  await instance.prepareServices()
  return { instance, admin, commit, type, worker, next, owner, starts, started, cleanup }
}

it('starts the exact child once when discovery has admin read visibility', { timeout: 10_000 }, async t => {
  const current = await fixture(t, true)
  await current.commit([{ op: 'put', node: { $path: '/sys/autostart/worker', $type: 't.ref', $ref: current.worker.$path } }])
  await current.started.promise
  assert.deepEqual(current.starts, [current.worker.$id])
})

/** Hold the real node admission result after its ordered source read releases the Writer. */
async function declarationChange(t: TestContext, retarget: boolean): Promise<void> {
  const current = await fixture(t)
  const entered = event(), release = event()
  const original = current.instance.source.read

  let armed = true
  current.instance.source.read = async run => {
    let selected = false

    const value = await original(read => run({ ...read,
      async node(path) {
        const node = await read.node(path)
        if (path === current.worker.$path) selected = true
        return node
      },
    }))
    if (armed && selected) {
      armed = false
      entered.resolve()
      await release.promise
    }

    return value
  }
  current.cleanup.push(() => { release.resolve(); current.instance.source.read = original })

  await current.commit([{ op: 'put', node: { $path: '/sys/autostart/worker', $type: 't.ref', $ref: current.worker.$path } }])
  await entered.promise
  await current.commit(retarget
    ? [{ op: 'patch', path: '/sys/autostart/worker', ops: { $set: { $ref: current.next.$path } } }]
    : [{ op: 'remove', path: '/sys/autostart/worker' }])
  release.resolve()
  if (!retarget) await current.commit([{ op: 'put', node: { $path: '/sys/autostart/next', $type: 't.ref', $ref: current.next.$path } }])
  await current.started.promise
  assert.deepEqual(current.starts, [current.next.$id])
}

it('never invokes a stale child removed during actual node acquisition', { timeout: 10_000 }, async t => {
  await declarationChange(t, false)
})

it('starts only the replacement after a ref retarget during actual node acquisition', { timeout: 10_000 }, async t => {
  await declarationChange(t, true)
})

it('never starts a replacement identity after an identity-ref address lookup races a move', { timeout: 10_000 }, async t => {
  const current = await fixture(t)
  const entered = event(), release = event()
  const original = current.instance.writer.read

  let armed = true
  current.instance.writer.read = async (inputs, run) => {
    const value = await original(inputs, run)

    if (armed && value === current.worker.$path) {
      armed = false
      entered.resolve()
      await release.promise
    }
    return value
  }
  current.cleanup.push(() => { release.resolve(); current.instance.writer.read = original })

  await current.commit([{ op: 'put', node: {
    $path: '/sys/autostart/worker', $type: 't.ref', $ref: current.worker.$path, $refId: current.worker.$id,
  } }])
  await entered.promise
  await current.commit([
    { op: 'move', from: current.worker.$path, to: '/services/moved' },
    { op: 'put', node: { $path: current.worker.$path, $type: current.type } },
  ])
  const replacementCopy = (await current.admin.read({ node: current.worker.$path })).copies[0]
  const currentOwnerCopy = (await current.admin.read({ node: current.owner.$path })).copies[0]

  assert.ok('node' in replacementCopy && 'node' in currentOwnerCopy)
  await current.commit([{ op: 'patch', path: current.worker.$path, ops: { $set: { $acl: [
    { subject: { group: `n:${replacementCopy.node.$id}` }, grant: R | W },
    { subject: { group: `n:${current.owner.$id}` }, grant: R },
  ] } } }], { nodes: [replacementCopy.node, currentOwnerCopy.node].map(node => ({ path: node.$path, rev: node.$rev })) })
  release.resolve()
  await current.commit([{ op: 'put', node: { $path: '/sys/autostart/next', $type: 't.ref', $ref: current.next.$path } }])
  await current.started.promise
  assert.ok(!current.starts.includes(replacementCopy.node.$id))
  assert.ok(current.starts.every(id => id === current.worker.$id || id === current.next.$id))
})
