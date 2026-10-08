import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { describe, it } from 'node:test'

import { KernelError } from '#errors'
import { createMemoryBlobStore } from '#kernel/blob-store-memory'
import { createInstance } from '#kernel/instance'
import { createMemoryMountHandler, createMemoryMountManifest } from '#kernel/mount-memory'
import { createMountTable } from '#kernel/mounts'
import { createRegistry } from '#kernel/registry'
import { drainSession } from '#kernel/session-delivery'
import { scanBudget } from '#kernel/store/contract'
import { createMemoryStore } from '#kernel/store/memory'
import { R, type ChangeMember, type InstanceConfig, type ModuleManifest, type MountHandler, type Node, type OpenedStoreMountTarget,
  type Position, type Session } from '#kernel/types'

const code = (expected: KernelError['code']) => (error: unknown) => error instanceof KernelError && error.code === expected

/** Hold a specific lifecycle boundary without time-based scheduling assumptions. */
function latch() {
  let release: () => void = () => { throw new Error('Latch has not been initialized') }
  const wait = new Promise<void>(resolve => { release = resolve })
  return { wait, release }
}

/** Pure preflight tests never create a successful substitute activation or Session. */
function preflight(declarationTypes?: ReadonlySet<string>) {
  const registry = createRegistry()
  registry.publish(createMemoryMountManifest(0))
  const table = createMountTable({ registry, declarationTypes,
    openSession: async () => { throw new Error('Preflight cannot open a Session') },
    activate: async () => { throw new Error('Preflight cannot activate a target') },
    retire: async () => { throw new Error('Preflight has no registered resources') },
    changed: () => {}, failed: error => { throw error },
  })
  return { registry, table }
}

/** Supply the full accepted declaration shape consumed by the table boundary. */
function declaration(path: string, pattern: string, id = path, revision = '1'): Node {
  return { $path: path, $id: id, $rev: revision, $type: 't.dir',
    '#mount': { $type: 't.mount.memory', pattern } }
}

/** Own a counter only for this actual ephemeral Store's lifetime. */
async function fixture(handler?: MountHandler, writerEpoch = 1) {
  const id = `mount:${randomUUID()}`
  const root = createMemoryStore({ domain: id })
  let saved: Position | undefined, issued = 0
  const memory = createMemoryMountHandler(writerEpoch)
  const module: ModuleManifest = {
    id: 'mount-tests',
    types: [{ name: 'test.mount.memory', module: 'mount-tests', security: 'user-capability', version: 0,
      schema: { type: 'object', required: ['pattern'], properties: { pattern: { type: 'string' } } }, actions: {} }],
    security: [{ type: 'test.mount.memory', context: 'mount', handler: handler ?? memory }], open: [],
  }
  const config: InstanceConfig = { id, root: { kind: 'store', store: root },
    provisioning: { writerEpoch, counter: {
      async load() { return saved }, async save(position) { saved = position },
      async freshEpoch(floor) { issued = Math.max(issued, floor) + 1; return issued },
    }, domains: [{ store: root, epoch: randomUUID(), persistent: false }], credentialTtlMs: 60_000,
    bootstrap: { kind: 'fresh', admin: { path: '/admin', name: 'admin', password: 'mount-test-password' } } },
    blobs: createMemoryBlobStore(), modules: [module],
  }
  const instance = await createInstance(config)
  assert.ok(instance.setupCredential)
  const admin = await instance.openSession(instance.setupCredential)
  const delivered = drainSession(admin)

  /** Submit mutations through the actual Session and ordered delivery channel. */
  async function commit(changes: readonly ChangeMember[]) {
    return admin.commit({ changes,
      opId: { epoch: instance.writer.intake.epoch, time: Date.now(), nonce: randomUUID() } }).outcome
  }

  /** Create the declaring node and its ordinary parent addresses in the root Store. */
  async function mount(pattern = '*/stats') {
    await commit([
      { op: 'put', node: { $path: '/data', $type: 't.dir', '#mount': { $type: 'test.mount.memory', pattern } } },
      { op: 'put', node: { $path: '/data/a', $type: 't.dir' } },
      { op: 'put', node: { $path: '/data/b', $type: 't.dir' } },
    ])
  }

  /** Release owned mounts/lanes while leaving the borrowed root Store usable. */
  async function close() {
    await instance.close()
    await delivered
  }
  return { instance, config, root, admin, commit, mount, close }
}

