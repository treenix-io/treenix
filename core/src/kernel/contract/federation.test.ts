import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { EventEmitter, once } from 'node:events'
import { it, type TestContext } from 'node:test'
import { createTwpHttpFederation, openTwpHttp } from '#client/http-twp'
import { createTwpClient } from '#client/twp'
import { KernelError } from '#errors'
import { prepareCredential } from '#kernel/auth/credentials'
import { createMemoryBlobStore } from '#kernel/blob-store-memory'
import { createInstance } from '#kernel/instance'
import { createAuthorityNamespace } from '#kernel/authority/namespace'
import { positionToRev, revToPosition } from '#kernel/position'
import { drainSession } from '#kernel/session-delivery'
import { createMemoryStore } from '#kernel/store/memory'
import { R, DEFAULT_LIMITS, type BlobStore, type FederationBinding, type Gate, type ModuleManifest, type Node, type Position, type PositionCounter } from '#kernel/types'
import { createTwpHttpServer } from '#server/http-twp'

const code = (expected: KernelError['code']) => (error: unknown) => error instanceof KernelError && error.code === expected
const module: ModuleManifest = { id: 'foreign-example', security: [], open: [], types: [{ name: 'foreign.counter',
  module: 'foreign-example', security: 'ordinary', version: 0, schema: {}, actions: {
    read_count: { kind: 'read', args: {}, handler: async ctx => (await ctx.read.read({ node: '/counter' })).copies[0] },
    increment: { kind: 'write', args: {}, handler: async ctx => { ctx.change.patch('/counter', { $inc: { count: 1 } }); return 'accepted' } },
    steps: { kind: 'write', args: {}, handler: async function* (ctx) {
      ctx.change.patch('/counter', { $inc: { count: 1 } }); yield 'first'
      ctx.change.patch('/counter', { $inc: { count: 1 } }); yield 'second'
      return 'finished'
    } },
  } }, { name: 'foreign.replacement', module: 'foreign-example', security: 'ordinary', version: 0, schema: {}, actions: {} }] }

/** Both instances use their native Writer, mount table, admitted Sessions and actual HTTP lanes. */
async function instance(t: TestContext, options: { modules?: readonly ModuleManifest[]; federation?: FederationBinding; blobs?: BlobStore; gates?: readonly Gate[] } = {}) {
  const id = randomUUID(), root = createMemoryStore({ domain: id })
  let saved: Position | undefined, epoch = 0
  const counter: PositionCounter = { async load() { return saved }, async save(pos) { saved = pos },
    async freshEpoch(floor) { epoch = Math.max(epoch, floor) + 1; return epoch } }
  const runtime = await createInstance({ id, root: { kind: 'store', store: root }, modules: options.modules ?? [],
    federation: options.federation, gates: options.gates, blobs: options.blobs ?? createMemoryBlobStore(), provisioning: { counter, writerEpoch: 1,
      domains: [{ store: root, epoch: randomUUID(), persistent: false }], credentialTtlMs: 60_000,
      bootstrap: { kind: 'fresh', admin: { path: '/admin', name: 'admin', password: randomUUID() } } } })
  const pumps: Promise<void>[] = []
  t.after(async () => { await runtime.close(); await Promise.all(pumps); root.close() })
  assert.ok(runtime.setupCredential)
  const admin = await runtime.openSession(runtime.setupCredential)
  pumps.push(drainSession(admin))
  const key = () => ({ epoch: runtime.writer.intake.epoch, time: Date.now(), nonce: randomUUID() })
  return { id, root, runtime, admin, key, pumps }
}

async function federation(t: TestContext, options: { remoteGates?: readonly Gate[]; remoteModules?: readonly ModuleManifest[]; originModules?: readonly ModuleManifest[]; originGate?: Gate; loseOutcome?: boolean; unsolicitedCopies?: boolean } = {}) {
  const remote = await instance(t, { modules: options.remoteModules ?? [module], gates: options.remoteGates })
  const http = createTwpHttpServer({ instance: remote.runtime, allowedOrigins: [], credentialTtlMs: 60_000 })
  t.after(() => http.close())
  http.server.listen(0, '127.0.0.1')
  await once(http.server, 'listening')
  const address = http.server.address()
  assert.ok(address !== null && typeof address === 'object')
  let stats = 0, gets = 0
  const memory = createMemoryBlobStore()
  const blobs: BlobStore = { ...memory, async stat(id) { stats++; return memory.stat(id) }, get(id) { gets++; return memory.get(id) } }
  let opens = 0, secretReads = 0, closes = 0
  const lifecycle = new EventEmitter()
  const transport = createTwpHttpFederation()
  let loseOutcome = options.loseOutcome === true
  const origin = await instance(t, { modules: options.originModules, federation: async (url, limits) => {
    opens++
    const resource = await transport(url, limits)
    let closing: Promise<void> | undefined
    return { authority: { kind: 'federation', async connect(credential) {
      const connection = await resource.authority.connect(credential)
      return { send: request => connection.send(request), frames: { async *[Symbol.asyncIterator]() {
        for await (const frame of connection.frames) {
          if (frame.t === 'fail' && frame.error.code === 'CANCELLED') lifecycle.emit('cancelled')
          if (loseOutcome && frame.t === 'done' && frame.value === 'accepted') {
            loseOutcome = false
            throw new KernelError('UNAVAILABLE', 'Accepted answer connection was lost')
          }
          yield frame
          if (options.unsolicitedCopies && frame.t === 'welcome') {
            const result = await remote.admin.read({ node: '/counter' })
            const copy = result.copies[0]
            assert.ok('node' in copy)
            for (let index = 1; index <= 3; index++) {
              const pos = { ...result.at[0], seq: result.at[0].seq + index }
              yield { t: 'pos', pos, changes: [{ op: 'put', copy: {
                ...copy, node: { ...copy.node, $id: randomUUID(), $rev: positionToRev(pos) },
              } }] }
            }
          }
        }
      } } }
    } }, close: () => closing ??= resource.close().then(() => {
      closes++; lifecycle.emit('closed')
    }) }
  }, blobs,
    gates: [...(options.originGate === undefined ? [] : [options.originGate]), async operation => {
      if (operation.kind === 'read' && 'node' in operation.selector && operation.selector.node === '/secret') secretReads++
      return 'pass'
    }] })
  await origin.admin.commit({ opId: origin.key(), changes: [{ op: 'put', node: { $path: '/foreign', $type: 't.dir',
    $acl: [{ subject: { group: 'public' }, grant: R }] } }] }).outcome
  const declaring = (await origin.admin.read({ node: '/foreign' })).copies[0]
  assert.ok('node' in declaring)
  assert.ok(remote.runtime.setupCredential)
  await origin.admin.commit({ opId: origin.key(), changes: [
    { op: 'patch', path: '/foreign', ops: { $set: { '#remote': { $type: 't.mount.federation', pattern: '',
      url: `http://127.0.0.1:${address.port}`, credential: '/secret', allowPrivate: true } } } },
  ] }).outcome
  const executor = (await origin.admin.read({ node: '/foreign' })).copies[0]
  assert.ok('node' in executor)
  await origin.admin.commit({ opId: origin.key(), expect: { nodes: [{ path: '/foreign', rev: executor.node.$rev }] }, changes: [
    { op: 'put', node: { $path: '/secret', $type: 't.outbound-credential', $owner: `n:${declaring.node.$id}`,
      token: remote.runtime.setupCredential.token, $acl: [{ subject: { owner: true }, grant: R }] } },
  ] }).outcome
  const caller = await origin.runtime.openSession()
  origin.pumps.push(drainSession(caller))
  return { origin, remote, caller, blobCalls: () => ({ stats, gets }), credentialCalls: () => ({ opens, secretReads }),
    waitCancelled: () => once(lifecycle, 'cancelled'),
    async waitClosed(count: number) { while (closes < count) await once(lifecycle, 'closed') } }
}

