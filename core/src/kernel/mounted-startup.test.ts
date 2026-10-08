import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { describe, it, type TestContext } from 'node:test'

import { KernelError } from '#errors'
import { createMemoryBlobStore } from '#kernel/blob-store-memory'
import { createInstance, type InstanceFoundationWithAuth } from '#kernel/instance'
import { createMemoryMountHandler, type MemoryMountHandler } from '#kernel/mount-memory'
import { openPersistentWriter } from '#kernel/persistence'
import { comparePositions, positionToRev } from '#kernel/position'
import { drainSession } from '#kernel/session-delivery'
import { scanBudget } from '#kernel/store/contract'
import { createFsStore } from '#kernel/store/fs'
import { createMemoryStore } from '#kernel/store/memory'
import { DEFAULT_LIMITS } from '#kernel/types'
import type {
  Frame, InstanceConfig, ModuleManifest, Node, OpenedStoreMountTarget,
  Position, PositionCounter, Principal, Session,
} from '#kernel/types'

const code = (expected: KernelError['code']) => (error: unknown) =>
  error instanceof KernelError && error.code === expected

it('keeps an owned Fs mount alive past network idle expiry and releases its lease once', { timeout: 10_000 }, async t => {
  const f = await setup(t)
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() })
  const instance = await f.reopen()
  const external = await instance.openSession(f.credential)
  const frames = external.lane[Symbol.asyncIterator]()
  assert.equal((await nextFrame(frames)).t, 'welcome')
  const expired = assert.rejects(frames.next(), code('UNAVAILABLE'))

  t.mock.timers.tick(DEFAULT_LIMITS.heartbeatMs + 1)
  await expired

  const publicSession = await instance.openSession(f.credential)
  assert.equal((await readNode(publicSession, '/data/doc')).count, 10)
  assert.equal(f.closes(), 0)
  await Promise.all([instance.close(), instance.close()])
  assert.equal(f.closes(), 1)

  const lease = await openPersistentWriter({ directory: join(f.directory, '.treenix'), instance: f.id })
  const store = await createFsStore({ directory: f.directory, lease, logicalBase: '/data' })
  t.after(async () => { await store.close(); await lease.close() })
  assert.ok(lease.writerEpoch > f.lease.writerEpoch)
  assert.equal((await store.scan({ range: { node: '/data/doc' }, budget: scanBudget() })).items[0].count, 10)
})

/** Reads an actual delivery frame and refuses an unexpectedly ended lane. */
async function nextFrame(iterator: AsyncIterator<Frame>): Promise<Frame> {
  const next = await iterator.next()
  assert.equal(next.done, false)
  assert.ok(next.value)
  return next.value
}

/** Returns a visible native node without hiding schema errors in test expectations. */
async function readNode(session: Session, path: string): Promise<Node> {
  const result = await session.read({ node: path })
  assert.equal(result.copies.length, 1)
  const copy = result.copies[0]
  assert.ok('node' in copy)
  return copy.node
}