describe('native mount declaration preflight', { timeout: 10_000 }, () => {
  it('rejects missing startup keys before opening any requested declaration', async () => {
    const { table } = preflight()
    table.publish(table.stage([table.declarationsOf(declaration('/data', '*/stats'))]))
    const key = table.ranges()[0].key
    await assert.rejects(table.prepareKeys([key, 'missing'], scanBudget()), code('UNAVAILABLE'))
    assert.equal(table.ranges()[0].state, 'idle')
    await table.close()
  })

  it('compiles relative wildcard roots and their descendants without claiming the declaring node', () => {
    const { table } = preflight()
    const staged = table.stage([table.declarationsOf(declaration('/data', '*/stats'))])
    assert.equal(table.resolve('/data/a/stats'), undefined)
    table.publish(staged)
    const range = table.ranges()[0]
    assert.equal(range.start('/data/a/stats'), '/data/a/stats')
    assert.equal(range.start('/data/b/stats/count'), '/data/b/stats')
    assert.equal(range.contains('/data/a/stats-more'), false)
    assert.equal(range.contains('/data/a'), false)
    assert.equal(range.intersects({ children: '/data' }), false)
    assert.equal(range.intersects({ children: '/data/a' }), true)
    assert.equal(range.intersects({ subtree: '/data' }), true)
    assert.throws(() => table.resolve('/data/a/stats'), code('UNAVAILABLE'))
  })

  it('keeps an empty template declaration in its parent Store and claims only descendants', () => {
    const { table } = preflight()
    table.publish(table.stage([table.declarationsOf(declaration('/data', ''))]))
    assert.equal(table.resolve('/data'), undefined)
    assert.equal(table.ranges()[0].start('/data/doc'), '/data')
    assert.equal(table.boundary('/data'), true)
    assert.throws(() => table.resolve('/data/doc'), code('UNAVAILABLE'))
  })

  it('treats a literal star in the declaring path as a literal address', () => {
    const { table } = preflight()
    table.publish(table.stage([table.declarationsOf(declaration('/data/*', 'stats'))]))
    assert.equal(table.ranges()[0].contains('/data/other/stats'), false)
    assert.equal(table.ranges()[0].contains('/data/*/stats'), true)
  })

  it('rejects overlapping templates atomically and retains the preceding topology', () => {
    const { table } = preflight()
    table.publish(table.stage([table.declarationsOf(declaration('/data', '*/stats'))]))
    const before = table.topology({ subtree: '/' })
    assert.throws(() => table.stage([
      table.declarationsOf(declaration('/data/a', 'stats', 'other')),
      table.declarationsOf(declaration('/other', '', 'third')),
    ]), code('INVALID'))
    assert.equal(table.topology({ subtree: '/' }), before)
    assert.equal(table.ranges().length, 1)
  })

  it('allows disjoint siblings and rejects ancestor ownership that would shadow a target', () => {
    const { table } = preflight()
    table.publish(table.stage([
      table.declarationsOf(declaration('/data', 'a/stats', 'a')),
      table.declarationsOf(declaration('/data', 'b/stats', 'b')),
    ]))
    assert.equal(table.ranges().length, 2)
    assert.throws(() => table.stage([table.declarationsOf(declaration('/data', '', 'ancestor'))]), code('INVALID'))
  })

  it('rejects malformed relative templates and settings at extraction', () => {
    const { table } = preflight()
    for (const pattern of ['/absolute', '../outside', 'a//b', 'a/', '**/stats', 'a?b']) {
      assert.throws(() => table.stage([table.declarationsOf(declaration('/data', pattern))]), code('INVALID'))
    }
    const malformed: Node = { ...declaration('/data', ''), '#mount': { $type: 't.mount.memory', pattern: 7 } }
    assert.throws(() => table.declarationsOf(malformed), code('INVALID'))
    assert.equal(table.ranges().length, 0)
  })

  it('invalidates a staged declaration if another accepted topology was published first', () => {
    const { table } = preflight()
    const stale = table.stage([table.declarationsOf(declaration('/a', ''))])
    table.publish(table.stage([table.declarationsOf(declaration('/b', ''))]))
    assert.throws(() => table.validateStage(stale), code('CONFLICT'))
    assert.equal(table.ranges()[0].base, '/b')
  })

  it('keeps topology and generation stable for unrelated accepted node changes', () => {
    const registry = createRegistry()
    registry.publish(createMemoryMountManifest(0))
    let changed = 0
    const table = createMountTable({ registry,
      openSession: async () => { throw new Error('Preflight cannot open a Session') },
      activate: async () => { throw new Error('Preflight cannot activate a target') },
      retire: async () => { throw new Error('Preflight has no registered resources') },
      changed: () => { changed++ }, failed: error => { throw error },
    })
    table.publish(table.stage([table.declarationsOf(declaration('/data', ''))]))
    const before = table.topology({ subtree: '/' }), ranges = table.ranges()
    table.publish(table.stage([{ id: 'ordinary-node', declarations: [] }]))
    assert.equal(changed, 1)
    assert.equal(table.ranges(), ranges)
    assert.equal(table.topology({ subtree: '/' }), before)
  })

  it('retains an unavailable claim until the exact owner publishes its mount handler', () => {
    const { registry, table } = preflight()
    registry.publish({ ...createMemoryMountManifest(0), security: [] })
    table.publish(table.stage([table.declarationsOf(declaration('/data', ''))]))
    const before = table.topology({ subtree: '/data' })
    assert.throws(() => table.resolve('/data/doc'), code('UNAVAILABLE'))
    registry.publish(createMemoryMountManifest(0))
    table.registryChanged()
    assert.notEqual(table.topology({ subtree: '/data' }), before)
    assert.equal(table.ranges()[0].state, 'idle')
    assert.throws(() => table.resolve('/data/doc'), code('UNAVAILABLE'))
  })

  it('keeps configured main-component claims unavailable before their owner publishes', () => {
    const { registry, table } = preflight(new Set(['test.mount.memory']))
    const node: Node = { $id: 'declaring-node', $path: '/data', $rev: '1',
      $type: 'test.mount.memory', pattern: '' }
    assert.throws(() => table.declarationsOf({ ...node, pattern: 7 }), code('INVALID'))
    table.publish(table.stage([table.declarationsOf(node)]))
    assert.equal(table.ranges().length, 1)
    assert.throws(() => table.resolve('/data/doc'), code('UNAVAILABLE'))

    registry.publish({ id: 'mount-tests', types: [{ name: 'test.mount.memory', module: 'mount-tests',
      security: 'user-capability', version: 0, schema: {}, actions: {} }],
      security: [{ type: 'test.mount.memory', context: 'mount', handler: createMemoryMountHandler(0) }], open: [] })
    table.registryChanged()
    assert.equal(table.ranges()[0].state, 'idle')
    assert.throws(() => table.resolve('/data/doc'), code('UNAVAILABLE'))
  })
})