it('keeps active federation connections through unrelated accepted origin writes', async t => {
  const f = await federation(t)
  await f.remote.admin.commit({ opId: f.remote.key(), changes: [{ op: 'put', node: {
    $path: '/counter', $type: 'foreign.counter', count: 1,
  } }] }).outcome
  assert.equal((await f.caller.read({ node: '/foreign/counter' })).copies.length, 1)
  const before = f.credentialCalls()
  await f.origin.admin.commit({ opId: f.origin.key(), changes: [{ op: 'put', node: {
    $path: '/unrelated', $type: 't.dir',
  } }] }).outcome
  assert.deepEqual(f.credentialCalls(), before)
  const second = await f.caller.read({ node: '/foreign/counter' })
  assert.equal(second.copies.length, 1)
  assert.equal(f.credentialCalls().opens, before.opens)
  assert.equal(f.credentialCalls().secretReads - before.secretReads, 2)
})

it('retires both captured credential connections on admitted secret changes and opens fresh generations', async t => {
  const f = await federation(t)
  await f.remote.admin.commit({ opId: f.remote.key(), changes: [{ op: 'put', node: {
    $path: '/counter', $type: 'foreign.counter', count: 1,
  } }] }).outcome
  const second = await f.origin.runtime.openSession()
  f.origin.pumps.push(drainSession(second))
  assert.equal((await f.caller.read({ node: '/foreign/counter' })).copies.length, 1)
  assert.equal((await second.read({ node: '/foreign/counter' })).copies.length, 1)
  assert.equal(f.credentialCalls().opens, 2)
  const closed = f.waitClosed(2)
  await f.origin.admin.commit({ opId: f.origin.key(), changes: [{ op: 'patch', path: '/secret',
    ops: { $set: { $acl: [{ subject: { owner: true }, grant: R }, { subject: { group: 'public' }, deny: R }] } },
  }] }).outcome
  await closed
  assert.equal((await f.caller.read({ node: '/foreign/counter' })).copies.length, 1)
  assert.equal(f.credentialCalls().opens, 3)
  assert.equal((await second.read({ node: '/foreign/counter' })).copies.length, 1)
  assert.equal(f.credentialCalls().opens, 4)
})

it('activates real federation reads with mount-owned identities and rejects public secret and foreign blob access', async t => {
  const f = await federation(t)
  async function* body() { yield new TextEncoder().encode('foreign binary') }
  const ref = await f.remote.admin.upload(body(), 'application/octet-stream')
  await f.remote.admin.commit({ opId: f.remote.key(), changes: [{ op: 'put', node: { $path: '/counter',
    $type: 'foreign.counter', count: 1, body: ref, $acl: [{ subject: { group: 'public' }, grant: R }] } }] }).outcome
  const foreign = (await f.remote.admin.read({ node: '/counter' })).copies[0]
  const result = await f.caller.read({ node: '/foreign/counter' })
  assert.equal(result.copies.length, 1)
  const mapped = result.copies[0]
  assert.ok('node' in mapped && 'node' in foreign)
  assert.equal(mapped.node.$path, '/foreign/counter')
  assert.equal(mapped.node.count, 1)
  assert.notEqual(mapped.node.$id, foreign.node.$id)
  assert.notEqual(revToPosition(mapped.node.$rev).instance, f.origin.id)
  assert.notEqual(revToPosition(mapped.node.$rev).instance, f.remote.id)
  assert.deepEqual(result.at[0], revToPosition(mapped.node.$rev))
  assert.equal(mapped.bits, R)
  assert.equal(mapped.node.$acl, undefined)
  assert.equal(mapped.node.$owner, undefined)
  await assert.rejects(f.caller.read({ node: '/secret' }), code('NOT_FOUND'))
  await assert.rejects(async () => { for await (const part of f.caller.download('/foreign/counter', 'body')) assert.fail(String(part)) }, code('INVALID'))
  assert.deepEqual(f.blobCalls(), { stats: 0, gets: 0 })
  await f.remote.admin.commit({ opId: f.remote.key(), changes: [{ op: 'patch', path: '/counter', ops: { $inc: { count: 1 } } }] }).outcome
  await assert.rejects(f.caller.read({ history: '/foreign/counter' }), code('FORBIDDEN'))
  const history = await f.origin.admin.read({ history: '/foreign/counter' })
  assert.ok(history.history)
  const changed = history.history.find(entry => entry.before !== null && entry.before !== 'unknown')
  assert.ok(changed && changed.before !== null && changed.before !== 'unknown' && changed.after !== null)
  assert.equal(changed.path, '/foreign/counter')
  assert.equal(changed.before.count, 1)
  assert.equal(changed.after.count, 2)
  assert.deepEqual(changed.before.$acl, [{ subject: { group: 'public' }, grant: R }])
  assert.deepEqual(changed.after.$acl, changed.before.$acl)
})