/** Seeds the declaring node through one real instance, then acquires its durable target independently. */
async function setup(t: TestContext, twoDeclarations = false) {
  const id = `mounted-startup-${randomUUID()}`
  const root = createMemoryStore({ domain: `root:${id}` })

  const instances: InstanceFoundationWithAuth[] = []
  let saved: Position | undefined
  let issuedEpoch = 0
  let saves = 0
  const counter: PositionCounter = {
    async load() { return saved },
    async save(position) {
      saved = { ...position }
      issuedEpoch = Math.max(issuedEpoch, position.epoch)
      saves++
    },
    async freshEpoch(previous) {
      issuedEpoch = Math.max(issuedEpoch, previous) + 1
      return issuedEpoch
    },
  }
  const control: {
    target?: OpenedStoreMountTarget
    replacement?: MemoryMountHandler
    failure?: KernelError
    actors: Principal[]
  } = { actors: [] }

  const manifest: ModuleManifest = {
    id: 'startup-target',
    types: [
      { name: 'startup.mount', module: 'startup-target', security: 'privileged-capability',
        version: 0, schema: {}, actions: {} },
      { name: 'startup.document', module: 'startup-target', security: 'ordinary',
        version: 0, schema: {}, actions: {
          increment: { kind: 'write', args: {}, post: { '': { $inc: { count: 1 } } } },
        } },
    ],
    security: [{ type: 'startup.mount', context: 'mount', handler: async (decl, session) => {
      control.actors.push(session.actor.principal)
      assert.equal(session.actor.principal, `n:${decl.$id}`)
      assert.equal((await readNode(session, decl.$path)).$id, decl.$id)
      if (control.failure !== undefined) throw control.failure
      assert.ok(control.target)
      return control.replacement === undefined ? control.target : control.replacement(decl, session)
    } }],
    open: [],
  }
  const rootDomains = [{ store: root, epoch: `continuity:${id}`, persistent: false }]

  const first = await createInstance({ id, root: { kind: 'store', store: root },
    blobs: createMemoryBlobStore(), modules: [manifest], provisioning: {
      counter, writerEpoch: 17, domains: rootDomains, credentialTtlMs: 60_000,
      bootstrap: { kind: 'fresh', admin: { path: '/admin', name: 'admin', password: 'startup-password' } },
    } })
  instances.push(first)
  t.after(async () => { for (const instance of instances.reverse()) await instance.close() })
  assert.ok(first.setupCredential)
  const credential = first.setupCredential
  const admin = await first.openSession(credential)
  const delivery = drainSession(admin)

  await admin.commit({ opId: { epoch: first.writer.intake.epoch, time: Date.now(), nonce: 'declare' },
    changes: [{ op: 'put', node: { $path: '/data', $type: 't.dir',
      '#mount': { $type: 'startup.mount', pattern: '' },
      '#groups': { $type: 't.groups', list: ['admins'] },
    } }, ...(twoDeclarations ? [{ op: 'put' as const, node: {
      $path: '/archive', $type: 't.dir',
      '#mount': { $type: 'startup.mount', pattern: '' },
      '#groups': { $type: 't.groups', list: ['admins'] },
    } }] : [])] }).outcome
  const declaration = await readNode(admin, '/data')
  const secondDeclaration = twoDeclarations ? await readNode(admin, '/archive') : undefined
  const rootBefore = await root.scan({ range: { journal: '/' }, budget: scanBudget() })
  assert.equal(control.actors.length, 0)
  assert.ok(saved)
  const rootPosition = saved
  await first.close()
  await delivery

  const parent = resolve('../../temp/k26-mounted-startup')
  await mkdir(parent, { recursive: true })
  const directory = await mkdtemp(join(parent, 'target-'))
  await writeFile(join(directory, 'doc.json'), JSON.stringify({ $type: 'startup.document', count: 10 }))
  const lease = await openPersistentWriter({ directory: join(directory, '.treenix'), instance: id })
  const store = await createFsStore({ directory, lease, logicalBase: '/data' })
  let closes = 0
  const target: OpenedStoreMountTarget = {
    kind: 'store', store,
    resources: { writerEpoch: lease.writerEpoch, epoch: lease.epoch,
      persistent: true, decisionHistory: 'retained' },
    async close() {
      closes++
      await store.close()
      await lease.close()
    },
  }
  control.target = target
  t.after(async () => { if (closes === 0) await target.close() })
  assert.notEqual(lease.writerEpoch, 18)

  const imported = (await store.scan({ range: { node: '/data/doc' }, budget: scanBudget() })).items[0]
  assert.ok(imported)
  assert.equal(imported.$id, 'p:/data/doc')
  const high: Position = { instance: id, epoch: await lease.freshEpoch(rootPosition.epoch + 5), seq: 1 }
  await lease.save(high, lease.writerEpoch)
  const after = { ...imported, $pos: high }
  await store.commit({ pos: high, writerEpoch: lease.writerEpoch, writes: [{ path: after.$path, node: after }],
    record: { pos: high, kind: 'reconcile', caller: 'kernel', executor: 'kernel',
      entries: [{ id: after.$id, path: after.$path, change: { t: 'reconcile', before: imported, after } }] } })

  /** Supplies only the root as borrowed inventory; the startup declaration owns its Fs resource. */
  function config(module: ModuleManifest = manifest, revision = declaration.$rev): InstanceConfig {
    return { id, root: { kind: 'store', store: root }, blobs: createMemoryBlobStore(), modules: [module],
      provisioning: { counter, writerEpoch: 18, domains: rootDomains, credentialTtlMs: 60_000,
        bootstrap: { kind: 'reopen', installerCredential: credential },
        mounts: [{ node: declaration.$id, component: '#mount', revision, target }] } }
  }

  /** Records only successfully published instances for lifecycle cleanup. */
  async function reopen() {
    const instance = await createInstance(config())
    instances.push(instance)
    return instance
  }

  return { id, root, counter, credential, declaration, secondDeclaration, manifest, control, target, lease, directory,
    rootBefore: rootBefore.items, high, config, reopen, saves: () => saves, closes: () => closes }
}

