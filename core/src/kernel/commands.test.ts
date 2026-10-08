import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { KernelError } from '#errors'
import { credentialPath } from '#kernel/auth/crypto'
import { createInstanceFoundation } from '#kernel/instance'
import { scanBudget } from '#kernel/store/contract'
import { createMemoryStore } from '#kernel/store/memory'
import { A, R, W, type Gate, type OpId, type Position } from '#kernel/types'

const code = (expected: KernelError['code']) => (error: unknown) => error instanceof KernelError && error.code === expected
async function setup(gates: readonly Gate[] = []) {
  const root = createMemoryStore({ domain: 'commands' })
  let saved: Position | undefined
  const instance = await createInstanceFoundation({ id: 'commands', root, writerEpoch: 1,
    domains: [{ store: root, epoch: 'commands1', persistent: true }],
    counter: { async load() { return saved }, async save(pos) { saved = pos }, async freshEpoch(floor) { return floor + 1 } },
    firstAdmin: { path: '/admin', name: 'admin', password: 'commands-password' }, initialCredential: { ttlMs: 60_000 }, gates })
  assert.ok(instance.setupCredential)
  const admission = await instance.auth.openCredential(instance.setupCredential)
  const commands = instance.commands(admission)
  let nonce = 0
  const key = (): OpId => ({ epoch: instance.writer.intake.epoch, time: Date.now(), nonce: String(++nonce) })
  return { instance, commands, key, root }
}