it('projects every foreign history image and bounds deep external payload mapping without recursion', () => {
  const namespace = createAuthorityNamespace('origin', 'mount', '#remote', '/foreign', '/')
  const pos = { instance: 'remote', epoch: 1, seq: 1 }
  const node: Node = { $path: '/counter', $id: 'counter', $rev: positionToRev(pos), $type: 'foreign.counter',
    $acl: [{ subject: { group: 'private' }, grant: R }], $owner: 'u:remote', nested: { $type: 'ref', $ref: '/target' } }
  const budget = { nodes: 10, bytes: 1024 * 1024, exprWork: 1000, deadline: Date.now() + 1000 }
  const projected = namespace.result({ list: [], copies: [], at: [pos], history: [{ kind: 'commit',
    address: { id: node.$id, pos }, path: node.$path, executor: 'u:remote', caller: 'u:remote', before: node, after: node }] }, R, budget)
  const entry = projected.history?.[0]
  assert.ok(entry && entry.before !== null && entry.before !== 'unknown' && entry.after !== null)
  assert.equal(entry.before.$acl, undefined)
  assert.equal(entry.before.$owner, undefined)
  assert.equal(entry.after.$acl, undefined)
  assert.equal(entry.after.$owner, undefined)
  assert.deepEqual(entry.after.nested, { $type: 'ref', $ref: '/foreign/target' })
  const computed = namespace.result({ list: ['computed'], copies: [], at: [pos], computed: [{
    $id: 'computed', $rev: positionToRev(pos), $path: '/computed', $type: 'foreign.counter', nested: node.nested,
  }] }, R, budget)
  assert.deepEqual(computed.computed?.[0].nested, { $type: 'ref', $ref: '/foreign/target' })
  const rows = namespace.result({ list: [], copies: [], at: [pos], rows: [{ key: 'aggregate', nested: node.nested }] }, R, budget)
  assert.deepEqual(rows.rows?.[0].nested, { $type: 'ref', $ref: '/foreign/target' })
  const invalid = namespace.result({ list: [node.$id], at: [pos], copies: [{ id: node.$id, path: node.$path,
    ver: 'invalid', error: new KernelError('INVALID', 'Invalid node'),
    sort: { '$acl.0.grant': R, '$owner': 'u:remote', 'nested.$ref': '/target' },
    query: { $acl: node.$acl, $owner: node.$owner, nested: node.nested } }] }, R, budget)
  const errorCopy = invalid.copies[0]
  assert.ok('error' in errorCopy)
  assert.deepEqual(errorCopy.sort, { 'nested.$ref': '/foreign/target' })
  assert.deepEqual(errorCopy.query, { nested: { $type: 'ref', $ref: '/foreign/target' } })
  assert.throws(() => namespace.result({ list: Array.from({ length: 20 }, (_, index) => String(index)), copies: [], at: [pos] },
    R, { ...budget, exprWork: 16 }), code('BUDGET'))
  assert.throws(() => namespace.result({ list: ['x'.repeat(1024 * 1024)], copies: [], at: [pos] },
    R, { ...budget, exprWork: 1 }), code('BUDGET'))
  assert.throws(() => namespace.result({ list: new Array<string>(1_000_000).fill(''), copies: [], at: [pos] },
    R, { ...budget, exprWork: 1 }), code('BUDGET'))
  assert.throws(() => namespace.result({ list: [], copies: [], at: [pos], history: [{ kind: 'commit',
    address: { id: node.$id, pos }, path: node.$path, executor: 'u:remote', caller: 'u:remote', before: node, after: node }] },
    R, { ...budget, nodes: 1 }), code('BUDGET'))
  assert.throws(() => namespace.result({ list: [node.$id], copies: [{ node, bits: R, ver: 'one' }], at: [pos] },
    R, { ...budget, nodes: 0 }), code('BUDGET'))
  const bounded = createAuthorityNamespace('origin', 'other', '#remote', '/foreign', '/allowed')
  assert.throws(() => bounded.result({ list: ['computed'], copies: [], at: [pos], computed: [{
    $id: 'computed', $rev: positionToRev(pos), $path: '/allowed/computed', $type: 'foreign.counter', nested: node.nested,
  }] }, R, budget), code('INVALID'))
  let nested: unknown = null
  for (let depth = 0; depth < 10_000; depth++) nested = { nested }
  assert.throws(() => namespace.result({ list: [node.$id], copies: [{ node: { ...node, nested }, bits: R, ver: 'one' }], at: [pos] },
    R, { ...budget, exprWork: 16 }), code('BUDGET'))
})


it('forwards native actions with an immutable accepted key and foreign lane progression', async t => {
  const f = await federation(t)
  await f.remote.admin.commit({ opId: f.remote.key(), changes: [{ op: 'put', node: {
    $path: '/counter', $type: 'foreign.counter', count: 0,
  } }] }).outcome
  const request = { path: '/foreign/counter', action: 'increment', args: {}, opId: f.origin.key() }
  const accepted = await f.origin.admin.act(request).outcome
  assert.equal(accepted.value, 'accepted')
  assert.ok(accepted.pos)
  assert.notEqual(accepted.pos.instance, f.origin.id)
  assert.deepEqual(await f.origin.admin.act(request).outcome, accepted)
  const copy = (await f.remote.admin.read({ node: '/counter' })).copies[0]
  assert.ok('node' in copy)
  assert.equal(copy.node.count, 1)
  await assert.rejects(f.origin.admin.act({ ...request, args: { changed: true } }).outcome, code('KEY_REUSED'))
  const prepared = prepareCredential(f.origin.runtime.bootstrap.adminId, { expiresAt: Date.now() + 60_000, scope: ['/foreign'] })
  await f.origin.admin.commit({ opId: f.origin.key(), changes: [{ op: 'put', node: prepared.node }] }).outcome
  const narrowed = await f.origin.runtime.openSession(prepared.credential)
  f.origin.pumps.push(drainSession(narrowed))
  assert.equal(narrowed.actor.principal, f.origin.admin.actor.principal)
  await assert.rejects(narrowed.act(request).outcome, code('KEY_REUSED'))
  assert.deepEqual(await f.origin.admin.act(request).outcome, accepted)
  await assert.rejects(f.caller.act({ ...request, opId: f.origin.key() }).outcome, code('FORBIDDEN'))
})


it('reserves one original key while a genuine remote execution is unfinished', async t => {
  let release!: () => void, reached!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const entered = new Promise<void>(resolve => { reached = resolve })
  const f = await federation(t, { remoteGates: [async operation => {
    if (operation.kind === 'act' && operation.action === 'increment') { reached(); await held }
    return 'pass'
  }] })
  t.after(() => release())
  await f.remote.admin.commit({ opId: f.remote.key(), changes: [{ op: 'put', node: {
    $path: '/counter', $type: 'foreign.counter', count: 0,
  } }] }).outcome
  const request = { path: '/foreign/counter', action: 'increment', args: {}, opId: f.origin.key() }
  const first = f.origin.admin.act(request).outcome
  await entered
  await assert.rejects(f.origin.admin.act({ ...request, args: { different: true } }).outcome, code('KEY_REUSED'))
  release()
  assert.equal((await first).value, 'accepted')
  const copy = (await f.remote.admin.read({ node: '/counter' })).copies[0]
  assert.ok('node' in copy)
  assert.equal(copy.node.count, 1)
})

it('resumes a lost accepted answer using its first remote key and definition after remote intake changes', async t => {
  const f = await federation(t, { loseOutcome: true })
  await f.remote.admin.commit({ opId: f.remote.key(), changes: [{ op: 'put', node: {
    $path: '/counter', $type: 'foreign.counter', count: 0,
  } }] }).outcome
  const request = { path: '/foreign/counter', action: 'increment', args: {}, opId: f.origin.key() }
  await assert.rejects(f.origin.admin.act(request).outcome, code('UNAVAILABLE'))
  const before = (await f.remote.admin.read({ node: '/counter' })).copies[0]
  assert.ok('node' in before)
  assert.equal(before.node.count, 1)
  await f.remote.runtime.writer.refreshIntake(true)
  f.remote.runtime.registry.publish({ ...module, types: [{ ...module.types[0], actions: {
    increment: { kind: 'read', args: {}, handler: async () => 'replacement' },
  } }] })
  const replay = await f.origin.admin.act(request).outcome
  assert.equal(replay.value, 'accepted')
  const after = (await f.remote.admin.read({ node: '/counter' })).copies[0]
  assert.ok('node' in after)
  assert.equal(after.node.count, 1)
})