describe('canonical mounted filesystem startup', { timeout: 30_000 }, () => {
  it('adopts the exact node-owned resource before public reads and preserves durable positions and delivery', async t => {
    const f = await setup(t)
    const instance = await f.reopen()

    assert.deepEqual(f.control.actors, [`n:${f.declaration.$id}`])
    const records = (await f.root.scan({ range: { journal: '/' }, budget: scanBudget() })).items
      .slice(f.rootBefore.length)
    assert.ok(records.length > 0)
    assert.ok(records.every(record => comparePositions(record.pos, f.high) > 0))
    assert.equal(records.filter(record => record.intake !== undefined).length, 1)
    const intake = records.find(record => record.intake !== undefined)?.intake
    assert.ok(intake)
    assert.equal(intake.domains[f.target.store.domain], f.lease.epoch)
    assert.equal(instance.writer.intake.epoch, intake.epoch)
    assert.equal((await f.lease.load())?.instance, f.id)

    const admin = await instance.openSession(f.credential)
    const delivery = drainSession(admin)
    const original = await readNode(admin, '/data/doc')
    assert.equal(original.$id, 'p:/data/doc')
    assert.equal(original.count, 10)

    const watcher = await instance.openSession(f.credential)
    const frames = watcher.lane[Symbol.asyncIterator]()
    assert.equal((await nextFrame(frames)).t, 'welcome')
    const sub = watcher.sub({ node: '/data/doc' })
    const snap = await nextFrame(frames)
    assert.ok(snap.t === 'snap')
    assert.equal(snap.sub, sub)
    assert.deepEqual(snap.list, [original.$id])

    let sequence = 0
    const key = () => ({ epoch: instance.writer.intake.epoch, time: Date.now(), nonce: `edit-${sequence++}` })
    const edited = await admin.commit({ opId: key(), changes: [
      { op: 'patch', path: '/data/doc', ops: { $set: { count: 20 } } },
    ] }).outcome
    assert.ok(edited.pos)

    const update = await nextFrame(frames)
    assert.ok(update.t === 'pos' && update.coverage !== true)
    assert.ok(comparePositions(update.pos, edited.pos) >= 0)
    assert.ok(update.changes.some(change => change.op === 'patch' && change.id === original.$id
      || change.op === 'put' && 'node' in change.copy && change.copy.node.$id === original.$id))
    watcher.close()
    await admin.act({ path: '/data/doc', action: 'increment', args: {}, opId: key() }).outcome
    assert.equal((await readNode(admin, '/data/doc')).count, 21)
    const removed = await admin.commit({ opId: key(), changes: [{ op: 'remove', path: '/data/doc' }] }).outcome
    assert.ok(removed.pos)
    const history = await admin.read({ history: '/data' })
    assert.ok(history.history?.some(entry => entry.address.id === original.$id && entry.after === null))
    await admin.commit({ opId: key(), changes: [
      { op: 'restore', record: { id: original.$id, pos: removed.pos } },
    ] }).outcome
    const restored = await readNode(admin, '/data/doc')
    assert.equal(restored.$id, original.$id)
    assert.equal(restored.count, 21)
    assert.equal(instance.writer.intake.epoch, intake.epoch)
    await instance.close()
    await delivery
    assert.equal(f.closes(), 1)
    assert.equal((await f.root.scan({ range: { node: '/data' }, budget: scanBudget() })).items[0].$id,
      f.declaration.$id)
    assert.ok(await f.counter.load())

    const lease = await openPersistentWriter({ directory: join(f.directory, '.treenix'), instance: f.id })
    const store = await createFsStore({ directory: f.directory, lease, logicalBase: '/data' })
    t.after(async () => { await store.close(); await lease.close() })
    assert.ok(lease.writerEpoch > f.lease.writerEpoch)
    const durable = (await store.scan({ range: { node: '/data/doc' }, budget: scanBudget() })).items[0]
    assert.equal(durable.$id, original.$id)
    assert.equal(durable.count, 21)
  })

  it('rejects a stale declaration revision before counter effects and releases the owned target once', async t => {
    const f = await setup(t)
    const saves = f.saves()
    await assert.rejects(createInstance(f.config(f.manifest, positionToRev(f.high))), code('CONFLICT'))
    assert.equal(f.saves(), saves)
    assert.equal(f.control.actors.length, 0)
    assert.equal(f.closes(), 1)
    assert.deepEqual((await f.root.scan({ range: { journal: '/' }, budget: scanBudget() })).items, f.rootBefore)
    assert.ok(await f.counter.load())
  })

  it('refuses a foreign persisted type owner before effects while keeping the borrowed root usable', async t => {
    const f = await setup(t)
    const foreign: ModuleManifest = { ...f.manifest, id: 'foreign-owner',
      types: f.manifest.types.map(type => ({ ...type, module: 'foreign-owner' })) }
    const saves = f.saves()
    await assert.rejects(createInstance(f.config(foreign)), code('FORBIDDEN'))
    assert.equal(f.saves(), saves)
    assert.equal(f.control.actors.length, 0)
    assert.equal(f.closes(), 1)
    assert.equal((await f.root.scan({ range: { node: '/data' }, budget: scanBudget() })).items[0].$id,
      f.declaration.$id)
  })

  it('releases the pinned Fs target once when its genuine node-session factory refuses startup', async t => {
    const f = await setup(t)
    f.control.failure = new KernelError('UNAVAILABLE', 'Target factory refuses startup')
    await assert.rejects(f.reopen(), code('UNAVAILABLE'))
    assert.deepEqual(f.control.actors, [`n:${f.declaration.$id}`])
    assert.equal(f.closes(), 1)
    assert.ok(await f.counter.load())
    assert.equal((await f.root.scan({ range: { node: '/data' }, budget: scanBudget() })).items[0].$id,
      f.declaration.$id)
    const lease = await openPersistentWriter({ directory: join(f.directory, '.treenix'), instance: f.id })
    const store = await createFsStore({ directory: f.directory, lease, logicalBase: '/data' })
    t.after(async () => { await store.close(); await lease.close() })
    assert.equal((await store.scan({ range: { node: '/data/doc' }, budget: scanBudget() })).items[0].count, 10)
  })

  it('rejects a different factory resource and closes both acquired target owners once', async t => {
    const f = await setup(t)
    const factory = createMemoryMountHandler(18)
    let alternateCloses = 0
    f.control.replacement = async (decl, session) => {
      const actual = await factory(decl, session)
      const alternate = { ...actual, async close() { alternateCloses++; await actual.close() } }
      t.after(async () => { if (alternateCloses === 0) await alternate.close() })
      return alternate
    }
    await assert.rejects(createInstance(f.config()), code('UNAVAILABLE'))
    assert.equal(alternateCloses, 1)
    assert.equal(f.closes(), 1)
  })

  it('refuses a cold startup identity collision before root effects', async t => {
    const f = await setup(t)
    const store = f.target.store
    const original = (await store.scan({ range: { node: '/data/doc' }, budget: scanBudget() })).items[0]
    assert.ok(original)
    const pos = { ...f.high, seq: f.high.seq + 1 }
    const duplicate = { ...original, $id: f.declaration.$id, $pos: pos }
    await f.lease.save(pos, f.lease.writerEpoch)
    await store.commit({ pos, writerEpoch: f.lease.writerEpoch,
      writes: [{ path: duplicate.$path, node: duplicate }],
      record: { pos, kind: 'reconcile', caller: 'kernel', executor: 'kernel', entries: [
        { id: duplicate.$id, path: duplicate.$path, change: { t: 'reconcile', before: original, after: duplicate } },
      ] } })
    const saves = f.saves()

    await assert.rejects(f.reopen(), code('INVALID'))

    assert.equal(f.saves(), saves)
    assert.deepEqual((await f.root.scan({ range: { journal: '/' }, budget: scanBudget() })).items, f.rootBefore)
    assert.equal(f.closes(), 1)
    assert.equal(f.control.actors.length, 0)
  })

  it('rejects identity collisions between startup Stores before any root effects', async t => {
    const f = await setup(t, true)
    assert.ok(f.secondDeclaration)
    const original = (await f.target.store.scan({ range: { node: '/data/doc' }, budget: scanBudget() })).items[0]
    assert.ok(original)
    const pos = { ...f.high, seq: f.high.seq + 1 }
    const duplicate = { ...original, $id: randomUUID(), $pos: pos }
    await f.lease.save(pos, f.lease.writerEpoch)
    await f.target.store.commit({ pos, writerEpoch: f.lease.writerEpoch,
      writes: [{ path: duplicate.$path, node: duplicate }],
      record: { pos, kind: 'reconcile', caller: 'kernel', executor: 'kernel', entries: [
        { id: duplicate.$id, path: duplicate.$path, change: { t: 'reconcile', before: original, after: duplicate } },
      ] } })

    const store = createMemoryStore({ domain: `second-target:${randomUUID()}` })
    const node = { ...duplicate, $path: '/archive/doc' }
    await store.commit({ pos, writerEpoch: 1, writes: [{ path: node.$path, node }],
      record: { pos, kind: 'kernel', caller: 'kernel', executor: 'kernel', entries: [
        { id: node.$id, path: node.$path, change: { t: 'create', after: node } },
      ] } })
    let closes = 0
    const target: OpenedStoreMountTarget = {
      kind: 'store', store,
      resources: { writerEpoch: 1, epoch: randomUUID(), persistent: false, decisionHistory: 'fresh' },
      async close() { closes++; store.close() },
    }
    t.after(() => store.close())
    const config = f.config()
    const saves = f.saves()

    await assert.rejects(createInstance({ ...config, provisioning: { ...config.provisioning,
      mounts: [...config.provisioning.mounts ?? [], {
        node: f.secondDeclaration.$id, component: '#mount', revision: f.secondDeclaration.$rev, target,
      }],
    } }), code('INVALID'))

    assert.equal(f.saves(), saves)
    assert.deepEqual((await f.root.scan({ range: { journal: '/' }, budget: scanBudget() })).items, f.rootBefore)
    assert.equal(f.closes(), 1)
    assert.equal(closes, 1)
    assert.equal(f.control.actors.length, 0)
  })
})
