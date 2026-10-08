import assert from 'node:assert/strict'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { KernelError } from '#errors'
import { prepareCredential } from '#kernel/auth/credentials'
import { createInstanceFoundation } from '#kernel/instance'
import { openPersistentWriter, type PersistentWriter } from '#kernel/persistence'
import { scanBudget } from '#kernel/store/contract'
import { createFsStore } from '#kernel/store/fs'
import { createMemoryStore } from '#kernel/store/memory'
import { A, R, W, type ActRequest, type Gate, type ModuleManifest, type OpId, type Position, type RightsRule, type Store } from '#kernel/types'

const code = (expected: KernelError['code']) => (error: unknown) => error instanceof KernelError && error.code === expected
const ALL = R | W | A
const manifest: ModuleManifest = { id: 'post-actions', types: [{ name: 'post.document', module: 'post-actions', security: 'ordinary',
  version: 0, schema: {}, actionsOnly: true, actions: {
    increment: { kind: 'write', args: { type: 'object', properties: { ticket: { type: 'string' } }, required: ['ticket'] },
      pre: { 'node.status': 'ready' }, post: { '': { $inc: { count: 1 } } } },
    unchanged: { kind: 'write', args: {}, post: {} },
    transfer: { kind: 'write', args: {}, needs: { stock: { node: '../stock' } },
      pre: { 'needs.stock.copies.0.node.stock': { $gt: 0 } }, post: { '': { $inc: { count: 1 } }, stock: { $inc: { stock: -1 } } } },
    children: { kind: 'write', args: {}, needs: { items: { children: '../items', where: { selected: true } } },
      post: { items: { $inc: { count: 1 } } } },
    included: { kind: 'write', args: {}, needs: { stock: { node: '../stock', include: [{ path: '../items/other' }] } },
      post: { stock: { $inc: { stock: -1 } } } },
    inspect: { kind: 'read', args: {}, handler: async () => 'read' },
    handled: { kind: 'write', args: {}, post: {}, handler: async () => 'handled' },
    elevated: { kind: 'setuid', args: {}, post: {} },
    external: { kind: 'write', args: {}, io: true, post: {} },
    historical: { kind: 'write', args: {}, needs: { history: { history: '.' } }, post: {} },
  } }], security: [{ type: 'post.document', context: 'acl', handler: () => ALL }], open: [] }