it('forwards one atomic commit with mapped preconditions and refuses mixed owners', async t => {
  const f = await federation(t)
  await f.remote.admin.commit({ opId: f.remote.key(), changes: [{ op: 'put', node: {
    $path: '/counter', $type: 'foreign.counter', count: 0,
  } }] }).outcome
  const before = (await f.origin.admin.read({ node: '/foreign/counter' })).copies[0]
  assert.ok('node' in before)
  const request = { opId: f.origin.key(), expect: { nodes: [{ path: '/foreign/counter', rev: before.node.$rev }] },
    changes: [{ op: 'patch' as const, path: '/foreign/counter', ops: { $inc: { count: 1 } } }] }
  const accepted = await f.origin.admin.commit(request).outcome
  assert.ok(accepted.pos)
  assert.notEqual(accepted.pos.instance, f.origin.id)
  assert.deepEqual(await f.origin.admin.commit(request).outcome, accepted)
  await assert.rejects(f.origin.admin.commit({ opId: f.origin.key(), changes: [
    { op: 'patch', path: '/foreign/counter', ops: { $inc: { count: 10 } } },
    { op: 'put', node: { $path: '/local', $type: 't.dir' } },
  ] }).outcome, code('CROSS_DOMAIN'))
  const current = (await f.remote.admin.read({ node: '/counter' })).copies[0]
  assert.ok('node' in current)
  assert.equal(current.node.count, 1)
  await assert.rejects(f.origin.admin.read({ node: '/local' }), code('NOT_FOUND'))
  const history = await f.origin.admin.read({ history: '/foreign/counter' })
  assert.ok(history.history)
  const changed = history.history.find(entry => entry.after?.count === 1)
  assert.ok(changed)
  await f.origin.admin.commit({ opId: f.origin.key(), changes: [{ op: 'remove', path: '/foreign/counter' }] }).outcome
  await f.origin.admin.commit({ opId: f.origin.key(), changes: [{ op: 'restore', record: changed.address }] }).outcome
  const restored = (await f.remote.admin.read({ node: '/counter' })).copies[0]
  assert.ok('node' in restored)
  assert.equal(restored.node.count, 0)
})


it('delivers accepted foreign stream pieces through the native origin lane', async t => {
  const f = await federation(t)
  await f.remote.admin.commit({ opId: f.remote.key(), changes: [{ op: 'put', node: {
    $path: '/counter', $type: 'foreign.counter', count: 0,
  } }] }).outcome
  const original = f.origin.key()
  const pending = f.origin.admin.act({ path: '/foreign/counter', action: 'steps', args: {}, opId: original })
  const chunks: unknown[] = []
  const pieces = (async () => { for await (const data of pending.chunks) chunks.push(data) })()
  const [outcome] = await Promise.all([pending.outcome, pieces])
  assert.deepEqual(chunks, ['first', 'second'])
  assert.equal(outcome.value, 'finished')
  assert.ok(outcome.pos)
  assert.notEqual(outcome.pos.instance, f.origin.id)
  const current = (await f.remote.admin.read({ node: '/counter' })).copies[0]
  assert.ok('node' in current)
  assert.equal(current.node.count, 2)
  const continuation = f.origin.admin.act({ path: '/foreign/counter', action: 'steps', args: {}, opId: f.origin.key(), anchor: original })
  const resumed: unknown[] = []
  const delivering = (async () => { for await (const value of continuation.chunks) resumed.push(value) })()
  await assert.rejects(Promise.all([continuation.outcome, delivering]), code('INVALID'))
  assert.deepEqual(resumed, [])
  const updated = (await f.remote.admin.read({ node: '/counter' })).copies[0]
  assert.ok('node' in updated)
  assert.equal(updated.node.count, 2)
})

it('continues an unfinished foreign stream with its retained original remote anchor', async t => {
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const streaming: ModuleManifest = { ...module, types: module.types.map(type => type.name !== 'foreign.counter' ? type : {
    ...type, actions: { ...type.actions, steps: { kind: 'write', args: {}, handler: async function* (ctx, args) {
      ctx.change.patch('/counter', { $inc: { count: 1 } }); yield 'first'
      if (args !== 'resume') await held
      ctx.change.patch('/counter', { $inc: { count: 1 } }); yield 'second'
      return 'finished'
    } } },
  }) }
  const f = await federation(t, { remoteModules: [streaming] })
  t.after(release)
  await f.remote.admin.commit({ opId: f.remote.key(), changes: [{ op: 'put', node: {
    $path: '/counter', $type: 'foreign.counter', count: 0,
  } }] }).outcome
  const anchor = f.origin.key()
  const original = f.origin.admin.act({ path: '/foreign/counter', action: 'steps', args: 'hold', opId: anchor })
  const pieces = original.chunks[Symbol.asyncIterator]()
  t.after(() => pieces.return?.())
  assert.deepEqual(await pieces.next(), { done: false, value: 'first' })
  const continuation = f.origin.admin.act({ path: '/foreign/counter', action: 'steps', args: 'resume', opId: f.origin.key(), anchor })
  const delivered: unknown[] = []
  const draining = (async () => { for await (const value of continuation.chunks) delivered.push(value) })()
  const [outcome] = await Promise.all([continuation.outcome, draining])
  assert.equal(outcome.value, 'finished')
  assert.deepEqual(delivered, ['first', 'second'])
  const cancelled = assert.rejects(original.outcome, code('CANCELLED'))
  const remoteCancelled = f.waitCancelled()
  f.origin.admin.cancel(original.id)
  await Promise.all([cancelled, remoteCancelled])
  release()
  const current = (await f.remote.admin.read({ node: '/counter' })).copies[0]
  assert.ok('node' in current)
  assert.equal(current.node.count, 3)
})

it('cancels a foreign request blocked in remote admission while preserving unrelated requests', async t => {
  const admitted = new EventEmitter()
  let release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  let first = true
  const f = await federation(t, { remoteGates: [async operation => {
    if (operation.kind === 'act' && operation.action === 'increment' && first) {
      first = false
      admitted.emit('blocked')
      await blocked
    }
    return 'pass'
  }] })
  t.after(release)
  await f.remote.admin.commit({ opId: f.remote.key(), changes: [{ op: 'put', node: {
    $path: '/counter', $type: 'foreign.counter', count: 0,
  } }] }).outcome
  const entered = once(admitted, 'blocked')
  const pending = f.origin.admin.act({ path: '/foreign/counter', action: 'increment', args: {}, opId: f.origin.key() })
  const refused = assert.rejects(pending.outcome, code('CANCELLED'))
  await entered
  const remoteCancelled = f.waitCancelled()
  f.origin.admin.cancel(pending.id)
  await refused
  await remoteCancelled
  release()
  const next = await f.origin.admin.act({ path: '/foreign/counter', action: 'increment', args: {}, opId: f.origin.key() }).outcome
  assert.equal(next.value, 'accepted')
  const current = (await f.remote.admin.read({ node: '/counter' })).copies[0]
  assert.ok('node' in current)
  assert.equal(current.node.count, 1)
})

