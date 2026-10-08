import assert from 'node:assert/strict'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { KernelError } from '#errors'
import { getActionContext } from '#kernel/current-action'
import { createInstanceFoundation } from '#kernel/instance'
import { openPersistentWriter, type PersistentWriter } from '#kernel/persistence'
import { scanBudget } from '#kernel/store/contract'
import { createFsStore, type FsStore } from '#kernel/store/fs'
import { createMemoryStore } from '#kernel/store/memory'
import { R, W, type ActRequest, type Gate, type JournalAddress, type ModuleManifest, type OpId, type Position, type Store, type TypeDef } from '#kernel/types'

const code = (expected: KernelError['code']) => (error: unknown) => error instanceof KernelError && error.code === expected
function signal() {
  let resolve: () => void = () => {}
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

async function setup(actions: TypeDef['actions'], gates: readonly Gate[] = [], store?: Store, lease?: PersistentWriter) {
  const root = store ?? createMemoryStore({ domain: 'action-handlers' })
  let saved: Position | undefined
  const instance = await createInstanceFoundation({ id: 'action-handlers', root, writerEpoch: lease?.writerEpoch ?? 1,
    domains: [{ store: root, epoch: lease?.epoch ?? 'handlers1', persistent: true }], counter: lease ?? {
      async load() { return saved }, async save(pos) { saved = pos }, async freshEpoch(floor) { return floor + 1 },
    }, firstAdmin: { path: '/admin', name: 'admin', password: 'action-password' },
    initialCredential: { ttlMs: 60_000 }, gates, budget: scanBudget })
  assert.ok(instance.setupCredential)
  const admin = instance.commands(await instance.auth.openCredential(instance.setupCredential))
  let nonce = 0
  const key = (): OpId => ({ epoch: instance.writer.intake.epoch, time: Date.now(), nonce: String(++nonce) })
  await admin.commit({ opId: key(), changes: [{ op: 'put', node: { $path: '/sys/types/actions.document', $type: 't.type',
    name: 'actions.document', module: 'action-handlers', security: 'ordinary' } }] })
  const manifest: ModuleManifest = { id: 'action-handlers', types: [{ name: 'actions.document', module: 'action-handlers',
    security: 'ordinary', version: 0, schema: {}, actionsOnly: true, actions }], security: [], open: [] }
  instance.registry.publish(manifest)
  await admin.commit({ opId: key(), changes: [
    { op: 'put', node: { $path: '/work', $type: 't.dir', $acl: [{ subject: { group: 'public' }, grant: R | W }] } },
    { op: 'put', node: { $path: '/work/document', $type: 'actions.document', count: 0, list: [1, 2, 3] } },
    { op: 'put', node: { $path: '/work/stock', $type: 't.dir', count: 4 } },
  ] })
  const commands = instance.commands(await instance.auth.openCredential())
  const request = (action: string): ActRequest => ({ path: '/work/document', action, args: {}, opId: key() })
  return { instance, root, admin, commands, key, request, manifest }
}

describe('native action handlers', { timeout: 10_000 }, () => {
  it('binds a write handler to its component draft and records its value in the atomic outcome', async t => {
    const f = await setup({ increment: { kind: 'write', args: {}, handler: async function(this: { count: number; list: number[] }, ctx) {
      assert.equal(ctx.caller.principal, ctx.executor.principal)
      assert.equal(ctx.node.count, 0)
      this.count++; this.list.splice(1, 1)
      return { count: this.count }
    } } }); t.after(() => f.instance.auth.close())
    const request = f.request('increment'), outcome = await f.commands.act(request)
    assert.deepEqual(outcome.value, { count: 1 })
    assert.deepEqual(await f.commands.act(request), outcome)
    assert.equal((await f.instance.source.node('/work/document'))?.count, 1)
    assert.deepEqual((await f.instance.source.node('/work/document'))?.list, [1, 3])
  })

  it('lets an unkeyed read handler use the executor Reader without changes or I/O', async t => {
    const f = await setup({ inspect: { kind: 'read', args: {}, handler: async ctx => {
      assert.equal('change' in ctx, false); assert.equal('io' in ctx, false)
      const result = await ctx.read.read({ node: '/work/stock' })
      assert.ok('node' in result.copies[0])
      assert.equal(Reflect.set(result.copies[0].node, 'count', 100), false)
      return result.copies[0].node.count
    } } }); t.after(() => f.instance.auth.close())
    await f.admin.commit({ opId: f.key(), changes: [{ op: 'patch', path: '/work', ops: { $set: {
      $acl: [{ subject: { group: 'public' }, grant: R }],
    } } }] })
    const before = f.instance.writer.stream.cursor().pos
    const outcome = await f.commands.act({ ...f.request('inspect'), opId: undefined })
    assert.deepEqual(outcome, { value: 4 })
    assert.deepEqual(f.instance.writer.stream.cursor().pos, before)
    assert.equal((await f.instance.source.node('/work/stock'))?.count, 4)
  })

  it('commits builder members and the draft once, and denies all changes if a target lacks W', async t => {
    const f = await setup({ transfer: { kind: 'write', args: {}, handler: async function(this: { count: number }, ctx) {
      this.count++
      ctx.change.put({ $path: '/work/one', $type: 't.dir', count: 1 })
      ctx.change.put({ $path: '/work/two', $type: 't.dir', count: 2 })
      ctx.change.patch('/work/stock', { $inc: { count: -1 } })
    } } }); t.after(() => f.instance.auth.close())
    await f.commands.act(f.request('transfer'))
    const nodes = await Promise.all(['/work/document', '/work/one', '/work/two', '/work/stock'].map(path => f.instance.source.node(path)))
    assert.deepEqual(nodes.map(node => node?.count), [1, 1, 2, 3])
    assert.ok(nodes[0]); assert.ok(nodes.every(node => node?.$pos.seq === nodes[0]!.$pos.seq))
    await f.admin.commit({ opId: f.key(), changes: [{ op: 'patch', path: '/work/stock', ops: { $set: {
      $acl: [{ subject: { group: 'public' }, deny: W }],
    } } }] })
    await assert.rejects(f.commands.act(f.request('transfer')), code('FORBIDDEN'))
    assert.deepEqual((await f.instance.source.node('/work/document'))?.count, 1)
    assert.deepEqual((await f.instance.source.node('/work/stock'))?.count, 3)
  })

  it('runs simultaneous duplicate requests through one handler', async t => {
    const entered = signal(), release = signal(); let calls = 0
    const f = await setup({ increment: { kind: 'write', args: {}, handler: async function(this: { count: number }) {
      calls++; entered.resolve(); await release.promise; this.count++; return calls
    } } }); t.after(() => { release.resolve(); f.instance.auth.close() })
    const request = f.request('increment'), first = f.commands.act(request)
    await entered.promise
    const duplicate = f.commands.act(request); release.resolve()
    assert.deepEqual(await first, await duplicate)
    assert.equal(calls, 1); assert.equal((await f.instance.source.node('/work/document'))?.count, 1)
  })

  it('bounds a duplicate deadline before the original outcome is accepted', async t => {
    const entered = signal(), release = signal()
    const f = await setup({ increment: { kind: 'write', args: {}, handler: async function(this: { count: number }) {
      entered.resolve(); await release.promise; this.count++; return this.count
    } } })
    const request = f.request('increment'), first = f.commands.act(request)
    await entered.promise
    await f.admin.commit({ opId: f.key(), changes: [{ op: 'patch', path: '/sys/limits', ops: { $set: { actionMs: 10 } } }] })
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() })
    const probed = signal(), replay = f.instance.writer.replay
    t.mock.method(f.instance.writer, 'replay', (...args: Parameters<typeof replay>) => {
      const pending = replay(...args); probed.resolve(); return pending
    })
    const duplicate = f.commands.act(request).then(() => 'success', error => error instanceof KernelError ? error.code : 'unexpected-error')
    t.after(async () => { release.resolve(); await first; await duplicate; f.instance.auth.close() })
    await probed.promise; t.mock.timers.tick(11)
    assert.equal((await f.instance.source.node('/work/document'))?.count, 0)
    const status = await Promise.race([duplicate, new Promise<string>(done => setImmediate(() => done('pending')))])
    assert.equal(status, 'BUDGET')
  })

  it('cancels a duplicate wait before the original outcome is accepted', async t => {
    const entered = signal(), release = signal()
    const f = await setup({ increment: { kind: 'write', args: {}, handler: async function(this: { count: number }) {
      entered.resolve(); await release.promise; this.count++; return this.count
    } } })
    const request = f.request('increment'), first = f.commands.act(request); await entered.promise
    const probed = signal(), replay = f.instance.writer.replay, controller = new AbortController()
    t.mock.method(f.instance.writer, 'replay', (...args: Parameters<typeof replay>) => {
      const pending = replay(...args); probed.resolve(); return pending
    })
    const duplicate = f.commands.act(request, controller.signal).then(() => 'success', error => error instanceof KernelError ? error.code : 'unexpected-error')
    t.after(async () => { release.resolve(); await first; await duplicate; f.instance.auth.close() })
    await probed.promise; controller.abort()
    const status = await Promise.race([duplicate, new Promise<string>(done => setImmediate(() => done('pending')))])
    assert.equal(status, 'CANCELLED'); assert.equal((await f.instance.source.node('/work/document'))?.count, 0)
  })

  it('bounds the initial decision lookup before dispatch or effects', async t => {
    const entered = signal(), release = signal()
    const f = await setup({ increment: { kind: 'write', args: {}, handler: async function(this: { count: number }) { this.count++ } } })
    await f.admin.commit({ opId: f.key(), changes: [{ op: 'patch', path: '/sys/limits', ops: { $set: { actionMs: 10 } } }] })
    const scan = f.root.scan; let hold = true
    t.mock.method(f.root, 'scan', async (...args: Parameters<typeof scan>) => {
      if (hold && 'decision' in args[0].range) { hold = false; entered.resolve(); await release.promise }
      return scan(...args)
    })
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() })
    const pending = f.commands.act(f.request('increment')).then(() => 'success', error => error instanceof KernelError ? error.code : 'unexpected-error')
    t.after(async () => { release.resolve(); await pending; f.instance.auth.close() })
    await entered.promise; t.mock.timers.tick(11)
    const status = await Promise.race([pending, new Promise<string>(done => setImmediate(() => done('pending')))])
    assert.equal(status, 'BUDGET'); assert.equal((await f.instance.source.node('/work/document'))?.count, 0)
  })

  it('bounds a duplicate that joins after its original replay probe missed', async t => {
    const handler = signal(), release = signal(), probed = signal(), resume = signal(), joined = signal()
    const f = await setup({ increment: { kind: 'write', args: {}, handler: async function(this: { count: number }) {
      handler.resolve(); await release.promise; this.count++; return this.count
    } } })
    await f.admin.commit({ opId: f.key(), changes: [{ op: 'patch', path: '/sys/limits', ops: { $set: { actionMs: 10 } } }] })
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() })
    const request = f.request('increment'), replay = f.instance.writer.replay, mutate = f.instance.writer.mutate
    let hold = true, calls = 0
    t.mock.method(f.instance.writer, 'replay', async (...args: Parameters<typeof replay>) => {
      const result = await replay(...args)
      if (hold && result === undefined) { hold = false; probed.resolve(); await resume.promise }
      return result
    })
    t.mock.method(f.instance.writer, 'mutate', (...args: Parameters<typeof mutate>) => {
      const result = mutate(...args)
      if (args[0].opId.nonce === request.opId?.nonce && ++calls === 2) joined.resolve()
      return result
    })
    const duplicate = f.commands.act(request).then(() => 'success', error => error instanceof KernelError ? error.code : 'unexpected-error')
    await probed.promise
    await f.admin.commit({ opId: f.key(), changes: [{ op: 'patch', path: '/sys/limits', ops: { $set: { actionMs: 30_000 } } }] })
    const first = f.commands.act(request); await handler.promise; resume.resolve(); await joined.promise
    t.after(async () => { release.resolve(); await first; await duplicate; f.instance.auth.close() })
    t.mock.timers.tick(11)
    const status = await Promise.race([duplicate, new Promise<string>(done => setImmediate(() => done('pending')))])
    assert.equal(status, 'BUDGET'); assert.equal((await f.instance.source.node('/work/document'))?.count, 0)
  })

  it('rejects a changed declared need after the handler awaits', async t => {
    const entered = signal(), release = signal()
    const f = await setup({ transfer: { kind: 'write', args: {}, needs: { stock: { node: '../stock' } },
      handler: async function(this: { count: number }, ctx) {
        assert.equal(ctx.needs.stock.list.length, 1); entered.resolve(); await release.promise; this.count++
      } } }); t.after(() => { release.resolve(); f.instance.auth.close() })
    const pending = f.commands.act(f.request('transfer')); await entered.promise
    await f.admin.commit({ opId: f.key(), changes: [{ op: 'patch', path: '/work/stock', ops: { $inc: { count: 1 } } }] })
    release.resolve(); await assert.rejects(pending, code('CONFLICT'))
    assert.equal((await f.instance.source.node('/work/document'))?.count, 0)
  })

  it('replays a writing action after it removes its own target', async t => {
    let calls = 0
    const f = await setup({ remove: { kind: 'write', args: {}, handler: async ctx => {
      calls++; ctx.change.remove(ctx.node.$path); return 'removed'
    } } }); t.after(() => f.instance.auth.close())
    const request = f.request('remove'), first = await f.commands.act(request)
    assert.equal(await f.instance.source.node('/work/document'), null)
    assert.deepEqual(await f.commands.act(request), first)
    assert.equal(calls, 1)
  })

  it('ignores a stale supplied read key and produces no decision or node effect', async t => {
    let calls = 0
    const f = await setup({ inspect: { kind: 'read', args: {}, handler: async () => ++calls } })
    t.after(() => f.instance.auth.close())
    const before = f.instance.writer.stream.cursor().pos
    const request = { ...f.request('inspect'), opId: { epoch: 'gone', time: 0, nonce: 'read' } }
    assert.deepEqual(await f.commands.act(request), { value: 1 })
    assert.deepEqual(await f.commands.act(request), { value: 2 })
    assert.deepEqual(f.instance.writer.stream.cursor().pos, before)
  })

  it('rejects write calls without rights or valid arguments before the handler', async t => {
    let calls = 0
    const f = await setup({ edit: { kind: 'write', args: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      handler: async () => ++calls } }); t.after(() => f.instance.auth.close())
    await assert.rejects(f.commands.act(f.request('edit')), code('INVALID'))
    await f.admin.commit({ opId: f.key(), changes: [{ op: 'patch', path: '/work', ops: { $set: {
      $acl: [{ subject: { group: 'public' }, grant: R }],
    } } }] })
    await assert.rejects(f.commands.act({ ...f.request('edit'), args: { name: 'valid' } }), code('FORBIDDEN'))
    assert.equal(calls, 0)
  })

  it('judges a handled post against its declared frame', async t => {
    const f = await setup({ good: { kind: 'write', args: {}, post: { '': { $inc: { count: 1 } } },
      handler: async function(this: { count: number }) { this.count++; return this.count } },
    bad: { kind: 'write', args: {}, post: { '': { $inc: { count: 1 } } },
      handler: async function(this: { count: number }) { this.count += 2 } } })
    t.after(() => f.instance.auth.close())
    assert.equal((await f.commands.act(f.request('good'))).value, 1)
    await assert.rejects(f.commands.act(f.request('bad')), code('FORBIDDEN'))
    assert.equal((await f.instance.source.node('/work/document'))?.count, 1)
  })

  it('discards the draft and builder at the deadline while a handler is still waiting', async t => {
    const entered = signal(), release = signal()
    const f = await setup({ delayed: { kind: 'write', args: {}, handler: async function(this: { count: number }, ctx) {
      this.count++; ctx.change.put({ $path: '/work/later', $type: 't.dir' })
      entered.resolve(); await release.promise; this.count++
    } } }); t.after(() => { release.resolve(); f.instance.auth.close() })
    await f.admin.commit({ opId: f.key(), changes: [{ op: 'patch', path: '/sys/limits', ops: { $set: { actionMs: 10 } } }] })
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() })
    const pending = f.commands.act(f.request('delayed')); await entered.promise
    t.mock.timers.tick(11)
    await assert.rejects(pending, code('BUDGET')); release.resolve()
    assert.equal((await f.instance.source.node('/work/document'))?.count, 0)
    assert.equal(await f.instance.source.node('/work/later'), null)
  })

  it('keeps nested changes as a saga and never shows the inner call the outer draft', async t => {
    const seen: unknown[] = []
    const f = await setup({ outer: { kind: 'write', args: {}, handler: async function(this: { count: number }, ctx) {
      this.count = 100
      ctx.change.put({ $path: '/work/speculative', $type: 't.dir' })
      await ctx.act({ path: ctx.node.$path, action: 'inner', args: {}, key: 'increment' })
    } }, inner: { kind: 'write', args: {}, handler: async function(this: { count: number }, ctx) {
      seen.push(ctx.node.count)
      await assert.rejects(ctx.read.read({ node: '/work/speculative' }), code('NOT_FOUND'))
      this.count++
    } } }); t.after(() => f.instance.auth.close())
    await assert.rejects(f.commands.act(f.request('outer')), code('CONFLICT'))
    assert.deepEqual(seen, [0])
    assert.equal((await f.instance.source.node('/work/document'))?.count, 1)
    assert.equal(await f.instance.source.node('/work/speculative'), null)
  })

  it('replays stable named inner calls after an earlier call is skipped on a changed branch', async t => {
    const entered = signal(), release = signal(), answers: unknown[] = []; let audit = 0, debit = 0, attempts = 0
    const f = await setup({ outer: { kind: 'write', args: {}, handler: async function(this: { count: number }, ctx) {
      attempts++
      if (ctx.node.branch !== false) await ctx.act({ path: '/work/document', action: 'audit', args: {}, key: 'audit' })
      answers.push(await ctx.act({ path: '/work/document', action: 'debit', args: {}, key: 'debit' }))
      if (attempts === 1) { entered.resolve(); await release.promise }
      this.count++
    } }, audit: { kind: 'write', args: {}, handler: async ctx => { audit++; ctx.change.patch('/work/stock', { $inc: { count: 1 } }); return audit } },
    debit: { kind: 'write', args: {}, handler: async ctx => { debit++; ctx.change.patch('/work/stock', { $inc: { count: -1 } }); return debit } } })
    t.after(() => { release.resolve(); f.instance.auth.close() })
    const request = f.request('outer'), first = f.commands.act(request); await entered.promise
    await f.admin.commit({ opId: f.key(), changes: [{ op: 'patch', path: '/work/document', ops: { $set: { branch: false }, $inc: { count: 1 } } }] })
    release.resolve(); await assert.rejects(first, code('CONFLICT'))
    await f.commands.act(request)
    assert.deepEqual(answers, [1, 1]); assert.equal(audit, 1); assert.equal(debit, 1)
    assert.equal((await f.instance.source.node('/work/document'))?.count, 2)
    assert.equal((await f.instance.source.node('/work/stock'))?.count, 4)
  })

  it('rejects a changed inner request under the same logical key without repeating its effect', async t => {
    const entered = signal(), release = signal(); let attempts = 0, debit = 0
    const f = await setup({ outer: { kind: 'write', args: {}, handler: async ctx => {
      attempts++
      await ctx.act({ path: '/work/document', action: 'debit', args: { amount: ctx.node.count }, key: 'debit' })
      if (attempts === 1) { entered.resolve(); await release.promise }
    } }, debit: { kind: 'write', args: {}, handler: async ctx => { debit++; ctx.change.patch('/work/stock', { $inc: { count: -1 } }) } } })
    t.after(() => { release.resolve(); f.instance.auth.close() })
    const request = f.request('outer'), first = f.commands.act(request); await entered.promise
    await f.admin.commit({ opId: f.key(), changes: [{ op: 'patch', path: '/work/document', ops: { $inc: { count: 1 } } }] })
    release.resolve(); await assert.rejects(first, code('CONFLICT'))
    await assert.rejects(f.commands.act(request), code('KEY_REUSED'))
    assert.equal(debit, 1); assert.equal((await f.instance.source.node('/work/stock'))?.count, 3)
  })

  it('requires stable unique keys for nested writes and rejects nested opId and anchor fields', async t => {
    let inner = 0
    const f = await setup({ missing: { kind: 'write', args: {}, handler: async ctx => ctx.act({ path: ctx.node.$path, action: 'inner', args: {} }) },
      duplicate: { kind: 'write', args: {}, handler: async ctx => {
        await ctx.act({ path: ctx.node.$path, action: 'inner', args: {}, key: 'same' })
        await ctx.act({ path: ctx.node.$path, action: 'inner', args: {}, key: 'same' })
      } }, forgedKey: { kind: 'write', args: {}, handler: async ctx => {
        const request = { path: ctx.node.$path, action: 'inner', args: {}, key: 'inner', opId: { epoch: 'forged', time: 0, nonce: 'forged' } }
        return ctx.act(request)
      } }, forgedAnchor: { kind: 'write', args: {}, handler: async ctx => {
        const request = { path: ctx.node.$path, action: 'inner', args: {}, key: 'inner', anchor: { epoch: 'forged', time: 0, nonce: 'forged' } }
        return ctx.act(request)
      } }, inner: { kind: 'write', args: {}, handler: async () => ++inner } })
    t.after(() => f.instance.auth.close())
    for (const action of ['missing', 'forgedKey', 'forgedAnchor']) await assert.rejects(f.commands.act(f.request(action)), code('INVALID'))
    assert.equal(inner, 0)
    await assert.rejects(f.commands.act(f.request('duplicate')), code('INVALID'))
    assert.equal(inner, 1)
  })

  it('allows nested reads without keys and rejects inner writes from read and post handlers', async t => {
    let inner = 0
    const f = await setup({ inspect: { kind: 'read', args: {}, handler: async () => 7 },
      read: { kind: 'read', args: {}, handler: async ctx => ctx.act({ path: ctx.node.$path, action: 'inspect', args: {} }) },
      readWrite: { kind: 'read', args: {}, handler: async ctx => ctx.act({ path: ctx.node.$path, action: 'write', args: {}, key: 'write' }) },
      postWrite: { kind: 'write', args: {}, post: {}, handler: async ctx => ctx.act({ path: ctx.node.$path, action: 'write', args: {}, key: 'write' }) },
      write: { kind: 'write', args: {}, handler: async () => ++inner } })
    t.after(() => f.instance.auth.close())
    assert.deepEqual(await f.commands.act({ ...f.request('read'), opId: undefined }), { value: 7 })
    await assert.rejects(f.commands.act(f.request('readWrite')), code('FORBIDDEN'))
    await assert.rejects(f.commands.act(f.request('postWrite')), code('FORBIDDEN'))
    assert.equal(inner, 0)
  })

  it('allows eight nested read calls and refuses the ninth', async t => {
    const f = await setup({ descend: { kind: 'read', args: { type: 'object', properties: { depth: { type: 'number' } }, required: ['depth'] },
      handler: async (ctx, args) => {
        assert.ok(args !== null && typeof args === 'object' && 'depth' in args && typeof args.depth === 'number')
        return args.depth === 0 ? 0 : 1 + Number(await ctx.act({ path: ctx.node.$path, action: 'descend', args: { depth: args.depth - 1 } }))
      } } }); t.after(() => f.instance.auth.close())
    assert.deepEqual(await f.commands.act({ ...f.request('descend'), args: { depth: 8 }, opId: undefined }), { value: 8 })
    await assert.rejects(f.commands.act({ ...f.request('descend'), args: { depth: 9 }, opId: undefined }), code('BUDGET'))
  })

  it('captures builder values when they are supplied and isolates a named component draft', async t => {
    const f = await setup({ edit: { kind: 'write', args: {}, handler: async function(this: { count: number }, ctx) {
      this.count++
      const node = { $path: '/work/captured', $type: 't.dir', box: { value: 'original' } }
      ctx.change.put(node); node.box.value = 'changed'
      const ops = { $set: { box: { value: 'patched' } } }
      ctx.change.patch('/work/captured', ops); ops.$set.box.value = 'changed again'
    } } }); t.after(() => f.instance.auth.close())
    await f.admin.commit({ opId: f.key(), changes: [{ op: 'put', node: { $path: '/work/named', $type: 't.dir', count: 40,
      '#document': { $type: 'actions.document', count: 1 } } }] })
    await f.commands.act({ ...f.request('edit'), path: '/work/named', component: '#document' })
    const named = await f.instance.source.node('/work/named'); assert.ok(named)
    assert.equal(named.count, 40); assert.equal(named['#document'].count, 2)
    assert.deepEqual((await f.instance.source.node('/work/captured'))?.box, { value: 'patched' })
  })

  it('uses native subtree move and journal restore through the builder', async t => {
    let address: JournalAddress | undefined
    const f = await setup({ move: { kind: 'write', args: {}, handler: async ctx => ctx.change.move('/work/tree', '/work/moved') },
      remove: { kind: 'write', args: {}, handler: async ctx => ctx.change.remove('/work/moved/child') },
      restore: { kind: 'write', args: {}, handler: async ctx => { assert.ok(address); ctx.change.restore(address) } } })
    t.after(() => f.instance.auth.close())
    await f.admin.commit({ opId: f.key(), changes: [
      { op: 'put', node: { $path: '/work/tree', $type: 't.dir' } },
      { op: 'put', node: { $path: '/work/tree/child', $type: 't.dir', value: 'child' } },
    ] })
    const before = await f.instance.source.node('/work/tree/child'); assert.ok(before)
    await f.commands.act(f.request('move'))
    assert.equal(await f.instance.source.node('/work/tree'), null)
    assert.equal((await f.instance.source.node('/work/moved/child'))?.$id, before.$id)
    const outcome = await f.commands.act(f.request('remove')); assert.ok(outcome.pos)
    address = { pos: outcome.pos, id: before.$id }
    await f.admin.act(f.request('restore'))
    const restored = await f.instance.source.node('/work/moved/child'); assert.ok(restored)
    assert.equal(restored.$id, before.$id); assert.equal(restored.value, 'child')
  })

  it('refuses a subtree removal expanding into 101 transitions without a partial deletion', async t => {
    const f = await setup({ remove: { kind: 'write', args: {}, handler: async ctx => ctx.change.remove('/work/tree') } })
    t.after(() => f.instance.auth.close())
    await f.admin.commit({ opId: f.key(), changes: [{ op: 'put', node: { $path: '/work/tree', $type: 't.dir' } }] })
    await f.admin.commit({ opId: f.key(), changes: Array.from({ length: 100 }, (_, n) => ({ op: 'put' as const,
      node: { $path: `/work/tree/${n}`, $type: 't.dir' } })) })
    await assert.rejects(f.commands.act(f.request('remove')), code('BUDGET'))
    assert.equal((await f.root.scan({ range: { subtree: '/work/tree' }, budget: scanBudget() })).items.length, 101)
  })

  it('keeps a builder budget refusal fatal even if a handler catches it', async t => {
    const f = await setup({ overflow: { kind: 'write', args: {}, handler: async ctx => {
      assert.throws(() => {
        for (let n = 0; n <= 100; n++) ctx.change.put({ $path: `/work/${n}`, $type: 't.dir' })
      }, code('BUDGET'))
    } } }); t.after(() => f.instance.auth.close())
    await assert.rejects(f.commands.act(f.request('overflow')), code('BUDGET'))
    assert.equal(await f.instance.source.node('/work/0'), null)
  })

  it('counts a nested handler wait against the outer deadline and discards both unfinished builders', async t => {
    const entered = signal(), release = signal()
    const f = await setup({ outer: { kind: 'write', args: {}, handler: async function(this: { count: number }, ctx) {
      this.count++; await ctx.act({ path: ctx.node.$path, action: 'inner', args: {}, key: 'inner' })
    } }, inner: { kind: 'write', args: {}, handler: async ctx => {
      ctx.change.put({ $path: '/work/inner', $type: 't.dir' }); entered.resolve(); await release.promise
    } } }); t.after(() => { release.resolve(); f.instance.auth.close() })
    await f.admin.commit({ opId: f.key(), changes: [{ op: 'patch', path: '/sys/limits', ops: { $set: { actionMs: 10 } } }] })
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() })
    const pending = f.commands.act(f.request('outer')); await entered.promise
    t.mock.timers.tick(11); await assert.rejects(pending, code('BUDGET')); release.resolve()
    assert.equal((await f.instance.source.node('/work/document'))?.count, 0)
    assert.equal(await f.instance.source.node('/work/inner'), null)
  })

  it('returns the canonical success after cancellation while an accepted commit awaits publication', async t => {
    const base = createMemoryStore({ domain: 'action-handlers' }), entered = signal(), release = signal()
    let hold = false, calls = 0
    const root: Store = { ...base, async commit(commit) {
      await base.commit(commit)
      if (hold && commit.record.decision !== undefined) { entered.resolve(); await release.promise }
    } }
    const f = await setup({ increment: { kind: 'write', args: {}, handler: async function(this: { count: number }) {
      calls++; this.count++; return calls
    } } }, [], root); t.after(() => { release.resolve(); f.instance.auth.close() })
    hold = true
    const request = f.request('increment'), firstSignal = new AbortController(), duplicateSignal = new AbortController()
    const first = f.commands.act(request, firstSignal.signal); await entered.promise
    const accepted = (await base.scan({ range: { node: '/work/document' }, budget: scanBudget() })).items[0]
    assert.equal(accepted.count, 1)
    const duplicate = f.commands.act(request, duplicateSignal.signal)
    firstSignal.abort(); duplicateSignal.abort()
    const recovered = await duplicate
    assert.ok(recovered.pos); assert.equal(recovered.value, 1)
    release.resolve()
    const outcome = await first
    assert.ok(outcome.pos); assert.equal(outcome.value, 1)
    assert.deepEqual(recovered, outcome)
    assert.deepEqual(await f.commands.act(request), outcome)
    assert.equal(calls, 1)
  })

  it('keeps ctx.read and nested call rights bound to the ordinary executor', async t => {
    let inner = 0
    const observed: string[] = []
    const f = await setup({ readHidden: { kind: 'read', args: {}, handler: async ctx => ctx.read.read({ node: '/work/hidden' }) },
      outer: { kind: 'write', args: {}, handler: async ctx => ctx.act({ path: '/work/readonly', action: 'inner', args: {}, key: 'inner' }) },
      inner: { kind: 'write', args: {}, handler: async () => ++inner } },
    [async (op, actor) => { if (op.kind === 'act') observed.push(actor.principal); return 'pass' }])
    t.after(() => f.instance.auth.close())
    await f.admin.commit({ opId: f.key(), changes: [
      { op: 'put', node: { $path: '/work/hidden', $type: 't.dir', $acl: [{ subject: { group: 'public' }, deny: R }] } },
      { op: 'put', node: { $path: '/work/readonly', $type: 'actions.document', $acl: [{ subject: { group: 'public' }, deny: W }] } },
    ] })
    await assert.rejects(f.commands.act(f.request('readHidden')), code('NOT_FOUND'))
    await assert.rejects(f.commands.act(f.request('outer')), code('FORBIDDEN'))
    assert.equal(inner, 0)
    assert.deepEqual(observed, [f.commands.actor.principal, f.commands.actor.principal])
  })

  it('preserves literal JSON keys and component names in actual filesystem draft writes', async t => {
    const directory = resolve('temp/kernel-tests'); await mkdir(directory, { recursive: true })
    const path = await mkdtemp(join(directory, 'action-literals-'))
    const lease = await openPersistentWriter({ directory: join(path, '.treenix'), instance: 'action-handlers' })
    const root = await createFsStore({ directory: path, lease })
    let reopened: FsStore | undefined
    const f = await setup({ unchanged: { kind: 'write', args: {}, handler: async () => 'unchanged' },
      edit: { kind: 'write', args: {}, handler: async function(this: { count: number; 'literal.dot': { value: number } }) {
      this.count++; this['literal.dot'].value++
    } } }, [], root, lease); t.after(async () => { f.instance.auth.close(); await reopened?.close(); await root.close(); await lease.close() })
    await f.admin.commit({ opId: f.key(), changes: [
      { op: 'put', node: { $path: '/work/literal', $type: 'actions.document', count: 2, 'literal.dot': { value: 1 } } },
      { op: 'put', node: { $path: '/work/named', $type: 't.dir', count: 40,
        '#document': { $type: 'actions.document', count: 2, 'literal.dot': { value: 1 } },
        '#literal.name': { $type: 'actions.document', count: 3, 'literal.dot': { value: 1 } } } },
    ] })
    for (const [path, component] of [['/work/literal', ''], ['/work/named', '#document'], ['/work/named', '#literal.name']]) {
      await f.commands.act({ ...f.request('edit'), path, component })
    }
    const main = await f.instance.source.node('/work/literal'), named = await f.instance.source.node('/work/named')
    assert.ok(main); assert.ok(named)
    assert.equal(main.count, 3); assert.deepEqual(main['literal.dot'], { value: 2 })
    assert.equal(Object.hasOwn(main, '$order'), false)
    assert.equal(named.count, 40); assert.equal(Object.hasOwn(named, '#literal'), false)
    assert.deepEqual(named['#document']['literal.dot'], { value: 2 }); assert.equal(named['#document'].count, 3)
    assert.deepEqual(named['#literal.name']['literal.dot'], { value: 2 }); assert.equal(named['#literal.name'].count, 4)
    const unchanged = await f.commands.act({ ...f.request('unchanged'), path: '/work/named', component: '#literal.name' })
    assert.deepEqual((await f.instance.source.node('/work/named'))?.$pos, named.$pos)
    const records = (await root.scan({ range: { journal: '/' }, budget: scanBudget() })).items
    const decision = records.find(record => record.pos.seq === unchanged.pos?.seq)
    assert.ok(decision); assert.equal(decision.entries.length, 0)
    f.instance.auth.close(); await root.close()
    reopened = await createFsStore({ directory: path, lease })
    assert.deepEqual((await reopened.scan({ range: { node: '/work/literal' }, budget: scanBudget() })).items[0]['literal.dot'], { value: 2 })
  })

  it('keeps simultaneous native contexts distinct across awaits', async t => {
    const entered = signal(), release = signal(), paths: string[] = []; let calls = 0
    const f = await setup({ increment: { kind: 'write', args: {}, handler: async function(this: { count: number }, ctx) {
      assert.equal(getActionContext('write'), ctx)
      paths.push(getActionContext().node.$path)
      if (++calls === 2) entered.resolve()
      await release.promise
      assert.equal(getActionContext('write'), ctx)
      assert.equal(getActionContext().node.$path, ctx.node.$path)
      this.count++
    } } }); t.after(() => { release.resolve(); f.instance.auth.close() })
    await f.admin.commit({ opId: f.key(), changes: [{ op: 'put', node: { $path: '/work/second', $type: 'actions.document', count: 4 } }] })
    const first = f.commands.act(f.request('increment')), second = f.commands.act({ ...f.request('increment'), path: '/work/second' })
    await entered.promise; release.resolve(); await Promise.all([first, second])
    assert.deepEqual(paths.sort(), ['/work/document', '/work/second'])
    assert.equal((await f.instance.source.node('/work/document'))?.count, 1)
    assert.equal((await f.instance.source.node('/work/second'))?.count, 5)
  })

  it('refuses a write accessor in a read handler and expires escaped native contexts', async t => {
    const release = signal(); let escaped: Promise<unknown> | undefined
    const f = await setup({ inspect: { kind: 'read', args: {}, handler: async ctx => {
      assert.equal(getActionContext(), ctx)
      assert.throws(() => getActionContext('write'), code('FORBIDDEN'))
      escaped = release.promise.then(() => getActionContext())
      return 7
    } } }); t.after(() => { release.resolve(); f.instance.auth.close() })
    assert.deepEqual(await f.commands.act({ ...f.request('inspect'), opId: undefined }), { value: 7 })
    assert.throws(() => getActionContext(), code('INVALID'))
    assert.ok(escaped); release.resolve(); await assert.rejects(escaped, code('INVALID'))
  })

  it('rechecks a durable outcome when a duplicate probe misses just before its target is removed', async t => {
    const entered = signal(), release = signal(); let calls = 0, probes = 0
    const f = await setup({ remove: { kind: 'write', args: {}, handler: async ctx => {
      calls++; ctx.change.remove(ctx.node.$path); return 'removed'
    } } }); t.after(() => { release.resolve(); f.instance.auth.close() })
    const realReplay = f.instance.writer.replay
    t.mock.method(f.instance.writer, 'replay', async (input: Parameters<typeof realReplay>[0]) => {
      const value = await realReplay(input)
      if (++probes === 1) { assert.equal(value, undefined); entered.resolve(); await release.promise }
      return value
    })
    const request = f.request('remove'), duplicate = f.commands.act(request); await entered.promise
    const first = await f.commands.act(request)
    assert.equal(await f.instance.source.node('/work/document'), null)
    release.resolve(); assert.deepEqual(await duplicate, first)
    assert.equal(calls, 1)
  })

  it('rechecks the original mutation outcome when concurrent publication classifies a duplicate as read', async t => {
    const entered = signal(), release = signal(); let writes = 0, reads = 0, probes = 0
    const f = await setup({ action: { kind: 'write', args: {}, handler: async ctx => {
      writes++; ctx.change.remove(ctx.node.$path); return 'original write'
    } } }); t.after(() => { release.resolve(); f.instance.auth.close() })
    const realReplay = f.instance.writer.replay
    t.mock.method(f.instance.writer, 'replay', async (input: Parameters<typeof realReplay>[0]) => {
      const value = await realReplay(input)
      if (++probes === 1) { assert.equal(value, undefined); entered.resolve(); await release.promise }
      return value
    })
    const request = f.request('action'), duplicate = f.commands.act(request); await entered.promise
    const first = await f.commands.act(request)
    await f.admin.commit({ opId: f.key(), changes: [{ op: 'put', node: { $path: '/work/document', $type: 'actions.document' } }] })
    f.instance.registry.publish({ ...f.manifest, types: f.manifest.types.map(type => ({ ...type,
      actions: { action: { kind: 'read', args: {}, handler: async () => { reads++; return 'new read' } } } })) })
    release.resolve(); assert.deepEqual(await duplicate, first)
    assert.equal(writes, 1); assert.equal(reads, 0)
  })
})