function signal() {
  let resolve: () => void = () => {}
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
async function setup(gates: readonly Gate[] = [], store?: Store, lease?: PersistentWriter) {
  const root = store ?? createMemoryStore({ domain: 'post-actions' })
  let saved: Position | undefined
  const options = { id: 'post-actions', root, writerEpoch: lease === undefined ? 1 : lease.writerEpoch,
    domains: [{ store: root, epoch: lease === undefined ? 'post1' : lease.epoch, persistent: true }],
    counter: lease ?? { async load() { return saved }, async save(pos: Position) { saved = { ...pos } }, async freshEpoch(floor: number) { return floor + 1 } },
    initialCredential: { ttlMs: 60_000 }, gates, budget: scanBudget }
  const instance = await createInstanceFoundation({ ...options, firstAdmin: { path: '/admin', name: 'admin', password: 'post-test-password' } })
  assert.ok(instance.setupCredential)
  const admin = instance.commands(await instance.auth.openCredential(instance.setupCredential))
  let nonce = 0
  const key = (): OpId => ({ epoch: instance.writer.intake.epoch, time: Date.now(), nonce: String(++nonce) })
  await admin.commit({ opId: key(), changes: [{ op: 'put', node: { $path: '/sys/types/post.document', $type: 't.type',
    name: 'post.document', module: 'post-actions', security: 'ordinary' } }] })
  instance.registry.publish(manifest)
  await admin.commit({ opId: key(), changes: [
    { op: 'put', node: { $path: '/work', $type: 't.dir', $acl: [{ subject: { group: 'public' }, grant: R | W }] } },
    { op: 'put', node: { $path: '/work/document', $type: 'post.document', status: 'ready', count: 0 } },
    { op: 'put', node: { $path: '/work/stock', $type: 't.dir', stock: 2 } },
    { op: 'put', node: { $path: '/work/items', $type: 't.dir' } },
    { op: 'put', node: { $path: '/work/items/selected', $type: 't.dir', selected: true, count: 0 } },
    { op: 'put', node: { $path: '/work/items/other', $type: 't.dir', selected: false, count: 0 } },
  ] })
  const commands = instance.commands(await instance.auth.openCredential())
  const request = (action = 'increment'): ActRequest => ({ path: '/work/document', action, args: { ticket: 'ticket' }, opId: key() })
  return { instance, root, admin, commands, key, request }
}

describe('native handlerless post actions', { timeout: 10_000 }, () => {
  it('executes a declared post through real actor provenance and denies direct writes to its protected type', async t => {
    const f = await setup(); t.after(() => f.instance.auth.close())
    await assert.rejects(f.commands.commit({ opId: f.key(), changes: [{ op: 'patch', path: '/work/document', ops: { $inc: { count: 1 } } }] }), code('FORBIDDEN'))
    const outcome = await f.commands.act(f.request())
    assert.ok(outcome.pos)
    assert.equal((await f.instance.source.node('/work/document'))?.count, 1)
    const records = (await f.root.scan({ range: { journal: '/' }, budget: scanBudget() })).items
    const record = records.find(row => row.decision?.opId.nonce === '4')
    assert.ok(record)
    assert.equal(record.executor, f.commands.actor.principal)
    assert.equal(record.caller, f.commands.actor.principal)
    assert.deepEqual(record.decision?.outcome, outcome)
  })

  it('validates arguments and refuses a false precondition without changing accepted data', async t => {
    const f = await setup(); t.after(() => f.instance.auth.close())
    await assert.rejects(f.commands.act({ ...f.request(), args: { ticket: 42 } }), code('INVALID'))
    await f.admin.commit({ opId: f.key(), changes: [{ op: 'patch', path: '/work/document', ops: { $set: { status: 'blocked' } } }] })
    await assert.rejects(f.commands.act(f.request()), code('CONFLICT'))
    assert.equal((await f.instance.source.node('/work/document'))?.count, 0)
  })

  it('requires read and write and never falls back to another action', async t => {
    const f = await setup(); t.after(() => f.instance.auth.close())
    await f.admin.commit({ opId: f.key(), changes: [{ op: 'patch', path: '/work', ops: { $set: { $acl: [{ subject: { group: 'public' }, grant: R }] } } }] })
    await assert.rejects(f.commands.act(f.request()), code('FORBIDDEN'))
    await assert.rejects(f.admin.act(f.request('missing')), code('NOT_FOUND'))
    assert.equal((await f.instance.source.node('/work/document'))?.count, 0)
  })

  it('reads relative declared needs and applies both targets atomically', async t => {
    const f = await setup(); t.after(() => f.instance.auth.close())
    await f.commands.act(f.request('transfer'))
    assert.equal((await f.instance.source.node('/work/document'))?.count, 1)
    assert.equal((await f.instance.source.node('/work/stock'))?.stock, 1)
  })

  it('writes only primary members of a filtered children need', async t => {
    const f = await setup(); t.after(() => f.instance.auth.close())
    await f.commands.act(f.request('children'))
    assert.equal((await f.instance.source.node('/work/items/selected'))?.count, 1)
    assert.equal((await f.instance.source.node('/work/items/other'))?.count, 0)
    assert.equal((await f.instance.source.node('/work/document'))?.count, 0)
  })

  it('resolves only the addressed component without borrowing another component action', async t => {
    const f = await setup(); t.after(() => f.instance.auth.close())
    await f.admin.commit({ opId: f.key(), changes: [{ op: 'put', node: { $path: '/work/named', $type: 't.dir',
      status: 'ready', count: 0, '#document': { $type: 'post.document' } } }] })
    await assert.rejects(f.commands.act({ ...f.request(), path: '/work/named' }), code('NOT_FOUND'))
    await assert.rejects(f.commands.act({ ...f.request(), path: '/work/named', component: '#missing' }), code('NOT_FOUND'))
    await f.commands.act({ ...f.request(), path: '/work/named', component: '#document' })
    assert.equal((await f.instance.source.node('/work/named'))?.count, 1)
    assert.equal((await f.instance.source.node('/work/document'))?.count, 0)
  })

  it('reads included nodes as dependencies without treating them as post targets', async t => {
    const f = await setup(); t.after(() => f.instance.auth.close())
    await f.commands.act(f.request('included'))
    assert.equal((await f.instance.source.node('/work/stock'))?.stock, 1)
    assert.equal((await f.instance.source.node('/work/items/other'))?.stock, undefined)
    assert.equal((await f.instance.source.node('/work/items/other'))?.count, 0)
  })

  it('replays a durable empty effect and concurrent duplicates without charging another gate', async t => {
    let calls = 0
    const f = await setup([async operation => { if (operation.kind === 'act') calls++; return 'pass' }])
    t.after(() => f.instance.auth.close())
    const request = f.request('unchanged')
    const [first, duplicate] = await Promise.all([f.commands.act(request), f.commands.act(request)])
    assert.deepEqual(duplicate, first)
    assert.deepEqual(await f.commands.act(request), first)
    assert.equal(calls, 1)
    await assert.rejects(f.commands.act({ ...request, args: { changed: true } }), code('KEY_REUSED'))
    const records = (await f.root.scan({ range: { journal: '/' }, budget: scanBudget() })).items
    const record = records.find(row => row.decision?.opId.nonce === request.opId?.nonce)
    assert.ok(record)
    assert.equal(record.entries.length, 0)
    assert.deepEqual(record.decision?.outcome, first)
  })

  it('rejects a changed need while waiting for the final writer span', async t => {
    const f = await setup(), entered = signal(), release = signal()
    t.after(() => { release.resolve(); f.instance.auth.close() })
    const finish = f.instance.writer.mutate
    t.mock.method(f.instance.writer, 'mutate', (input: Parameters<typeof finish>[0], run: Parameters<typeof finish>[1]) =>
      finish(input, input.actor.principal !== f.commands.actor.principal ? run : async span => run({ ...span, async finish(...args: Parameters<typeof span.finish>) {
        entered.resolve(); await release.promise; return span.finish(...args)
      } })))
    const pending = f.commands.act(f.request('transfer'))
    await entered.promise
    await f.admin.commit({ opId: f.key(), changes: [{ op: 'patch', path: '/work/stock', ops: { $inc: { stock: -1 } } }] })
    release.resolve()
    await assert.rejects(pending, code('CONFLICT'))
    assert.equal((await f.instance.source.node('/work/document'))?.count, 0)
    assert.equal((await f.instance.source.node('/work/stock'))?.stock, 1)
  })

  it('rejects a changed included dependency while waiting for the final writer span', async t => {
    const f = await setup(), entered = signal(), release = signal()
    t.after(() => { release.resolve(); f.instance.auth.close() })
    const mutate = f.instance.writer.mutate
    t.mock.method(f.instance.writer, 'mutate', (input: Parameters<typeof mutate>[0], run: Parameters<typeof mutate>[1]) =>
      mutate(input, input.actor.principal !== f.commands.actor.principal ? run : async span => run({ ...span, async finish(...args: Parameters<typeof span.finish>) {
        entered.resolve(); await release.promise; return span.finish(...args)
      } })))
    const pending = f.commands.act(f.request('included'))
    await entered.promise
    await f.admin.commit({ opId: f.key(), changes: [{ op: 'patch', path: '/work/items/other', ops: { $inc: { count: 1 } } }] })
    release.resolve()
    await assert.rejects(pending, code('CONFLICT'))
    assert.equal((await f.instance.source.node('/work/stock'))?.stock, 2)
    assert.equal((await f.instance.source.node('/work/items/other'))?.count, 1)
  })

  it('owns its key, target and arguments before a gate yields', async t => {
    const entered = signal(), release = signal(), observed: unknown[] = []
    const f = await setup([async operation => {
      if (operation.kind === 'act') { observed.push(operation.args); entered.resolve(); await release.promise }
      return 'pass'
    }])
    t.after(() => { release.resolve(); f.instance.auth.close() })
    const opId = { ...f.key() }, originalKey = { ...opId }, args = { ticket: 'original' }
    const request = { path: '/work/document', action: 'increment', args, opId }
    const pending = f.commands.act(request)
    await entered.promise
    opId.nonce = 'changed'; args.ticket = 'changed'; request.path = '/work/stock'; request.action = 'missing'
    release.resolve()
    const outcome = await pending
    assert.deepEqual(observed, [{ ticket: 'original' }])
    assert.equal((await f.instance.source.node('/work/document'))?.count, 1)
    assert.equal((await f.instance.source.node('/work/stock'))?.count, undefined)
    assert.deepEqual(await f.commands.act({ path: '/work/document', action: 'increment', args: { ticket: 'original' }, opId: originalKey }), outcome)
  })

  it('rejects a successful registry republish with identical digest while its gate is waiting', async t => {
    const entered = signal(), release = signal()
    const f = await setup([async operation => { if (operation.kind === 'act') { entered.resolve(); await release.promise } return 'pass' }])
    t.after(() => { release.resolve(); f.instance.auth.close() })
    const rule = (bits: number): RightsRule => () => bits
    const version: ModuleManifest = { ...manifest, security: [{ type: 'post.document', context: 'acl', handler: rule(ALL) }] }
    f.instance.registry.publish(version)
    const digest = f.instance.registry.digest, pending = f.commands.act(f.request())
    await entered.promise
    f.instance.registry.publish({ ...version, security: [{ type: 'post.document', context: 'acl', handler: rule(ALL) }] })
    assert.equal(f.instance.registry.digest, digest)
    release.resolve()
    await assert.rejects(pending, code('CONFLICT'))
    assert.equal((await f.instance.source.node('/work/document'))?.count, 0)
  })

  it('rejects a narrower actor replay without exposing the accepted outcome or repeating the effect', async t => {
    const f = await setup(); t.after(() => f.instance.auth.close())
    const prepared = prepareCredential(f.instance.bootstrap.adminId, { expiresAt: Date.now() + 60_000, scope: ['/work'] })
    await f.admin.commit({ opId: f.key(), changes: [{ op: 'put', node: prepared.node }] })
    const narrowed = f.instance.commands(await f.instance.auth.openCredential(prepared.credential))
    const request = f.request(), outcome = await f.admin.act(request)
    await assert.rejects(narrowed.act(request), code('KEY_REUSED'))
    assert.deepEqual(await f.admin.act(request), outcome)
    assert.equal((await f.instance.source.node('/work/document'))?.count, 1)
  })

  it('rejects unavailable executors, I/O and history before gates or effects', async t => {
    let calls = 0
    const f = await setup([async operation => { if (operation.kind === 'act') calls++; return 'pass' }])
    t.after(() => f.instance.auth.close())
    for (const action of ['elevated', 'external', 'historical']) {
      await assert.rejects(f.commands.act(f.request(action)), code('UNAVAILABLE'))
    }
    await assert.rejects(f.commands.act({ ...f.request(), opId: undefined }), code('INVALID'))
    assert.equal(calls, 0)
    assert.equal((await f.instance.source.node('/work/document'))?.count, 0)
  })

  it('cancels one gated action without closing its admission or applying its post', async t => {
    const entered = signal(), release = signal()
    const f = await setup([async operation => { if (operation.kind === 'act') { entered.resolve(); await release.promise } return 'pass' }])
    t.after(() => { release.resolve(); f.instance.auth.close() })
    const controller = new AbortController(), pending = f.commands.act(f.request(), controller.signal)
    await entered.promise; controller.abort()
    await assert.rejects(pending, code('CANCELLED'))
    release.resolve()
    assert.equal(f.commands.signal.aborted, false)
    assert.equal((await f.instance.source.node('/work/document'))?.count, 0)
    await f.commands.act(f.request())
    assert.equal((await f.instance.source.node('/work/document'))?.count, 1)
  })
})

describe('native post action persistence', { timeout: 10_000 }, () => {
  it('persists the post and replays its original decision after a filesystem reopen', async t => {
    const parent = resolve('../../temp/k32-post-actions/fs')
    await mkdir(parent, { recursive: true })
    const directory = await mkdtemp(join(parent, 'instance-'))
    const lease = await openPersistentWriter({ directory: join(directory, '.treenix'), instance: 'post-actions' })
    const root = await createFsStore({ directory, lease })
    const f = await setup([], root, lease)
    t.after(async () => { f.instance.auth.close(); await root.close(); await lease.close() })
    const request = f.request(), outcome = await f.admin.act(request)
    const credential = f.instance.setupCredential
    assert.ok(credential)
    f.instance.auth.close(); await root.close(); await lease.close()
    const nextLease = await openPersistentWriter({ directory: join(directory, '.treenix'), instance: 'post-actions' })
    const nextRoot = await createFsStore({ directory, lease: nextLease })
    t.after(async () => { await nextRoot.close(); await nextLease.close() })
    const reopened = await createInstanceFoundation({ id: 'post-actions', root: nextRoot, writerEpoch: nextLease.writerEpoch,
      domains: [{ store: nextRoot, epoch: nextLease.epoch, persistent: true }], counter: nextLease,
      initialCredential: { ttlMs: 60_000 }, budget: scanBudget })
    t.after(() => reopened.auth.close())
    reopened.registry.publish(manifest)
    const commands = reopened.commands(await reopened.auth.openCredential(credential))
    assert.deepEqual(await commands.act(request), outcome)
    assert.equal((await reopened.source.node('/work/document'))?.count, 1)
  })
})