it('refuses a real read-to-write remote classification race before execution', async t => {
  let remote: Awaited<ReturnType<typeof instance>> | undefined
  const f = await federation(t, { remoteGates: [async operation => {
    if (operation.kind === 'act' && operation.action === 'increment') {
      assert.ok(remote)
      remote.runtime.registry.publish(module)
    }
    return 'pass'
  }] })
  remote = f.remote
  f.remote.runtime.registry.publish({ ...module, types: [{ ...module.types[0], actions: {
    increment: { kind: 'read', args: {}, handler: async () => 'read-only' },
  } }] })
  await f.remote.admin.commit({ opId: f.remote.key(), changes: [{ op: 'put', node: {
    $path: '/counter', $type: 'foreign.counter', count: 0,
  } }] }).outcome
  await assert.rejects(f.caller.act({ path: '/foreign/counter', action: 'increment', args: {}, opId: f.origin.key() }).outcome, code('CONFLICT'))
  const current = (await f.remote.admin.read({ node: '/counter' })).copies[0]
  assert.ok('node' in current)
  assert.equal(current.node.count, 0)
})


it('rechecks the genuine foreign component image across awaited action admission', async t => {
  let remote: Awaited<ReturnType<typeof instance>> | undefined, calls = 0
  const f = await federation(t, { remoteGates: [async operation => {
    if (operation.kind === 'act' && operation.action === 'increment') {
      assert.ok(remote)
      await remote.admin.commit({ opId: remote.key(), changes: [{ op: 'patch', path: '/counter',
        ops: { $set: { '#worker': { $type: 'foreign.replacement', count: 10 } } } }] }).outcome
    }
    return 'pass'
  }] })
  remote = f.remote
  const read = { kind: 'read' as const, args: {}, handler: async () => { calls++; return 'old' } }
  f.remote.runtime.registry.publish({ ...module, types: [
    { ...module.types[0], actions: { increment: read } },
    { ...module.types[0], name: 'foreign.replacement', actions: { increment: read } },
  ] })
  await f.remote.admin.commit({ opId: f.remote.key(), changes: [{ op: 'put', node: {
    $path: '/counter', $type: 't.dir', '#worker': { $type: 'foreign.counter', count: 0 },
  } }] }).outcome
  await assert.rejects(f.caller.act({ path: '/foreign/counter', component: '#worker', action: 'increment', args: {} }).outcome, code('CONFLICT'))
  assert.equal(calls, 0)
  const current = (await f.remote.admin.read({ node: '/counter' })).copies[0]
  assert.ok('node' in current)
  assert.deepEqual(current.node['#worker'], { $type: 'foreign.replacement', $v: 0, count: 10 })
})


it('releases a genuine foreign node subscription after remote deletion', async t => {
  const f = await federation(t)
  await f.remote.admin.commit({ opId: f.remote.key(), changes: [{ op: 'put', node: {
    $path: '/counter', $type: 'foreign.counter', count: 1,
  } }] }).outcome
  const caller = await f.origin.runtime.openSession()
  const frames = caller.lane[Symbol.asyncIterator]()
  t.after(async () => { await frames.return?.() })
  const sub = caller.sub({ node: '/foreign/counter' })
  let id: string | undefined
  while (id === undefined) {
    const next = await frames.next()
    assert.equal(next.done, false)
    const frame = next.value
    if (frame.t === 'end') assert.fail(JSON.stringify(frame))
    if (frame.t !== 'snap' || frame.sub !== sub) continue
    assert.equal(frame.list.length, 1)
    assert.ok(frame.ownership)
    assert.deepEqual(frame.ownership.roots[0].covered, frame.covered)
    const copy = frame.copies[0]
    assert.ok('node' in copy)
    assert.equal(copy.node.$path, '/foreign/counter')
    id = copy.node.$id
  }
  await f.remote.admin.commit({ opId: f.remote.key(), changes: [{ op: 'remove', path: '/counter' }] }).outcome
  let released = false
  while (!released) {
    const next = await frames.next()
    assert.equal(next.done, false)
    const frame = next.value
    if (frame.t === 'end') assert.fail(JSON.stringify(frame))
    if (frame.t !== 'pos') continue
    released = frame.changes.some(change => change.op === 'del' && change.id === id)
  }
  assert.equal(released, true)
  const local = caller.sub({ node: '/foreign' })
  let localReady = false
  while (!localReady) {
    const next = await frames.next()
    assert.equal(next.done, false)
    if (next.value.t === 'end') assert.fail(JSON.stringify(next.value))
    localReady = next.value.t === 'snap' && next.value.sub === local
  }
  await f.origin.admin.commit({ opId: f.origin.key(), changes: [{ op: 'patch', path: '/foreign', ops: { $set: { label: 'still local' } } }] }).outcome
  let originProgress = false
  while (!originProgress) {
    const next = await frames.next()
    assert.equal(next.done, false)
    if (next.value.t === 'end') assert.fail(JSON.stringify(next.value))
    originProgress = next.value.t === 'pos' && next.value.pos.instance === f.origin.id && next.value.coverage !== true
  }
  assert.equal(originProgress, true)
  caller.unsub(local)
  caller.unsub(sub)
})


it('releases precisely the foreign window branch and preserves fixed include ownership', async t => {
  const f = await federation(t)
  await f.remote.admin.commit({ opId: f.remote.key(), changes: [
    { op: 'put', node: { $path: '/items', $type: 't.dir' } },
    { op: 'put', node: { $path: '/shared', $type: 't.dir' } },
    { op: 'put', node: { $path: '/linked-a', $type: 't.dir' } },
    { op: 'put', node: { $path: '/linked-b', $type: 't.dir' } },
    { op: 'put', node: { $path: '/items/a', $type: 'foreign.counter', rank: 1, link: { $ref: '/linked-a' } } },
    { op: 'put', node: { $path: '/items/b', $type: 'foreign.counter', rank: 2, link: { $ref: '/linked-b' } } },
  ] }).outcome
  const caller = await f.origin.runtime.openSession()
  const frames = caller.lane[Symbol.asyncIterator]()
  t.after(async () => { await frames.return?.() })
  const sub = caller.sub({ children: '/foreign/items', sort: [['rank', 1]], window: { limit: 1, evict: true },
    include: [{ ref: 'link' }, { path: '/foreign/shared' }] })
  const initial = new Map<string, string>()
  while (initial.size === 0) {
    const next = await frames.next()
    assert.equal(next.done, false)
    const frame = next.value
    if (frame.t === 'end') assert.fail(JSON.stringify(frame))
    if (frame.t !== 'snap' || frame.sub !== sub) continue
    assert.equal(frame.list.length, 1)
    assert.ok(frame.ownership)
    for (const copy of frame.copies) {
      assert.ok('node' in copy)
      initial.set(copy.node.$path, copy.node.$id)
    }
    assert.deepEqual([...initial.keys()].sort(), ['/foreign/items/a', '/foreign/linked-a', '/foreign/shared'])
    assert.deepEqual(frame.ownership.fixed, [initial.get('/foreign/shared')])
    assert.deepEqual(new Set(frame.ownership.roots[0].covered), new Set([
      initial.get('/foreign/items/a'), initial.get('/foreign/linked-a'),
    ]))
  }
  await f.remote.admin.commit({ opId: f.remote.key(), changes: [{ op: 'patch', path: '/items/b', ops: { $set: { rank: 0 } } }] }).outcome
  const removed = new Set<string>(), added = new Set<string>()
  while (removed.size < 2 || added.size < 2) {
    const next = await frames.next()
    assert.equal(next.done, false)
    const frame = next.value
    if (frame.t === 'end') assert.fail(JSON.stringify(frame))
    if (frame.t === 'result' && frame.sub === sub) {
      assert.ok(frame.ownership)
      assert.deepEqual(frame.ownership.fixed, [initial.get('/foreign/shared')])
      for (const copy of frame.copies) { assert.ok('node' in copy); added.add(copy.node.$path) }
    }
    if (frame.t === 'pos') for (const change of frame.changes) {
      if (change.op === 'del') removed.add(change.id)
      if (change.op === 'put') { assert.ok('node' in change.copy); added.add(change.copy.node.$path) }
    }
  }
  assert.deepEqual(removed, new Set([initial.get('/foreign/items/a'), initial.get('/foreign/linked-a')]))
  assert.deepEqual(added, new Set(['/foreign/items/b', '/foreign/linked-b']))
  assert.equal(removed.has(initial.get('/foreign/shared')!), false)
  await f.remote.admin.commit({ opId: f.remote.key(), changes: [{ op: 'patch', path: '/items/b', ops: { $unset: { link: true } } }] }).outcome
  let ownershipChanged = false, referenceReleased = false
  while (!ownershipChanged || !referenceReleased) {
    const next = await frames.next()
    assert.equal(next.done, false)
    const frame = next.value
    if (frame.t === 'end') assert.fail(JSON.stringify(frame))
    if (frame.t === 'result' && frame.sub === sub) {
      assert.ok(frame.ownership)
      assert.equal(frame.ownership.roots.length, 1)
      assert.deepEqual(frame.ownership.roots[0].covered, [frame.ownership.roots[0].id])
      assert.deepEqual(frame.ownership.fixed, [initial.get('/foreign/shared')])
      ownershipChanged = true
    }
    if (frame.t === 'pos') for (const change of frame.changes) {
      if (change.op === 'del') {
        assert.notEqual(change.id, initial.get('/foreign/shared'))
        referenceReleased = true
      }
    }
  }
  assert.equal(ownershipChanged && referenceReleased, true)
  caller.unsub(sub)
})


