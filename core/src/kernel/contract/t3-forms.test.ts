import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { describe, it, type TestContext } from 'node:test'
import { KernelError } from '#errors'
import { createMemoryBlobStore } from '#kernel/blob-store-memory'
import { createInstance } from '#kernel/instance'
import { openNativeRuntime } from '#kernel/runtime'
import { drainSession } from '#kernel/session-delivery'
import { scanBudget } from '#kernel/store/contract'
import { createMemoryStore } from '#kernel/store/memory'
import { R, W, type ChangeMember, type Gate, type ModuleManifest, type Node, type OpId, type Position,
  type PositionCounter, type Principal, type TypeDef } from '#kernel/types'

const formPath = '/forms/form'
const secondPath = '/forms/second'
const workerPath = '/work/worker'
const code = (expected: KernelError['code']) => (error: unknown) =>
  error instanceof KernelError && error.code === expected

interface FixtureOptions {
  readonly forms: TypeDef['actions']
  readonly worker?: TypeDef['actions']
  readonly gates?: readonly Gate[]
}
interface GrantTarget {
  readonly path: string
  readonly bits: number
  readonly public?: number
}
interface ActorTrace {
  readonly action: string
  readonly caller: Principal
  readonly executor: Principal
}

/** Holds a test handler at an actual event boundary without sleeping. */
function event() {
  let resolve: () => void = () => {}
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

/** Builds the actual native factory, then opens and drains its public Session doors. */
async function fixture(t: TestContext, options: FixtureOptions) {
  const id = `public-forms:${randomUUID()}`
  const root = createMemoryStore({ domain: id })
  let saved: Position | undefined
  let issuedEpoch = 0
  const counter: PositionCounter = {
    async load() {
      return saved
    },
    async save(position) {
      saved = position
    },
    async freshEpoch(floor) {
      issuedEpoch = Math.max(issuedEpoch, floor) + 1
      return issuedEpoch
    },
  }
  const module: ModuleManifest = {
    id: 'public-forms',
    types: [
      {
        name: 'public.form',
        module: 'public-forms',
        security: 'user-capability',
        version: 0,
        schema: {},
        actions: options.forms,
      },
      {
        name: 'public.worker',
        module: 'public-forms',
        security: 'ordinary',
        version: 0,
        schema: {},
        actions: options.worker ?? {},
      },
    ],
    security: [],
    open: [],
  }
  const instance = await createInstance({
    id,
    root: { kind: 'store', store: root },
    blobs: createMemoryBlobStore(),
    modules: [module],
    gates: options.gates,
    provisioning: {
      counter,
      writerEpoch: 1,
      domains: [{ store: root, epoch: randomUUID(), persistent: false }],
      credentialTtlMs: 60_000,
      bootstrap: {
        kind: 'fresh',
        admin: { path: '/auth/users/admin', name: 'admin', password: randomUUID() },
      },
    },
  })
  const deliveries: Promise<void>[] = []
  t.after(async () => {
    await instance.close()
    await Promise.all(deliveries)
  })
  assert.ok(instance.setupCredential)
  const admin = await instance.openSession(instance.setupCredential)
  deliveries.push(drainSession(admin))

  /** Allocates a real mutation key inside the current intake. */
  function key(): OpId {
    return { epoch: instance.writer.intake.epoch, time: Date.now(), nonce: randomUUID() }
  }

  /** Reads the visible, typed node without tolerating error copies. */
  async function node(path: string): Promise<Node> {
    const copy = (await admin.read({ node: path })).copies[0]
    assert.ok('node' in copy)
    return copy.node
  }

  /** Grants the pinned node principal exactly the declared target bits. */
  async function grant(path: string, targets: readonly GrantTarget[]): Promise<void> {
    const recipient = await node(path)
    const changes: ChangeMember[] = []
    for (const target of targets) {
      const before = await node(target.path)
      const acl = before.$acl === undefined ? [] : before.$acl
      changes.push({
        op: 'patch',
        path: target.path,
        ops: {
          $set: {
            $acl: [
              ...acl,
              ...(target.public === undefined
                ? []
                : [{ subject: { group: 'public' }, grant: target.public }]),
              { subject: { group: `n:${recipient.$id}` }, grant: target.bits },
            ],
          },
        },
      })
    }
    await admin.commit({
      opId: key(),
      expect: { nodes: [{ path, rev: recipient.$rev }] },
      changes,
    }).outcome
  }

  /** Opens an anonymous session with the same production lane and lifecycle. */
  async function visitor(origin = '127.0.0.1') {
    const session = await instance.openSession(undefined, origin)
    deliveries.push(drainSession(session))
    return session
  }

  await admin.commit({
    opId: key(),
    changes: [
      {
        op: 'put',
        node: {
          $path: '/forms',
          $type: 't.dir',
          $acl: [{ subject: { group: 'public' }, grant: R }],
        },
      },
      ...[formPath, secondPath].map((path) => ({
        op: 'put' as const,
        node: {
          $path: path,
          $type: 'public.form',
          destination: path,
          count: 0,
          $acl: [{ subject: { group: 'public' }, grant: R }],
        },
      })),
      {
        op: 'put',
        node: {
          $path: '/work',
          $type: 't.dir',
          $acl: [{ subject: { group: 'public' }, grant: R | W }],
        },
      },
      { op: 'put', node: { $path: workerPath, $type: 'public.worker', count: 0 } },
      { op: 'put', node: { $path: '/sink', $type: 't.dir', count: 0 } },
      { op: 'put', node: { $path: '/private', $type: 't.dir', value: 'secret' } },
    ],
  }).outcome
  return { instance, root, admin, key, node, grant, visitor, deliveries, module }
}

/** Captures accepted effects so denied requests must leave the Store and journal unchanged. */
async function acceptedState(f: Awaited<ReturnType<typeof fixture>>) {
  return {
    nodes: (await f.root.scan({ range: { subtree: '/' }, budget: scanBudget() })).items,
    journal: (await f.root.scan({ range: { journal: '/' }, budget: scanBudget() })).items,
  }
}

describe('public native forms', { timeout: 30_000 }, () => {
  it('uses a W-only node executor for child writes while its caller has only R', async t => {
    const seen: { caller: Principal; executor: Principal; settings: unknown }[] = []
    const f = await fixture(t, { forms: { submit: { kind: 'setuid', args: {},
      handler: async function(this: { destination: string }, ctx) {
        seen.push({ caller: ctx.caller.principal, executor: ctx.executor.principal, settings: this.destination })
        await assert.rejects(ctx.read.read({ node: ctx.node.$path }), code('NOT_FOUND'))
        await assert.rejects(ctx.read.read({ node: '/private' }), code('NOT_FOUND'))
        ctx.change.put({ $path: this.destination + '/submission', $type: 't.dir', email: 'reader@example.test' })
        return 'accepted'
      } } } })
    await f.grant(formPath, [{ path: formPath, bits: W, public: R }])
    const form = await f.node(formPath)
    const caller = await f.visitor()
    const request = { path: formPath, action: 'submit', args: {}, opId: f.key() }
    const outcome = await caller.act(request).outcome
    assert.equal(outcome.value, 'accepted')
    assert.ok(outcome.pos)
    assert.deepEqual(seen, [{ caller: caller.actor.principal, executor: `n:${form.$id}`, settings: formPath }])
    assert.equal((await f.node(formPath + '/submission')).email, 'reader@example.test')
    assert.equal((await f.node(formPath)).$rev, form.$rev)
    await assert.rejects(caller.commit({ opId: f.key(), changes: [
      { op: 'put', node: { $path: formPath + '/direct', $type: 't.dir' } },
    ] }).outcome, code('FORBIDDEN'))
    const records = (await f.root.scan({ range: { journal: formPath }, budget: scanBudget() })).items
    const record = records.find(item => item.decision?.opId.nonce === request.opId.nonce)
    assert.ok(record)
    assert.equal(record.caller, caller.actor.principal)
    assert.equal(record.executor, `n:${form.$id}`)
    assert.deepEqual(record.pos, outcome.pos)
  })

  it('denies missing executor grants, invalid arguments, failed preconditions and caller invisibility atomically', async t => {
    let calls = 0
    const submit: TypeDef['actions'][string] = { kind: 'setuid',
      args: { type: 'object', required: ['email'], properties: { email: { type: 'string' } }, additionalProperties: false },
      handler: async ctx => {
        calls++
        ctx.change.put({ $path: ctx.node.$path + '/submission', $type: 't.dir' })
      } }
    const f = await fixture(t, { forms: { submit,
      pre: { ...submit, pre: { 'node.enabled': true } },
      outside: { kind: 'setuid', args: {}, handler: async ctx => {
        calls++; ctx.change.put({ $path: '/private/submission', $type: 't.dir' })
      } },
    } })
    const caller = await f.visitor()
    let before = await acceptedState(f)
    await assert.rejects(caller.act({ path: formPath, action: 'submit', args: { email: 'valid' }, opId: f.key() }).outcome, code('FORBIDDEN'))
    assert.equal(calls, 1)
    assert.deepEqual(await acceptedState(f), before)
    await f.grant(formPath, [{ path: formPath, bits: W }])
    before = await acceptedState(f)
    await assert.rejects(caller.act({ path: formPath, action: 'submit', args: { email: 3 }, opId: f.key() }).outcome, code('INVALID'))
    await assert.rejects(caller.act({ path: formPath, action: 'pre', args: { email: 'valid' }, opId: f.key() }).outcome, code('CONFLICT'))
    assert.equal(calls, 1)
    await assert.rejects(caller.act({ path: formPath, action: 'outside', args: {}, opId: f.key() }).outcome, code('FORBIDDEN'))
    assert.equal(calls, 2)
    assert.deepEqual(await acceptedState(f), before)
    await f.admin.commit({ opId: f.key(), changes: [{ op: 'patch', path: '/forms',
      ops: { $set: { $acl: [{ subject: { group: 'public' }, deny: R }] } } }] }).outcome
    before = await acceptedState(f)
    await assert.rejects(caller.act({ path: formPath, action: 'submit', args: { email: 'valid' }, opId: f.key() }).outcome, code('NOT_FOUND'))
    assert.equal(calls, 2)
    assert.deepEqual(await acceptedState(f), before)
  })

  it('judges caller and executor gates with the original network origin before any effect', async t => {
    const seen: { principal: Principal; origin: string | undefined }[] = []
    let refuse: 'caller' | 'executor' | undefined = 'caller'
    let calls = 0
    const gate: Gate = async (operation, actor) => {
      if (operation.kind !== 'act') return 'pass'
      seen.push({ principal: actor.principal, origin: operation.origin })
      if (refuse === 'caller' && actor.principal.startsWith('anon:')) return { refuse: 'REFUSED' }
      if (refuse === 'executor' && actor.principal.startsWith('n:')) return { refuse: 'BUDGET' }
      return 'pass'
    }
    const f = await fixture(t, { gates: [gate], forms: { submit: { kind: 'setuid', args: {}, handler: async ctx => {
      calls++; ctx.change.put({ $path: ctx.node.$path + '/submission', $type: 't.dir' })
    } } } })
    await f.grant(formPath, [{ path: formPath, bits: W }])
    const form = await f.node(formPath)
    const caller = await f.visitor('2001:db8::1')
    const before = await acceptedState(f)
    await assert.rejects(caller.act({ path: formPath, action: 'submit', args: {}, opId: f.key() }).outcome, code('REFUSED'))
    assert.deepEqual(seen, [{ principal: caller.actor.principal, origin: '2001:db8::1' }])
    seen.length = 0; refuse = 'executor'
    await assert.rejects(caller.act({ path: formPath, action: 'submit', args: {}, opId: f.key() }).outcome, code('BUDGET'))
    assert.deepEqual(seen, [
      { principal: caller.actor.principal, origin: '2001:db8::1' },
      { principal: `n:${form.$id}`, origin: '2001:db8::1' },
    ])
    assert.equal(calls, 0)
    assert.deepEqual(await acceptedState(f), before)
    seen.length = 0; refuse = undefined
    await caller.act({ path: formPath, action: 'submit', args: {}, opId: f.key() }).outcome
    assert.equal(calls, 1)
    assert.deepEqual(seen.map(item => item.principal), [caller.actor.principal, `n:${form.$id}`])
  })

  it('replays the original caller outcome once after the executor node is deleted', async t => {
    let calls = 0
    const f = await fixture(t, { forms: { submit: { kind: 'setuid', args: {}, handler: async ctx => {
      calls++; ctx.change.put({ $path: ctx.node.$path + '/submission', $type: 't.dir' }); return calls
    } } } })
    await f.grant(formPath, [{ path: formPath, bits: W }])
    const caller = await f.visitor()
    const request = { path: formPath, action: 'submit', args: {}, opId: f.key() }
    const outcome = await caller.act(request).outcome
    await f.admin.commit({ opId: f.key(), changes: [{ op: 'remove', path: formPath }] }).outcome
    const before = await acceptedState(f)
    assert.deepEqual(await caller.act(request).outcome, outcome)
    assert.equal(calls, 1)
    assert.deepEqual(await acceptedState(f), before)
  })

  it('keeps caller authorization dependencies when an ancestor loses R during a held handler', async t => {
    const entered = event(); const release = event()
    t.after(() => release.resolve())
    const f = await fixture(t, { forms: { submit: { kind: 'setuid', args: {}, handler: async ctx => {
      ctx.change.put({ $path: ctx.node.$path + '/submission', $type: 't.dir' })
      entered.resolve(); await release.promise
    } } } })
    await f.grant(formPath, [{ path: formPath, bits: W }])
    const form = await f.node(formPath)
    const caller = await f.visitor()
    const pending = caller.act({ path: formPath, action: 'submit', args: {}, opId: f.key() })
    await entered.promise
    await f.admin.commit({ opId: f.key(), changes: [{ op: 'patch', path: '/forms',
      ops: { $set: { $acl: [{ subject: { group: 'public' }, deny: R }] } } }] }).outcome
    assert.equal((await f.node(formPath)).$rev, form.$rev)
    const before = await acceptedState(f)
    release.resolve()
    await assert.rejects(pending.outcome, code('CONFLICT'))
    assert.deepEqual(await acceptedState(f), before)
    assert.ok('node' in (await caller.read({ node: workerPath })).copies[0])
  })

  it('pins the executor settings and refuses a changed configuration before releasing outer effects', async t => {
    const entered = event(); const release = event()
    t.after(() => release.resolve())
    const f = await fixture(t, { forms: { submit: { kind: 'setuid', args: {}, handler: async function(this: { destination: string }, ctx) {
      ctx.change.put({ $path: this.destination + '/submission', $type: 't.dir' })
      entered.resolve(); await release.promise
    } } } })
    await f.grant(formPath, [{ path: formPath, bits: W }])
    const caller = await f.visitor()
    const pending = caller.act({ path: formPath, action: 'submit', args: {}, opId: f.key() })
    await entered.promise
    await f.admin.commit({ opId: f.key(), changes: [{ op: 'patch', path: formPath,
      ops: { $set: { destination: '/private' } } }] }).outcome
    const before = await acceptedState(f)
    release.resolve()
    await assert.rejects(pending.outcome, code('CONFLICT'))
    assert.deepEqual(await acceptedState(f), before)
    assert.ok('node' in (await caller.read({ node: workerPath })).copies[0])
  })

  it('aborts a held executor admission on group revocation and releases its lane quota', async t => {
    const entered = event(); const release = event()
    t.after(() => release.resolve())
    const f = await fixture(t, { forms: { submit: { kind: 'setuid', args: {}, handler: async ctx => {
      ctx.change.put({ $path: ctx.node.$path + '/submission', $type: 't.dir' })
      entered.resolve(); await release.promise
    } } } })
    await f.grant(formPath, [{ path: formPath, bits: W }])
    await f.admin.commit({ opId: f.key(), changes: [{ op: 'patch', path: '/sys/limits',
      ops: { $set: { maxLanes: 3, lanesPerOrigin: 1 } } }] }).outcome
    const caller = await f.visitor()
    const pending = caller.act({ path: formPath, action: 'submit', args: {}, opId: f.key() })
    await entered.promise
    await f.admin.commit({ opId: f.key(), changes: [{ op: 'patch', path: formPath,
      ops: { $set: { '#membership': { $type: 't.groups', list: ['agents'] } } } }] }).outcome
    await assert.rejects(pending.outcome, code('UNAUTHENTICATED'))
    release.resolve()
    await f.admin.commit({ opId: f.key(), changes: [{ op: 'patch', path: formPath,
      ops: { $unset: { '#membership': true } } }] }).outcome
    const before = await acceptedState(f)
    const executor = await f.instance.openNodeSession(formPath)
    f.deliveries.push(drainSession(executor))
    assert.deepEqual(executor.actor.claims, [executor.actor.principal])
    executor.close()
    assert.deepEqual(await acceptedState(f), before)
    assert.ok('node' in (await caller.read({ node: workerPath })).copies[0])
  })

  it('cancels a held form request without cancelling its caller and releases the owned node lane', async t => {
    const entered = event(); const release = event()
    t.after(() => release.resolve())
    const f = await fixture(t, { forms: { submit: { kind: 'setuid', args: {}, handler: async ctx => {
      ctx.change.put({ $path: ctx.node.$path + '/submission', $type: 't.dir' })
      entered.resolve(); await release.promise
    } } } })
    await f.grant(formPath, [{ path: formPath, bits: W }])
    await f.admin.commit({ opId: f.key(), changes: [{ op: 'patch', path: '/sys/limits',
      ops: { $set: { maxLanes: 3, lanesPerOrigin: 1 } } }] }).outcome
    const caller = await f.visitor()
    const before = await acceptedState(f)
    const pending = caller.act({ path: formPath, action: 'submit', args: {}, opId: f.key() })
    await entered.promise
    caller.cancel(pending.id)
    await assert.rejects(pending.outcome, code('CANCELLED'))
    release.resolve()
    const executor = await f.instance.openNodeSession(formPath)
    f.deliveries.push(drainSession(executor))
    executor.close()
    assert.deepEqual(await acceptedState(f), before)
    assert.ok('node' in (await caller.read({ node: workerPath })).copies[0])
  })

  it('keeps the ordinary outer executor as the caller of a nested form', async t => {
    const seen: ActorTrace[] = []
    const f = await fixture(t, { forms: { submit: { kind: 'setuid', args: {}, handler: async ctx => {
      seen.push({ action: 'submit', caller: ctx.caller.principal, executor: ctx.executor.principal })
      ctx.change.put({ $path: ctx.node.$path + '/nested', $type: 't.dir' })
      return 'submitted'
    } } }, worker: { outer: { kind: 'write', args: {}, handler: async ctx => {
      seen.push({ action: 'outer', caller: ctx.caller.principal, executor: ctx.executor.principal })
      return ctx.act({ path: formPath, action: 'submit', args: {}, key: 'submit' })
    } } } })
    await f.grant(formPath, [{ path: formPath, bits: W }])
    const form = await f.node(formPath)
    const caller = await f.visitor()
    const request = { path: workerPath, action: 'outer', args: {}, opId: f.key() }
    assert.equal((await caller.act(request).outcome).value, 'submitted')
    assert.deepEqual(seen, [
      { action: 'outer', caller: caller.actor.principal, executor: caller.actor.principal },
      { action: 'submit', caller: caller.actor.principal, executor: `n:${form.$id}` },
    ])
    const records = (await f.root.scan({ range: { journal: '/' }, budget: scanBudget() })).items
    const inner = records.find(record => record.decision?.opId.nonce.startsWith('nested:'))
    const outer = records.find(record => record.decision?.opId.nonce === request.opId.nonce)
    assert.ok(inner && outer)
    assert.equal(inner.caller, caller.actor.principal)
    assert.equal(inner.executor, `n:${form.$id}`)
    assert.equal(outer.caller, caller.actor.principal)
    assert.equal(outer.executor, caller.actor.principal)
  })

  it('uses the form executor as both actors of a nested ordinary action and checks its own target rights', async t => {
    const seen: ActorTrace[] = []
    const f = await fixture(t, { forms: { submit: { kind: 'setuid', args: {}, handler: async ctx => {
      seen.push({ action: 'submit', caller: ctx.caller.principal, executor: ctx.executor.principal })
      return ctx.act({ path: workerPath, action: 'bump', args: {}, key: 'bump' })
    } } }, worker: { bump: { kind: 'write', args: {}, handler: async function(this: { count: number }, ctx) {
      seen.push({ action: 'bump', caller: ctx.caller.principal, executor: ctx.executor.principal })
      this.count++; return this.count
    } } } })
    await f.grant(formPath, [{ path: formPath, bits: W }])
    const form = await f.node(formPath)
    const caller = await f.visitor()
    const before = await acceptedState(f)
    await assert.rejects(caller.act({ path: formPath, action: 'submit', args: {}, opId: f.key() }).outcome, code('NOT_FOUND'))
    assert.deepEqual(await acceptedState(f), before)
    seen.length = 0
    await f.grant(formPath, [{ path: workerPath, bits: R }])
    await assert.rejects(caller.act({ path: formPath, action: 'submit', args: {}, opId: f.key() }).outcome, code('FORBIDDEN'))
    assert.equal((await f.node(workerPath)).count, 0)
    seen.length = 0
    await f.grant(formPath, [{ path: workerPath, bits: R | W }])
    const request = { path: formPath, action: 'submit', args: {}, opId: f.key() }
    assert.equal((await caller.act(request).outcome).value, 1)
    assert.deepEqual(seen, [
      { action: 'submit', caller: caller.actor.principal, executor: `n:${form.$id}` },
      { action: 'bump', caller: `n:${form.$id}`, executor: `n:${form.$id}` },
    ])
    const records = (await f.root.scan({ range: { journal: workerPath }, budget: scanBudget() })).items
    const record = records.find(item => item.decision?.opId.nonce.startsWith('nested:'))
    assert.ok(record)
    assert.equal(record.caller, `n:${form.$id}`)
    assert.equal(record.executor, `n:${form.$id}`)
  })

  it('switches a nested form to its own node while preserving the immediate caller and both gates', async t => {
    const seen: ActorTrace[] = []
    const judged: { path: string; principal: Principal }[] = []
    const gate: Gate = async (operation, actor) => {
      if (operation.kind === 'act') judged.push({ path: operation.path, principal: actor.principal })
      return 'pass'
    }
    const f = await fixture(t, { gates: [gate], forms: {
      outer: { kind: 'setuid', args: {}, handler: async ctx => {
        seen.push({ action: 'outer', caller: ctx.caller.principal, executor: ctx.executor.principal })
        return ctx.act({ path: secondPath, action: 'inner', args: {}, key: 'inner' })
      } },
      inner: { kind: 'setuid', args: {}, handler: async ctx => {
        seen.push({ action: 'inner', caller: ctx.caller.principal, executor: ctx.executor.principal })
        ctx.change.put({ $path: ctx.node.$path + '/accepted', $type: 't.dir' })
        return ctx.executor.principal
      } },
    } })
    await f.grant(formPath, [{ path: formPath, bits: W }, { path: secondPath, bits: R }])
    await f.grant(secondPath, [{ path: secondPath, bits: W }])
    const form = await f.node(formPath); const second = await f.node(secondPath)
    const caller = await f.visitor()
    const request = { path: formPath, action: 'outer', args: {}, opId: f.key() }
    assert.equal((await caller.act(request).outcome).value, `n:${second.$id}`)
    assert.deepEqual(seen, [
      { action: 'outer', caller: caller.actor.principal, executor: `n:${form.$id}` },
      { action: 'inner', caller: `n:${form.$id}`, executor: `n:${second.$id}` },
    ])
    assert.deepEqual(judged, [
      { path: formPath, principal: caller.actor.principal }, { path: formPath, principal: `n:${form.$id}` },
      { path: secondPath, principal: `n:${form.$id}` }, { path: secondPath, principal: `n:${second.$id}` },
    ])
    const records = (await f.root.scan({ range: { journal: secondPath }, budget: scanBudget() })).items
    const record = records.find(item => item.decision?.opId.nonce.startsWith('nested:'))
    assert.ok(record)
    assert.equal(record.caller, `n:${form.$id}`)
    assert.equal(record.executor, `n:${second.$id}`)
  })

  it('keeps two anonymous callers with the same full outer key independent under a shared nested executor', async t => {
    let innerCalls = 0
    const f = await fixture(t, { forms: { submit: { kind: 'setuid', args: {}, handler: async ctx => ({
      caller: ctx.caller.principal,
      value: await ctx.act({ path: workerPath, action: 'bump', args: {}, key: 'bump' }),
    }) } }, worker: { bump: { kind: 'write', args: {}, handler: async function(this: { count: number }) {
      innerCalls++; this.count++; return this.count
    } } } })
    await f.grant(formPath, [{ path: formPath, bits: W }, { path: workerPath, bits: R | W }])
    const form = await f.node(formPath)
    const first = await f.visitor(); const second = await f.visitor()
    assert.notEqual(first.actor.principal, second.actor.principal)
    const request = { path: formPath, action: 'submit', args: {}, opId: f.key() }
    const one = await first.act(request).outcome
    const two = await second.act(request).outcome
    assert.deepEqual(one.value, { caller: first.actor.principal, value: 1 })
    assert.deepEqual(two.value, { caller: second.actor.principal, value: 2 })
    assert.deepEqual(await first.act(request).outcome, one)
    assert.deepEqual(await second.act(request).outcome, two)
    assert.equal(innerCalls, 2)
    assert.equal((await f.node(workerPath)).count, 2)
    const records = (await f.root.scan({ range: { journal: workerPath }, budget: scanBudget() })).items
    const nested = records.filter(record => record.decision?.opId.nonce.startsWith('nested:'))
    assert.equal(nested.length, 2)
    assert.equal(new Set(nested.map(record => record.decision?.opId.nonce)).size, 2)
    assert.deepEqual(nested.map(record => record.caller), [`n:${form.$id}`, `n:${form.$id}`])
  })

  it('replays an independently committed inner effect after the outer configuration conflicts', async t => {
    const entered = event(); const release = event(); const answers: unknown[] = []
    let attempts = 0; let innerCalls = 0
    t.after(() => release.resolve())
    const f = await fixture(t, { forms: { submit: { kind: 'setuid', args: {}, handler: async ctx => {
      attempts++
      answers.push(await ctx.act({ path: workerPath, action: 'bump', args: {}, key: 'bump' }))
      if (attempts === 1) { entered.resolve(); await release.promise }
      ctx.change.put({ $path: ctx.node.$path + '/accepted', $type: 't.dir' })
    } } }, worker: { bump: { kind: 'write', args: {}, handler: async function(this: { count: number }) {
      innerCalls++; this.count++; return this.count
    } } } })
    await f.grant(formPath, [{ path: formPath, bits: W }, { path: workerPath, bits: R | W }])
    const caller = await f.visitor()
    const request = { path: formPath, action: 'submit', args: {}, opId: f.key() }
    const pending = caller.act(request)
    await entered.promise
    assert.equal((await f.node(workerPath)).count, 1)
    await f.admin.commit({ opId: f.key(), changes: [{ op: 'patch', path: formPath, ops: { $inc: { count: 1 } } }] }).outcome
    release.resolve()
    await assert.rejects(pending.outcome, code('CONFLICT'))
    await assert.rejects(f.admin.read({ node: formPath + '/accepted' }), code('NOT_FOUND'))
    await caller.act(request).outcome
    assert.deepEqual(answers, [1, 1])
    assert.equal(innerCalls, 1)
    assert.equal((await f.node(workerPath)).count, 1)
    assert.equal((await f.node(formPath + '/accepted')).$type, 't.dir')
  })

  it('withholds a changed inner request under the same logical key without repeating its effect', async t => {
    const entered = event(); const release = event()
    let attempts = 0; let innerCalls = 0
    t.after(() => release.resolve())
    const f = await fixture(t, { forms: { submit: { kind: 'setuid', args: {}, handler: async ctx => {
      attempts++
      await ctx.act({ path: workerPath, action: 'bump', args: { amount: ctx.node.count }, key: 'bump' })
      if (attempts === 1) { entered.resolve(); await release.promise }
    } } }, worker: { bump: { kind: 'write', args: {}, handler: async function(this: { count: number }) {
      innerCalls++; this.count++
    } } } })
    await f.grant(formPath, [{ path: formPath, bits: W }, { path: workerPath, bits: R | W }])
    const caller = await f.visitor()
    const request = { path: formPath, action: 'submit', args: {}, opId: f.key() }
    const pending = caller.act(request)
    await entered.promise
    await f.admin.commit({ opId: f.key(), changes: [{ op: 'patch', path: formPath, ops: { $inc: { count: 1 } } }] }).outcome
    release.resolve()
    await assert.rejects(pending.outcome, code('CONFLICT'))
    const before = await acceptedState(f)
    await assert.rejects(caller.act(request).outcome, code('KEY_REUSED'))
    assert.equal(innerCalls, 1)
    assert.equal((await f.node(workerPath)).count, 1)
    assert.deepEqual(await acceptedState(f), before)
  })

  it('forbids read and post parents from entering a nested setuid mutation', async t => {
    let calls = 0
    const f = await fixture(t, { forms: { submit: { kind: 'setuid', args: {}, handler: async ctx => {
      calls++; ctx.change.put({ $path: ctx.node.$path + '/submission', $type: 't.dir' })
    } } }, worker: {
      read: { kind: 'read', args: {}, handler: async ctx => ctx.act({ path: formPath, action: 'submit', args: {}, key: 'submit' }) },
      post: { kind: 'write', args: {}, post: {}, handler: async ctx => ctx.act({ path: formPath, action: 'submit', args: {}, key: 'submit' }) },
    } })
    await f.grant(formPath, [{ path: formPath, bits: W }])
    const caller = await f.visitor()
    const before = await acceptedState(f)
    await assert.rejects(caller.act({ path: workerPath, action: 'read', args: {} }).outcome, code('FORBIDDEN'))
    await assert.rejects(caller.act({ path: workerPath, action: 'post', args: {}, opId: f.key() }).outcome, code('FORBIDDEN'))
    assert.equal(calls, 0)
    assert.deepEqual(await acceptedState(f), before)
  })

  it('keeps one nesting limit across repeated node executor acquisition', async t => {
    let calls = 0
    const f = await fixture(t, { forms: { recurse: { kind: 'setuid', args: {}, handler: async ctx => {
      calls++
      return ctx.act({ path: ctx.node.$path, action: 'recurse', args: {}, key: 'next' })
    } } } })
    await f.grant(formPath, [{ path: formPath, bits: R | W }])
    await f.admin.commit({ opId: f.key(), changes: [{ op: 'patch', path: '/sys/limits', ops: { $set: { actionDepth: 1 } } }] }).outcome
    const caller = await f.visitor()
    const before = await acceptedState(f)
    await assert.rejects(caller.act({ path: formPath, action: 'recurse', args: {}, opId: f.key() }).outcome, code('BUDGET'))
    assert.equal(calls, 2)
    assert.deepEqual(await acceptedState(f), before)
  })

  it('inherits the outer deadline through a held nested ordinary action', async t => {
    const entered = event(); const release = event()
    t.after(() => release.resolve())
    const f = await fixture(t, { forms: { submit: { kind: 'setuid', args: {}, handler: async ctx =>
      ctx.act({ path: workerPath, action: 'held', args: {}, key: 'held' }) } },
      worker: { held: { kind: 'write', args: {}, handler: async function(this: { count: number }) {
        this.count++; entered.resolve(); await release.promise
      } } },
    })
    await f.grant(formPath, [{ path: formPath, bits: W }, { path: workerPath, bits: R | W }])
    await f.admin.commit({ opId: f.key(), changes: [{ op: 'patch', path: '/sys/limits', ops: { $set: { actionMs: 10 } } }] }).outcome
    const caller = await f.visitor()
    const before = await acceptedState(f)
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() })
    const pending = caller.act({ path: formPath, action: 'submit', args: {}, opId: f.key() })
    await entered.promise
    t.mock.timers.tick(11)
    await assert.rejects(pending.outcome, code('BUDGET'))
    release.resolve()
    assert.deepEqual(await acceptedState(f), before)
  })

  it('preserves the canonical accepted outcome when cancellation arrives before publication', async t => {
    const accepted = event(); const release = event()
    let calls = 0
    t.after(() => release.resolve())
    const f = await fixture(t, { forms: { submit: { kind: 'setuid', args: {}, handler: async ctx => {
      calls++; ctx.change.put({ $path: ctx.node.$path + '/submission', $type: 't.dir' }); return calls
    } } } })
    await f.grant(formPath, [{ path: formPath, bits: W }])
    const caller = await f.visitor()
    const request = { path: formPath, action: 'submit', args: {}, opId: f.key() }
    const persist = f.root.commit.bind(f.root)
    t.mock.method(f.root, 'commit', async (commit: Parameters<typeof persist>[0]) => {
      await persist(commit)
      if (commit.record.decision?.opId.nonce === request.opId.nonce) {
        accepted.resolve(); await release.promise
      }
    })
    const first = caller.act(request)
    await accepted.promise
    const durable = (await f.root.scan({ range: { node: formPath + '/submission' }, budget: scanBudget() })).items
    assert.equal(durable.length, 1)
    const duplicate = caller.act(request)
    caller.cancel(first.id); caller.cancel(duplicate.id)
    release.resolve()
    const outcome = await first.outcome
    assert.ok(outcome.pos)
    assert.equal(outcome.value, 1)
    assert.deepEqual(await duplicate.outcome, outcome)
    assert.deepEqual(await caller.act(request).outcome, outcome)
    assert.equal(calls, 1)
    assert.equal((await f.node(formPath + '/submission')).$id, durable[0].$id)
  })

  it('releases its executor admission when the original caller session closes', async t => {
    const entered = event(); const release = event(); const ended = event()
    t.after(() => release.resolve())
    const f = await fixture(t, { forms: { submit: { kind: 'setuid', args: {}, handler: async ctx => {
      ctx.change.put({ $path: ctx.node.$path + '/submission', $type: 't.dir' })
      entered.resolve(); await release.promise
    } } } })
    await f.grant(formPath, [{ path: formPath, bits: W }])
    await f.admin.commit({ opId: f.key(), changes: [{ op: 'patch', path: '/sys/limits',
      ops: { $set: { maxLanes: 3, lanesPerOrigin: 1 } } }] }).outcome
    const caller = await f.visitor()
    const open = f.instance.sessionFactory.openNode.bind(f.instance.sessionFactory)
    t.mock.method(f.instance.sessionFactory, 'openNode', async (...args: Parameters<typeof open>) => {
      const owned = await open(...args)
      owned.admission.signal.addEventListener('abort', ended.resolve, { once: true })
      return owned
    })
    const before = await acceptedState(f)
    const pending = caller.act({ path: formPath, action: 'submit', args: {}, opId: f.key() })
    await entered.promise
    caller.close()
    await assert.rejects(pending.outcome, code('CANCELLED'))
    await ended.promise
    release.resolve()
    const replacement = await f.visitor()
    const executor = await f.instance.openNodeSession(formPath)
    f.deliveries.push(drainSession(executor))
    executor.close()
    assert.ok('node' in (await replacement.read({ node: workerPath })).copies[0])
    assert.deepEqual(await acceptedState(f), before)
  })

  it('refuses a real Fs path identity and replays an issued form outcome after persistent reopen', async t => {
    let calls = 0
    const module: ModuleManifest = { id: 'persistent-public-forms', types: [
      { name: 'persistent.form', module: 'persistent-public-forms', security: 'user-capability',
        version: 0, schema: {}, actions: { submit: { kind: 'setuid', args: {}, handler: async ctx => {
          calls++; ctx.change.put({ $path: ctx.node.$path + '/submission', $type: 't.dir', accepted: true })
          return 'accepted'
        } } } },
    ], security: [], open: [] }
    const parent = resolve('../../temp/k35-native-fs-contract')
    await mkdir(parent, { recursive: true })
    const directory = await mkdtemp(join(parent, 'instance-'))
    const data = join(directory, 'host-data')
    await mkdir(data)
    const physical = JSON.stringify({ $type: 'persistent.form', destination: '/data/form',
      $acl: [{ subject: { group: 'public' }, grant: R }] })
    await writeFile(join(data, 'form.json'), physical)
    const config = { id: `persistent-form:${randomUUID()}`, directory: join(directory, 'root'),
      credentialTtlMs: 60_000, modules: [module], mountDirectories: { data },
      firstAdmin: { path: '/admin', name: 'admin', password: randomUUID() } }
    const runtimes: Awaited<ReturnType<typeof openNativeRuntime>>[] = []
    const deliveries: Promise<void>[] = []
    t.after(async () => {
      for (const runtime of runtimes.reverse()) await runtime.close()
      await Promise.all(deliveries)
    })
    const first = await openNativeRuntime(config); runtimes.push(first)
    assert.ok(first.instance.setupCredential)
    const admin = await first.instance.openSession(first.instance.setupCredential)
    deliveries.push(drainSession(admin))
    const seedKey = { epoch: first.instance.writer.intake.epoch, time: Date.now(), nonce: 'seed' }
    await admin.commit({ opId: seedKey, changes: [
      { op: 'put', node: { $path: '/data', $type: 't.dir',
        $acl: [{ subject: { group: 'public' }, grant: R }],
        '#mount': { $type: 't.mount.fs', pattern: '', directory: 'data', external: 'none' },
        '#groups': { $type: 't.groups', list: ['admins'] } } },
      { op: 'put', node: { $path: '/issued', $type: 'persistent.form',
        $acl: [{ subject: { group: 'public' }, grant: R }] } },
    ] }).outcome
    const issued = (await admin.read({ node: '/issued' })).copies[0]
    assert.ok('node' in issued)
    await admin.commit({ opId: { ...seedKey, nonce: 'grant' },
      expect: { nodes: [{ path: '/issued', rev: issued.node.$rev }] }, changes: [
        { op: 'patch', path: '/issued', ops: { $set: { $acl: [
          { subject: { group: 'public' }, grant: R },
          { subject: { group: `n:${issued.node.$id}` }, grant: W },
        ] } } },
      ],
    }).outcome
    await first.close()
    const second = await openNativeRuntime(config); runtimes.push(second)
    const caller = await second.instance.openSession()
    const welcome = await caller.lane[Symbol.asyncIterator]().next()
    assert.ok(!welcome.done && welcome.value.t === 'welcome' && welcome.value.credential)
    const credential = welcome.value.credential
    deliveries.push(drainSession(caller))
    const imported = (await caller.read({ node: '/data/form' })).copies[0]
    assert.ok('node' in imported)
    assert.equal(imported.node.$id, 'p:/data/form')
    const before = (await caller.read({ node: '/data/form' })).at
    await assert.rejects(second.instance.openNodeSession('/data/form'), code('INVALID'))
    await assert.rejects(caller.act({ path: '/data/form', action: 'submit', args: {},
      opId: { epoch: second.instance.writer.intake.epoch, time: Date.now(), nonce: 'path-identity' } }).outcome, code('INVALID'))
    assert.equal(calls, 0)
    assert.equal(await readFile(join(data, 'form.json'), 'utf8'), physical)
    assert.deepEqual((await caller.read({ node: '/data/form' })).at, before)

    const request = { path: '/issued', action: 'submit', args: {},
      opId: { epoch: second.instance.writer.intake.epoch, time: Date.now(), nonce: 'issued' } }
    const outcome = await caller.act(request).outcome
    assert.equal(outcome.value, 'accepted')
    assert.ok(outcome.pos)
    await second.close()
    const third = await openNativeRuntime(config); runtimes.push(third)
    const reconnected = await third.instance.openSession(credential)
    deliveries.push(drainSession(reconnected))
    assert.deepEqual(reconnected.actor, caller.actor)
    assert.deepEqual(await reconnected.act(request).outcome, outcome)
    assert.equal(calls, 1)
    const child = (await reconnected.read({ node: '/issued/submission' })).copies[0]
    assert.ok('node' in child)
    assert.equal(child.node.accepted, true)
  })
})