describe('native memory targets through the canonical Instance', { timeout: 10_000 }, () => {
  it('rebinds a configured main mount on reopen before exposing any shadowed parent data', async () => {
    const memory = createMemoryMountHandler(1)
    let opened = 0
    const f = await fixture(async (node, session) => {
      opened++
      return memory(node, session)
    })
    assert.ok(f.instance.setupCredential)
    const credential = f.instance.setupCredential
    try {
      await f.commit([
        { op: 'put', node: { $path: '/data', $type: 'test.mount.memory', pattern: '' } },
        { op: 'put', node: { $path: '/data/doc', $type: 't.dir', value: 'shadowed-parent' } },
      ])
      await assert.rejects(f.admin.read({ node: '/data/doc' }), code('NOT_FOUND'))
      assert.equal(opened, 1)
      const stored = await f.root.scan({ range: { node: '/data/doc' }, budget: scanBudget() })
      assert.equal(stored.items[0].value, 'shadowed-parent')
    } finally { await f.close() }

    const reopened = await createInstance({ ...f.config, provisioning: { ...f.config.provisioning,
      writerEpoch: 2, bootstrap: { kind: 'reopen', installerCredential: credential },
    } })
    const admin = await reopened.openSession(credential)
    const delivered = drainSession(admin)
    try {
      await assert.rejects(admin.read({ node: '/data/doc' }), code('NOT_FOUND'))
      assert.equal(opened, 2)
    } finally {
      await reopened.close()
      await delivered
    }
  })

  it('opens one actual target for concurrent first access and every wildcard match', async t => {
    const memory = createMemoryMountHandler(1)
    let opened = 0, target: OpenedStoreMountTarget | undefined
    const f = await fixture(async (node, session) => {
      opened++
      const created = await memory(node, session)
      assert.equal(created.kind, 'store')
      target = created
      return created
    })
    t.after(f.close)
    await f.mount()
    await Promise.all([
      assert.rejects(f.admin.read({ node: '/data/a/stats' }), code('NOT_FOUND')),
      assert.rejects(f.admin.read({ node: '/data/b/stats' }), code('NOT_FOUND')),
    ])
    assert.equal(opened, 1)
    assert.ok(target)
    assert.equal(target.resources.decisionHistory, 'fresh')
    assert.equal(target.resources.persistent, false)
    await f.commit([
      { op: 'put', node: { $path: '/data/a/stats', $type: 't.dir', count: 1 } },
      { op: 'put', node: { $path: '/data/b/stats', $type: 't.dir', count: 2 } },
    ])
    const read = await f.admin.read({ children: '/data/a' })
    assert.equal(read.list.length, 1)
    const copy = read.copies[0]
    assert.ok('node' in copy)
    assert.equal(copy.node.$path, '/data/a/stats')
    assert.equal((await f.root.scan({ range: { node: '/data/a/stats' }, budget: scanBudget() })).items.length, 0)
    assert.equal((await target.store.scan({ range: { subtree: '/data' }, budget: scanBudget() })).items.length, 2)
  })

  it('invokes the exact owner handler with the genuine declaring-node grants', async t => {
    const memory = createMemoryMountHandler(1)
    let seen: Session | undefined
    const f = await fixture(async (node, session) => {
      seen = session
      assert.equal(session.actor.principal, `n:${node.$id}`)
      assert.deepEqual(session.actor.claims, [session.actor.principal])
      assert.equal((await session.read({ node: '/allowed' })).list.length, 1)
      await assert.rejects(session.read({ node: '/other' }), code('NOT_FOUND'))
      return memory(node, session)
    })
    t.after(f.close)
    await f.mount()
    await f.commit([{ op: 'put', node: { $path: '/allowed', $type: 't.dir' } },
      { op: 'put', node: { $path: '/other', $type: 't.dir' } }])
    const copy = (await f.admin.read({ node: '/data' })).copies[0]
    assert.ok('node' in copy)
    await f.admin.commit({ opId: { epoch: f.instance.writer.intake.epoch, time: Date.now(), nonce: randomUUID() },
      expect: { nodes: [{ path: '/data', rev: copy.node.$rev }] }, changes: [{ op: 'patch', path: '/allowed',
        ops: { $set: { $acl: [{ subject: { group: `n:${copy.node.$id}` }, grant: R }] } } }] }).outcome
    await assert.rejects(f.admin.read({ node: '/data/a/stats' }), code('NOT_FOUND'))
    assert.ok(seen)
  })

  it('evicts a failed opening and closes its Session before a successful retry', async t => {
    const memory = createMemoryMountHandler(1)
    const sessions: Session[] = []
    const f = await fixture(async (node, session) => {
      sessions.push(session)
      if (sessions.length === 1) throw new KernelError('UNAVAILABLE', 'Target initialization failed')
      return memory(node, session)
    })
    t.after(f.close)
    await f.mount()
    await assert.rejects(f.admin.read({ node: '/data/a/stats' }), code('UNAVAILABLE'))
    await assert.rejects(async () => sessions[0].read({ node: '/allowed' }), code('CANCELLED'))
    await assert.rejects(f.admin.read({ node: '/data/b/stats' }), code('NOT_FOUND'))
    assert.equal(sessions.length, 2)
  })

  it('rejects trusted memory mounts before activation because they cannot report external edits', async t => {
    const f = await fixture()
    t.after(f.close)
    await f.commit([{ op: 'put', node: { $path: '/data', $type: 't.dir',
      '#mount': { $type: 'test.mount.memory', pattern: '', external: 'trusted' } } }])
    await assert.rejects(f.admin.read({ node: '/data/doc' }), code('INVALID'))
    assert.equal((await f.root.scan({ range: { node: '/data/doc' }, budget: scanBudget() })).items.length, 0)
  })

  it('rejects declared View sources from a user-capability owner before activation', async t => {
    let closed = 0
    const f = await fixture(async () => ({ kind: 'view', executor: 'node', sources: ['/private'],
      derive: async () => { throw new Error('A refused View cannot derive') },
      async close() { closed++ },
    }))
    t.after(f.close)
    await f.mount()
    await assert.rejects(f.admin.read({ node: '/data/a/stats' }), code('FORBIDDEN'))
    assert.equal(closed, 1)
  })

  it('refuses explicit handler reads of its own unopened target without a recursive wait', async t => {
    const memory = createMemoryMountHandler(1)
    let checked = false
    const f = await fixture(async (node, session) => {
      await assert.rejects(session.read({ node: '/data/a/stats' }), code('UNAVAILABLE'))
      checked = true
      return memory(node, session)
    })
    t.after(f.close)
    await f.mount()
    await assert.rejects(f.admin.read({ node: '/data/a/stats' }), code('NOT_FOUND'))
    assert.equal(checked, true)
  })

  it('rejects an overlapping declaration atomically through the actual Session', async t => {
    const f = await fixture()
    t.after(f.close)
    await f.mount()
    await assert.rejects(f.commit([
      { op: 'patch', path: '/data/a', ops: { $set: { '#mount': { $type: 'test.mount.memory', pattern: 'stats' } } } },
      { op: 'put', node: { $path: '/unrelated', $type: 't.dir' } },
    ]), code('INVALID'))
    const parent = (await f.root.scan({ range: { node: '/data/a' }, budget: scanBudget() })).items[0]
    assert.equal(parent['#mount'], undefined)
    assert.equal((await f.root.scan({ range: { node: '/unrelated' }, budget: scanBudget() })).items.length, 0)
  })

  it('rejects writes across two actual memory targets without accepting either half', async t => {
    const f = await fixture()
    t.after(f.close)
    await f.commit([
      { op: 'put', node: { $path: '/left', $type: 't.dir', '#mount': { $type: 'test.mount.memory', pattern: '' } } },
      { op: 'put', node: { $path: '/right', $type: 't.dir', '#mount': { $type: 'test.mount.memory', pattern: '' } } },
    ])
    await assert.rejects(f.commit([
      { op: 'put', node: { $path: '/left/doc', $type: 't.dir' } },
      { op: 'put', node: { $path: '/right/doc', $type: 't.dir' } },
    ]), code('CROSS_DOMAIN'))
    await assert.rejects(f.admin.read({ node: '/left/doc' }), code('NOT_FOUND'))
    await assert.rejects(f.admin.read({ node: '/right/doc' }), code('NOT_FOUND'))
  })

  it('removes the root-owned parent subtree while retaining a mounted child in its actual Store', async t => {
    const f = await fixture()
    t.after(f.close)
    await f.mount()
    await f.commit([{ op: 'put', node: { $path: '/data/a/stats', $type: 't.dir', count: 1 } }])
    await f.commit([{ op: 'remove', path: '/data/a' }])
    assert.equal((await f.root.scan({ range: { node: '/data/a' }, budget: scanBudget() })).items.length, 0)
    const copy = (await f.admin.read({ node: '/data/a/stats' })).copies[0]
    assert.ok('node' in copy)
    assert.equal(copy.node.count, 1)
  })

  it('closes an off-route opening exactly once after the accepted declaration is removed', async t => {
    const entered = latch(), release = latch()
    const memory = createMemoryMountHandler(1)
    let target: OpenedStoreMountTarget | undefined, closed = 0
    const f = await fixture(async (node, session) => {
      const opened = await memory(node, session)
      let released = false
      target = { ...opened, async close() {
        if (released) return
        released = true
        closed++
        await opened.close()
      } }
      entered.release()
      await release.wait
      return target
    })
    t.after(f.close)
    await f.mount()
    const pending = assert.rejects(f.admin.read({ node: '/data/a/stats' }), code('CONFLICT'))
    await entered.wait
    await f.commit([{ op: 'patch', path: '/data', ops: { $unset: { '#mount': true } } }])
    release.release()
    await pending
    assert.equal(closed, 1)
    assert.ok(target)
    await assert.rejects(target.store.scan({ range: { subtree: '/' }, budget: scanBudget() }), code('UNAVAILABLE'))
    await f.commit([{ op: 'put', node: { $path: '/after', $type: 't.dir' } }])
    assert.equal((await f.root.scan({ range: { node: '/after' }, budget: scanBudget() })).items.length, 1)
  })

  it('delivers actual mounted subscriptions and covering positions from the same Session pipeline', async t => {
    const f = await fixture()
    t.after(f.close)
    await f.mount()
    await f.commit([{ op: 'put', node: { $path: '/data/a/stats', $type: 't.dir', count: 1 } }])
    assert.ok(f.instance.setupCredential)
    const watching = await f.instance.openSession(f.instance.setupCredential)
    const frames = watching.lane[Symbol.asyncIterator]()
    const welcome = await frames.next()
    assert.ok(!welcome.done && welcome.value.t === 'welcome')
    const sub = watching.sub({ node: '/data/a/stats' })
    const snap = await frames.next()
    assert.ok(!snap.done && snap.value.t === 'snap' && snap.value.sub === sub)
    const copy = snap.value.copies[0]
    assert.ok('node' in copy)
    assert.equal(copy.node.count, 1)
    const committed = await f.commit([{ op: 'patch', path: '/data/a/stats', ops: { $set: { count: 2 } } }])
    const update = await frames.next()
    assert.ok(!update.done && update.value.t === 'pos' && !update.value.coverage)
    assert.deepEqual(update.value.pos, committed.pos)
    assert.ok(update.value.changes.some(change => change.op === 'patch' || change.op === 'put'))
    await frames.return?.()
  })

  it('preserves target content and subscription generation when unrelated declaration fields change', async t => {
    const memory = createMemoryMountHandler(1)
    let opened = 0
    const f = await fixture(async (node, session) => {
      opened++
      assert.equal(node.unrelated, undefined)
      return memory(node, session)
    })
    t.after(f.close)
    await f.mount()
    await f.commit([{ op: 'put', node: { $path: '/data/a/stats', $type: 't.dir', count: 1 } }])
    assert.ok(f.instance.setupCredential)
    const watching = await f.instance.openSession(f.instance.setupCredential)
    const frames = watching.lane[Symbol.asyncIterator]()
    assert.equal((await frames.next()).value?.t, 'welcome')
    watching.sub({ node: '/data/a/stats' })
    assert.equal((await frames.next()).value?.t, 'snap')
    await f.commit([{ op: 'patch', path: '/data', ops: { $set: {
      unrelated: { payload: ['ordinary', 'fields'] }, '#other': { $type: 't.dir', value: 2 },
    } } }])
    const frame = await frames.next()
    assert.ok(!frame.done && frame.value.t === 'pos' && !frame.value.coverage)
    assert.equal(opened, 1)
    const copy = (await f.admin.read({ node: '/data/a/stats' })).copies[0]
    assert.ok('node' in copy)
    assert.equal(copy.node.count, 1)
    await frames.return?.()
  })

  it('shares one actual release when Writer fencing fails before acceptance', async t => {
    let closed = 0, target: OpenedStoreMountTarget | undefined
    const f = await fixture(async () => {
      const store = createMemoryStore({ domain: `failing:${randomUUID()}`,
        beforeRecord() { throw new KernelError('UNAVAILABLE', 'Injected target fence failure') } })
      target = { kind: 'store', store, resources: { writerEpoch: 1, epoch: randomUUID(),
        persistent: false, decisionHistory: 'fresh' }, async close() { closed++; store.close() } }
      return target
    })
    t.after(f.close)
    await f.mount()
    await assert.rejects(f.admin.read({ node: '/data/a/stats' }), code('UNAVAILABLE'))
    assert.equal(closed, 1)
    assert.ok(target)
    await assert.rejects(target.store.scan({ range: { subtree: '/' }, budget: scanBudget() }), code('UNAVAILABLE'))
    await f.commit([{ op: 'put', node: { $path: '/after', $type: 't.dir' } }])
    assert.equal((await f.root.scan({ range: { node: '/after' }, budget: scanBudget() })).items.length, 1)
  })

  it('accepts actual in-process token zero and releases only its owned target on shutdown', async () => {
    const memory = createMemoryMountHandler(0)
    let target: OpenedStoreMountTarget | undefined
    const f = await fixture(async (node, session) => {
      const opened = await memory(node, session)
      target = opened
      return opened
    }, 0)
    try {
      await f.mount()
      await assert.rejects(f.admin.read({ node: '/data/a/stats' }), code('NOT_FOUND'))
      assert.ok(target)
      assert.equal(target.resources.writerEpoch, 0)
    } finally { await f.close() }
    assert.ok(target)
    await target.close()
    await assert.rejects(target.store.scan({ range: { subtree: '/' }, budget: scanBudget() }), code('UNAVAILABLE'))
    assert.equal((await f.root.scan({ range: { node: '/data' }, budget: scanBudget() })).items.length, 1)
  })
})