it('evaluates foreign subscription predicates and pagination on origin-visible identities and references', async t => {
  const f = await federation(t)
  await f.remote.admin.commit({ opId: f.remote.key(), changes: [
    { op: 'put', node: { $path: '/items', $type: 't.dir' } },
    { op: 'put', node: { $path: '/linked', $type: 't.dir' } },
    { op: 'put', node: { $path: '/items/a', $type: 'foreign.counter', link: { $ref: '/linked' } } },
    { op: 'put', node: { $path: '/items/b', $type: 'foreign.counter', link: { $ref: '/linked' } } },
  ] }).outcome
  const all = await f.caller.read({ children: '/foreign/items', sort: [['$id', 1]] })
  assert.equal(all.list.length, 2)
  const query = { children: '/foreign/items', sort: [['$id', 1] as const],
    where: { $id: { $ne: all.list[0] }, 'link.$ref': { $in: ['/foreign/linked'] } },
    include: [{ ref: 'link' }] }
  const selected = await f.caller.read(query)
  assert.deepEqual(selected.list, [all.list[1]])
  assert.equal(selected.copies.length, 2)
  const first = await f.caller.read({ children: '/foreign/items', sort: [['$id', 1]], window: { limit: 1 } })
  assert.deepEqual(first.list, [all.list[0]])
  assert.ok(first.next)
  const second = await f.caller.read({ children: '/foreign/items', sort: [['$id', 1]], window: { limit: 1, after: first.next } })
  assert.deepEqual(second.list, [all.list[1]])
  const caller = await f.origin.runtime.openSession()
  const frames = caller.lane[Symbol.asyncIterator]()
  t.after(() => frames.return?.())
  const sub = caller.sub(query)
  for (;;) {
    const next = await frames.next()
    assert.equal(next.done, false)
    const frame = next.value
    if (frame.t === 'end') assert.fail(JSON.stringify(frame))
    if (frame.t !== 'snap' || frame.sub !== sub) continue
    assert.deepEqual(frame.list, [all.list[1]])
    assert.equal(frame.copies.length, 2)
    caller.unsub(sub)
    break
  }
})

it('keeps foreign quarantine subscription identity while evaluating its projected stored query fields', { timeout: 10000 }, async t => {
  const f = await federation(t)
  await f.remote.admin.commit({ opId: f.remote.key(), changes: [
    { op: 'put', node: { $path: '/items', $type: 't.dir' } },
    { op: 'put', node: { $path: '/linked', $type: 't.dir' } },
    { op: 'put', node: { $path: '/shared', $type: 't.dir' } },
    { op: 'put', node: { $path: '/items/a', $type: 'foreign.counter', count: 'bad', rank: 9, link: { $ref: '/linked' } } },
    { op: 'put', node: { $path: '/items/b', $type: 'foreign.counter', count: 'bad', rank: 1, link: { $ref: '/linked' } } },
  ] }).outcome
  f.remote.runtime.registry.publish({ ...module, types: [{ ...module.types[0], schema: {
    properties: { count: { type: 'number' } }, required: ['count'],
  } }, module.types[1]] })
  const canonical = await f.remote.admin.read({ children: '/items', where: { count: 'bad' }, sort: [['rank', 1]] })
  assert.equal(canonical.list.length, 2)
  assert.equal(canonical.copies.every(copy => 'error' in copy), true)
  assert.deepEqual(canonical.copies.map(copy => 'node' in copy ? undefined : copy.sort?.rank), [1, 9])
  const identities = await f.caller.read({ children: '/foreign/items', sort: [['rank', 1]] })
  assert.equal(identities.list.length, 2)
  const query = { children: '/foreign/items', where: { count: 'bad',
    $id: { $ne: identities.list[1] }, $path: { $gt: '/foreign/items' }, 'link.$ref': '/foreign/linked' },
    sort: [['rank', 1] as const], window: { limit: 1 }, include: [{ ref: 'link' }, { path: '/foreign/shared' }] }
  const selected = await f.caller.read(query)
  assert.deepEqual(selected.list, [identities.list[0]])
  assert.equal(selected.copies.length, 3)
  const quarantined = selected.copies.find(copy => 'error' in copy)
  assert.ok(quarantined && 'error' in quarantined)
  assert.equal(quarantined.error.code, 'INVALID')
  assert.deepEqual(quarantined.query?.link, { $ref: '/foreign/linked' })
  assert.ok(selected.ownership)
  assert.equal(selected.ownership.fixed.length, 1)
  assert.equal(selected.ownership.roots[0].covered.length, 2)
  const caller = await f.origin.runtime.openSession()
  const frames = caller.lane[Symbol.asyncIterator]()
  t.after(async () => { await frames.return?.() })
  const first = caller.sub(query)
  const second = caller.sub({ children: '/foreign/items', where: { rank: { $gt: 5 } }, sort: [['$path', 1]] })
  const snapshots = new Set<string>()
  while (snapshots.size !== 2) {
    const next = await frames.next()
    assert.equal(next.done, false)
    const frame = next.value
    if (frame.t === 'end') assert.fail(JSON.stringify(frame))
    if (frame.t !== 'snap') continue
    if (frame.sub === first) {
      assert.deepEqual(frame.list, [identities.list[0]])
      assert.equal(frame.covered?.length, 3)
      assert.deepEqual(frame.ownership?.roots[0].query?.link, { $ref: '/foreign/linked' })
    } else {
      assert.equal(frame.sub, second)
      assert.deepEqual(frame.list, [identities.list[1]])
      assert.equal(frame.ownership?.roots[0].query?.rank, 9)
    }
    snapshots.add(frame.sub)
  }
  caller.unsub(first)
  caller.unsub(second)
  await f.origin.admin.commit({ opId: f.origin.key(), changes: [{ op: 'patch', path: '/sys/limits',
    ops: { $set: { exprWork: 16 } },
  }] }).outcome
  await assert.rejects(f.caller.read(query), code('BUDGET'))
})