describe('authenticated native commands', { timeout: 10_000 }, () => {
  it('commits as the authenticated actor and reads the accepted native projection', async () => {
    const { instance, commands, key, root } = await setup()
    const outcome = await commands.commit({ opId: key(), changes: [{ op: 'put', node: { $path: '/work', $type: 't.dir', name: 'work' } }] })
    const result = await commands.read({ node: '/work' })
    assert.equal(result.list.length, 1)
    const copy = result.copies[0]
    assert.ok('node' in copy)
    assert.equal(copy.node.name, 'work')
    assert.deepEqual(result.at, [outcome.pos])
    const records = (await root.scan({ range: { journal: '/' }, budget: scanBudget() })).items
    const record = records.find(row => row.decision?.opId.nonce === '1')
    assert.ok(record)
    assert.equal(record.executor, commands.actor.principal)
    assert.equal(record.caller, commands.actor.principal)
    assert.deepEqual(record.decision?.outcome, outcome)
    assert.equal(instance.writer.cache.getAt(root, '/work')?.node?.name, 'work')
    commands.close()
  })

  it('replays a canonical outcome without gates or a second write and rejects changed requests', async () => {
    let calls = 0
    const { commands, key, root } = await setup([async () => { calls++; return 'pass' }])
    const request = { opId: key(), changes: [{ op: 'put' as const, node: { $path: '/once', $type: 't.dir' } }] }
    const first = await commands.commit(request), second = await commands.commit(request)
    assert.deepEqual(second, first)
    assert.equal(calls, 1)
    await assert.rejects(commands.commit({ ...request, changes: [{ op: 'put', node: { $path: '/other', $type: 't.dir' } }] }), code('KEY_REUSED'))
    assert.equal(calls, 1)
    const records = (await root.scan({ range: { journal: '/' }, budget: scanBudget() })).items
    assert.equal(records.filter(row => row.entries.some(entry => entry.path === '/once')).length, 1)
    commands.close()
  })

  it('refuses until a gate passes, then accepts retry with the same key', async () => {
    let approved = false
    const { commands, key } = await setup([async () => approved ? 'pass' : { refuse: 'REFUSED' }])
    const request = { opId: key(), changes: [{ op: 'put' as const, node: { $path: '/approved', $type: 't.dir' } }] }
    await assert.rejects(commands.commit(request), code('REFUSED'))
    approved = true
    assert.ok((await commands.commit(request)).pos)
    commands.close()
  })

  it('maps a throwing gate to refusal and stops subsequent gates', async () => {
    let second = 0
    const { commands, key } = await setup([async () => { throw new KernelError('CONFLICT', 'Gate failure') },
      async () => { second++; return 'pass' }])
    await assert.rejects(commands.commit({ opId: key(), changes: [] }), code('REFUSED'))
    assert.equal(second, 0)
    commands.close()
  })

  it('owns changes before waiting for a gate', async () => {
    let entered: () => void = () => {}, release: () => void = () => {}
    const ready = new Promise<void>(resolve => { entered = resolve })
    const waiting = new Promise<void>(resolve => { release = resolve })
    const { commands, key, instance } = await setup([async () => { entered(); await waiting; return 'pass' }])
    const node = { $path: '/owned', $type: 't.dir', name: 'initial' }
    const pending = commands.commit({ opId: key(), changes: [{ op: 'put', node }] })
    await ready
    node.$path = '/changed'; node.name = 'changed'
    release()
    assert.ok((await pending).pos)
    assert.equal((await instance.source.node('/owned'))?.name, 'initial')
    assert.equal(await instance.source.node('/changed'), null)
    commands.close()
  })

  it('ends a pending gate immediately when its admission closes', async () => {
    let entered: () => void = () => {}
    const ready = new Promise<void>(resolve => { entered = resolve })
    const { commands, key } = await setup([async () => { entered(); return new Promise<'pass'>(() => {}) }])
    const pending = commands.commit({ opId: key(), changes: [] })
    await ready
    const ended = assert.rejects(pending, code('CANCELLED'))
    commands.close()
    await ended
    assert.equal(commands.signal.aborted, true)
  })

  it('cancels only the waiting request and leaves its session usable', async () => {
    let entered: () => void = () => {}, waiting = true
    const ready = new Promise<void>(resolve => { entered = resolve })
    const { commands, key, instance } = await setup([async () => {
      if (!waiting) return 'pass'
      entered()
      return new Promise<'pass'>(() => {})
    }])
    const cancellation = new AbortController()
    const pending = commands.commit({ opId: key(), changes: [{ op: 'put', node: { $path: '/cancelled', $type: 't.dir' } }] }, cancellation.signal)
    const ended = assert.rejects(pending, code('CANCELLED'))
    await ready
    cancellation.abort()
    await ended
    assert.equal(commands.signal.aborted, false)
    assert.equal(await instance.source.node('/cancelled'), null)
    waiting = false
    assert.ok((await commands.commit({ opId: key(), changes: [{ op: 'put', node: { $path: '/next', $type: 't.dir' } }] })).pos)
    assert.equal((await commands.read({ node: '/next' })).list.length, 1)
    commands.close()
  })

  it('refuses a cancelled read before gates without closing its session', async () => {
    let judged = 0
    const { commands } = await setup([async () => { judged++; return 'pass' }])
    const cancellation = new AbortController()
    cancellation.abort()
    await assert.rejects(commands.read({ node: '/' }, cancellation.signal), code('CANCELLED'))
    assert.equal(judged, 0)
    assert.equal(commands.signal.aborted, false)
    assert.equal((await commands.read({ node: '/' })).list.length, 1)
    commands.close()
  })

  it('bounds a gate by the operation deadline without waiting for its promise', async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 })
    let entered: () => void = () => {}
    const ready = new Promise<void>(resolve => { entered = resolve })
    const { commands, key, instance } = await setup([async () => { entered(); return new Promise<'pass'>(() => {}) }])
    t.after(() => commands.close())
    const pending = commands.commit({ opId: key(), changes: [] })
    const ended = assert.rejects(pending, code('BUDGET'))
    await ready
    t.mock.timers.tick(instance.limits().queryMs + 1)
    await ended
    assert.equal(commands.signal.aborted, false)
  })

  it('denies an anonymous writer and leaves no partial nodes', async () => {
    const { instance, commands, key } = await setup()
    const anonymous = instance.commands(await instance.auth.openCredential())
    await assert.rejects(anonymous.commit({ opId: key(), changes: [{ op: 'put', node: { $path: '/denied', $type: 't.dir' } }] }), code('FORBIDDEN'))
    assert.equal(await instance.source.node('/denied'), null)
    anonymous.close(); commands.close()
  })

  it('checks node revisions inside the actual writer span', async () => {
    const { instance, commands, key } = await setup()
    await commands.commit({ opId: key(), changes: [{ op: 'put', node: { $path: '/versioned', $type: 't.dir', name: 'old' } }] })
    const result = await commands.read({ node: '/versioned' }), copy = result.copies[0]
    assert.ok('node' in copy)
    await commands.commit({ opId: key(), changes: [{ op: 'patch', path: '/versioned', ops: { $set: { name: 'new' } } }] })
    await assert.rejects(commands.commit({ opId: key(), expect: { nodes: [{ path: '/versioned', rev: copy.node.$rev }] },
      changes: [{ op: 'put', node: { $path: '/stale', $type: 't.dir' } }] }), code('CONFLICT'))
    assert.equal(await instance.source.node('/stale'), null)
    commands.close()
  })

  it('judges every change by the rights before the whole atomic change set', async () => {
    const { instance, commands, key } = await setup()
    await commands.commit({ opId: key(), changes: [{ op: 'put', node: { $path: '/shared', $type: 't.dir',
      $acl: [{ subject: { group: 'public' }, grant: R | W }] } }] })
    const anon = instance.commands(await instance.auth.openCredential())
    await assert.rejects(anon.commit({ opId: key(), changes: [
      { op: 'patch', path: '/shared', ops: { $set: { $acl: [{ subject: { group: 'public' }, grant: R | W | A }] } } },
      { op: 'put', node: { $path: '/shared/child', $type: 't.dir' } } ] }), code('FORBIDDEN'))
    assert.equal(await instance.source.node('/shared/child'), null)
    anon.close(); commands.close()
  })

  it('invalidates an idle command handle before publishing credential revocation', async () => {
    const { instance, commands, key } = await setup()
    const token = instance.setupCredential
    assert.ok(token)
    await commands.commit({ opId: key(), changes: [{ op: 'patch', path: credentialPath(token.token), ops: { $set: { revoked: true } } }] })
    assert.equal(commands.signal.aborted, true)
    await assert.rejects(commands.read({ node: '/' }), code('UNAUTHENTICATED'))
    await assert.rejects(commands.commit({ opId: key(), changes: [] }), code('UNAUTHENTICATED'))
  })

  it('rejects caller supplied identity and more than one hundred transitions atomically', async () => {
    const { instance, commands, key } = await setup()
    const foreign = JSON.parse('{"$path":"/foreign","$type":"t.dir","$id":"caller"}')
    await assert.rejects(commands.commit({ opId: key(), changes: [{ op: 'put', node: foreign }] }), code('INVALID'))
    await assert.rejects(commands.commit({ opId: key(), changes: Array.from({ length: 101 }, (_, index) =>
      ({ op: 'put', node: { $path: `/large${index}`, $type: 't.dir' } })) }), code('BUDGET'))
    assert.equal(await instance.source.node('/large0'), null)
    commands.close()
  })

  it('rejects absent mutation identity and oversized requests before gates', async () => {
    let calls = 0
    const { commands, key } = await setup([async () => { calls++; return 'pass' }])
    await assert.rejects(commands.commit(JSON.parse('{"changes":[]}')), code('INVALID'))
    await assert.rejects(commands.commit({ opId: key(), changes: [{ op: 'put', node: { $path: '/huge', $type: 't.dir',
      name: 'x'.repeat(600_000) } }] }), code('BUDGET'))
    assert.equal(calls, 0)
    commands.close()
  })
})