it('ends both captured foreign subscriptions on secret rights changes without reviving old generations', async t => {
  const f = await federation(t)
  await f.remote.admin.commit({ opId: f.remote.key(), changes: [{ op: 'put', node: {
    $path: '/counter', $type: 'foreign.counter', count: 1,
  } }] }).outcome
  const callers = await Promise.all([f.origin.runtime.openSession(), f.origin.runtime.openSession()])
  const frames = callers.map(caller => caller.lane[Symbol.asyncIterator]())
  t.after(async () => { await Promise.all(frames.map(iterator => iterator.return?.())) })
  const subs = callers.map(caller => caller.sub({ node: '/foreign/counter' }))
  await Promise.all(frames.map(async (iterator, index) => {
    for (;;) {
      const next = await iterator.next()
      assert.equal(next.done, false)
      if (next.value.t === 'snap' && next.value.sub === subs[index]) break
      if (next.value.t === 'end') assert.fail(JSON.stringify(next.value))
    }
  }))
  const closed = f.waitClosed(2)
  await f.origin.admin.commit({ opId: f.origin.key(), changes: [{ op: 'patch', path: '/secret',
    ops: { $set: { $acl: [{ subject: { owner: true }, grant: R }, { subject: { group: 'public' }, deny: R }] } },
  }] }).outcome
  await closed
  assert.equal((await f.caller.read({ node: '/foreign/counter' })).copies.length, 1)
  await Promise.all(frames.map(async (iterator, index) => {
    for (;;) {
      const next = await iterator.next()
      assert.equal(next.done, false)
      if (next.value.t !== 'end' || next.value.sub !== subs[index]) continue
      assert.equal(next.value.error.code, 'CANCELLED')
      break
    }
  }))
  assert.equal(f.credentialCalls().opens, 3)
})

it('replaces an actual foreign subscription generation when its declaring component changes', async t => {
  const f = await federation(t)
  await f.remote.admin.commit({ opId: f.remote.key(), changes: [{ op: 'put', node: {
    $path: '/counter', $type: 'foreign.counter', count: 1,
  } }] }).outcome
  const caller = await f.origin.runtime.openSession()
  const iterator = caller.lane[Symbol.asyncIterator]()
  t.after(() => iterator.return?.())
  const sub = caller.sub({ node: '/foreign/counter' })
  let initial = 0
  for (;;) {
    const next = await iterator.next()
    assert.equal(next.done, false)
    if (next.value.t === 'end') assert.fail(JSON.stringify(next.value))
    if (next.value.t !== 'snap' || next.value.sub !== sub) continue
    initial = next.value.gen
    break
  }
  const declaration = (await f.origin.admin.read({ node: '/foreign' })).copies[0]
  assert.ok('node' in declaration)
  const component = declaration.node['#remote']
  assert.ok(typeof component === 'object' && component !== null && !Array.isArray(component))
  await f.origin.admin.commit({ opId: f.origin.key(), changes: [{ op: 'patch', path: '/foreign',
    ops: { $set: { '#remote': { ...component, remote: '/' } } },
  }] }).outcome
  let reset = false
  for (;;) {
    const next = await iterator.next()
    assert.equal(next.done, false)
    if (next.value.t === 'end') assert.fail(JSON.stringify(next.value))
    if (next.value.t === 'reset' && next.value.sub === sub) {
      assert.ok(next.value.gen > initial)
      reset = true
    }
    if (next.value.t !== 'snap' || next.value.sub !== sub) continue
    assert.equal(reset, true)
    assert.ok(next.value.gen > initial)
    assert.equal(next.value.copies.length, 1)
    break
  }
  caller.unsub(sub)
})

it('owns foreign subscription and replay positions independently through both actual HTTP lanes', async t => {
  const f = await federation(t)
  await f.remote.admin.commit({ opId: f.remote.key(), changes: [{ op: 'put', node: {
    $path: '/counter', $type: 'foreign.counter', count: 0,
  } }] }).outcome
  const http = createTwpHttpServer({ instance: f.origin.runtime, allowedOrigins: [], credentialTtlMs: 60_000 })
  t.after(() => http.close())
  http.server.listen(0, '127.0.0.1')
  await once(http.server, 'listening')
  const address = http.server.address()
  assert.ok(address !== null && typeof address === 'object')
  assert.ok(f.origin.runtime.setupCredential)
  const connection = await openTwpHttp({ url: `http://127.0.0.1:${address.port}`,
    credential: f.origin.runtime.setupCredential, frameBytes: DEFAULT_LIMITS.readBytes })
  t.after(() => connection.close())
  const progress: { readonly pos: Position; readonly request: boolean }[] = []
  const client = createTwpClient({ send: request => connection.send(request), frames: { async *[Symbol.asyncIterator]() {
    for await (const frame of connection.frames) {
      if (frame.t === 'pos' && frame.coverage !== true && frame.producer !== undefined)
        progress.push({ pos: frame.pos, request: 'req' in frame.producer })
      yield frame
    }
  } } }, { credential: f.origin.runtime.setupCredential })
  t.after(() => client.close())
  await client.ready
  const changed = new EventEmitter()
  const sub = client.sub({ node: '/foreign/counter' }, () => changed.emit('changed'))
  await sub.ready
  const request = { path: '/foreign/counter', action: 'increment', args: {}, opId: client.key() }
  const accepted = await client.act(request).outcome
  assert.ok(accepted.pos)
  function currentCount(): unknown {
    const copy = client.cache.at('/foreign/counter')
    if (copy === undefined) return undefined
    assert.ok('node' in copy)
    return copy.node.count
  }
  while (currentCount() !== 1) {
    await once(changed, 'changed')
    assert.equal(client.failure(), undefined)
  }
  assert.notEqual(accepted.pos.instance, f.origin.id)
  assert.ok(client.cache.watermark(accepted.pos.instance))
  const before = progress.length
  assert.deepEqual(await client.act(request).outcome, accepted)
  assert.equal(progress.length, before)
  sub.close()
  assert.equal(client.cache.watermark(accepted.pos.instance), undefined)
  assert.deepEqual(await client.act(request).outcome, accepted)
  assert.equal(progress.length, before + 1)
  assert.equal(progress.at(-1)?.request, true)
  assert.equal(client.cache.watermark(accepted.pos.instance), undefined)
  const replacement = client.sub({ node: '/foreign/counter' }, () => changed.emit('changed'))
  await replacement.ready
  assert.ok(client.cache.watermark(accepted.pos.instance))
  replacement.close()
  assert.equal(client.cache.watermark(accepted.pos.instance), undefined)
  const origin = await client.commit({ opId: client.key(), changes: [{ op: 'put', node: {
    $path: '/local', $type: 't.dir',
  } }] }).outcome
  assert.equal(origin.pos?.instance, f.origin.id)
  assert.ok(client.cache.watermark(f.origin.id))
  assert.equal(client.failure(), undefined)
})

it('maps a genuine foreign node-executor View and its subscription provenance', async t => {
  const views: ModuleManifest = { id: 'foreign-views', open: [], types: [{ name: 'foreign.view', module: 'foreign-views',
    version: 0, security: 'privileged-capability', schema: {}, actions: {} }], security: [{ type: 'foreign.view', context: 'mount',
    async handler() { return { kind: 'view', executor: 'node', async derive(_view, _request, read) {
      const result = await read.read({ node: '/counter' })
      assert.equal(result.copies.length, 1)
      return { members: ['/counter'], rows: [{ key: 'count', link: { $type: 'ref', $ref: '/counter' } }] }
    }, async close() {} } } }] }
  const f = await federation(t, { remoteModules: [module, views] })
  await f.remote.admin.commit({ opId: f.remote.key(), changes: [
    { op: 'put', node: { $path: '/counter', $type: 'foreign.counter', count: 1,
      link: { $type: 'ref', $ref: '/counter' } } },
    { op: 'put', node: { $path: '/view', $type: 't.dir', '#view': { $type: 'foreign.view', pattern: '' } } },
  ] }).outcome
  const declaration = (await f.remote.admin.read({ node: '/view' })).copies[0]
  assert.ok('node' in declaration)
  await f.remote.admin.commit({ opId: f.remote.key(), expect: { nodes: [{ path: '/view', rev: declaration.node.$rev }] }, changes: [{ op: 'patch', path: '/counter',
    ops: { $set: { $acl: [{ subject: { group: `n:${declaration.node.$id}` }, grant: R }] } },
  }] }).outcome
  const value = await f.caller.read({ children: '/foreign/view' })
  assert.equal(value.computed?.length, 1)
  assert.deepEqual(value.computed[0].link, { $type: 'ref', $ref: '/foreign/counter' })
  assert.deepEqual(value.rows, [{ key: 'count', link: { $type: 'ref', $ref: '/foreign/counter' } }])
  const caller = await f.origin.runtime.openSession()
  const iterator = caller.lane[Symbol.asyncIterator]()
  t.after(() => iterator.return?.())
  const sub = caller.sub({ children: '/foreign/view' })
  for (;;) {
    const next = await iterator.next()
    assert.equal(next.done, false)
    if (next.value.t === 'end') assert.fail(JSON.stringify(next.value))
    if (next.value.t !== 'snap' || next.value.sub !== sub) continue
    assert.deepEqual(next.value.viewOwner, { path: '/foreign/view', component: '#view' })
    assert.equal(next.value.computed?.length, 1, JSON.stringify(next.value))
    assert.deepEqual(next.value.computed?.[0].link, { $type: 'ref', $ref: '/foreign/counter' })
    assert.equal(next.value.ownership?.roots.length, 1)
    break
  }
  await f.remote.admin.commit({ opId: f.remote.key(), changes: [{ op: 'patch', path: '/counter', ops: { $set: { count: 2 } } }] }).outcome
  for (;;) {
    const next = await iterator.next()
    assert.equal(next.done, false)
    if (next.value.t === 'end') assert.fail(JSON.stringify(next.value))
    if (next.value.t !== 'result' || next.value.sub !== sub) continue
    assert.equal(next.value.computed?.length, 1)
    assert.equal(next.value.computed[0].count, 2)
    assert.deepEqual(next.value.computed[0].link, { $type: 'ref', $ref: '/foreign/counter' })
    assert.deepEqual(next.value.viewOwner, { path: '/foreign/view', component: '#view' })
    break
  }
  caller.unsub(sub)
})

it('rejects unsolicited foreign copies before retaining them in the native cache', async t => {
  const f = await federation(t, { unsolicitedCopies: true })
  await f.remote.admin.commit({ opId: f.remote.key(), changes: [{ op: 'put', node: {
    $path: '/counter', $type: 'foreign.counter', count: 1,
  } }] }).outcome
  await assert.rejects(f.caller.read({ node: '/foreign/counter' }), code('INVALID'))
  await f.waitClosed(1)
  assert.equal(f.credentialCalls().opens, 1)
})


it('dispatches nested foreign actions by owned type and refuses changed-selector replay', { timeout: 15_000 }, async t => {
  let targetType = 'foreign.counter', writes = 0, gates = 0;
  const remoteModule: ModuleManifest = { ...module, types: [{ ...module.types[0], actions: {
    increment: { kind: 'write', args: {}, handler: async function(this: { count: number }) { writes++; this.count++; return 'accepted' } },
  } }, module.types[1]] };
  const localModule: ModuleManifest = { id: 'nested-dispatch', security: [], open: [], types: [{ name: 'nested.dispatch',
    module: 'nested-dispatch', security: 'ordinary', version: 0, schema: {}, actions: {
      dispatch: { kind: 'write', args: {}, handler: async ctx => {
        assert.equal(await ctx.act({ path: '/foreign/counter', targetType, action: 'increment', args: {}, key: 'child' }), 'accepted');
        throw new KernelError('INVALID', 'Outer action is unfinished');
      } },
    } }] };
  const f = await federation(t, { remoteModules: [remoteModule], originModules: [localModule], loseOutcome: true, originGate: async operation => {
    if (operation.kind === 'act' && operation.path === '/foreign/counter') { gates++; assert.equal(operation.component, '#counter'); }
    return 'pass';
  } });
  await f.remote.admin.commit({ opId: f.remote.key(), changes: [{ op: 'put', node: { $path: '/counter', $type: 't.dir',
    '#counter': { $type: 'foreign.counter', count: 1 } } }] }).outcome;
  await f.origin.admin.commit({ opId: f.origin.key(), changes: [{ op: 'put', node: { $path: '/dispatch', $type: 'nested.dispatch' } }] }).outcome;
  const request = { path: '/dispatch', action: 'dispatch', args: {}, opId: f.origin.key() };
  await assert.rejects(f.origin.admin.act(request).outcome, code('UNAVAILABLE'));
  const copy = (await f.remote.admin.read({ node: '/counter' })).copies[0];
  assert.ok('node' in copy);
  assert.deepEqual(copy.node['#counter'], { $type: 'foreign.counter', $v: 0, count: 2 });
  await f.remote.admin.commit({ opId: f.remote.key(), changes: [{ op: 'remove', path: '/counter' }] }).outcome;
  await assert.rejects(f.origin.admin.act(request).outcome, code('INVALID'));
  targetType = 'foreign.replacement';
  await assert.rejects(f.origin.admin.act(request).outcome, code('KEY_REUSED'));
  assert.equal(writes, 1);
  assert.equal(gates, 1);
});
