import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { KernelError } from '#errors'
import { prepareCredential } from '#kernel/auth/credentials'
import { credentialPath } from '#kernel/auth/crypto'
import { createInstanceFoundation } from '#kernel/instance'
import { scanBudget } from '#kernel/store/contract'
import { createMemoryStore } from '#kernel/store/memory'
import type { Budget, CommitRequest, Gate, ModuleManifest, OpId, Position, RightsRule } from '#kernel/types'

const code = (expected: KernelError['code']) => (error: unknown) => error instanceof KernelError && error.code === expected
function signal() {
  let resolve: () => void = () => {}
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
async function setup(gates: readonly Gate[] = []) {
  const root = createMemoryStore({ domain: 'commands-review' })
  let saved: Position | undefined, allowance: Budget | undefined
  const options = { id: 'commands-review', root, writerEpoch: 1,
    domains: [{ store: root, epoch: 'review1', persistent: true }],
    counter: { async load() { return saved }, async save(pos: Position) { saved = { ...pos } }, async freshEpoch(floor: number) { return floor + 1 } },
    initialCredential: { ttlMs: 60_000 }, gates, budget: () => allowance ?? scanBudget() }
  const instance = await createInstanceFoundation({ ...options,
    firstAdmin: { path: '/admin', name: 'admin', password: 'review-password' } })
  const credential = instance.setupCredential
  assert.ok(credential)
  const commands = instance.commands(await instance.auth.openCredential(credential))
  let nonce = 0
  const key = (): OpId => ({ epoch: instance.writer.intake.epoch, time: Date.now(), nonce: String(++nonce) })
  await commands.commit({ opId: key(), changes: ['/work', '/other'].map($path => ({ op: 'put', node: { $path, $type: 't.dir' } })) })
  async function scoped(scope: readonly string[]) {
    const prepared = prepareCredential(instance.bootstrap.adminId, { expiresAt: Date.now() + 60_000, scope })
    await commands.commit({ opId: key(), changes: [{ op: 'put', node: prepared.node }] })
    const admission = await instance.auth.openCredential(prepared.credential)
    return { credential: prepared.credential, admission, commands: instance.commands(admission) }
  }
  return { root, instance, options, commands, credential, key, scoped,
    budget(value?: Budget) { allowance = value } }
}

describe('authenticated command boundary regressions', { timeout: 10_000 }, () => {
  it('rejects an executed key under narrower claims without releasing its outcome or writing again', async t => {
    const fixture = await setup()
    t.after(() => fixture.instance.auth.close())
    const narrow = await fixture.scoped(['/work'])
    const request: CommitRequest = { opId: fixture.key(), changes: [{ op: 'patch', path: '/work', ops: { $inc: { count: 1 } } }] }
    const first = await fixture.commands.commit(request)
    await assert.rejects(narrow.commands.commit(request), code('KEY_REUSED'))
    assert.deepEqual(await fixture.commands.commit(request), first)
    assert.equal((await fixture.instance.source.node('/work'))?.count, 1)
  })

  it('replays once across distinct credentials with equivalent canonical scopes', async t => {
    let calls = 0
    const fixture = await setup([async operation => {
      if (operation.kind === 'commit' && operation.changes.some(change => change.op === 'patch' && change.path === '/work')) calls++
      return 'pass'
    }])
    t.after(() => fixture.instance.auth.close())
    const first = await fixture.scoped(['/other', '/work', '/work']), second = await fixture.scoped(['/work', '/other'])
    const request: CommitRequest = { opId: fixture.key(), changes: [{ op: 'patch', path: '/work', ops: { $inc: { count: 1 } } }] }
    const outcome = await first.commands.commit(request)
    assert.deepEqual(await second.commands.commit(request), outcome)
    assert.equal(calls, 1)
    assert.equal((await fixture.instance.source.node('/work'))?.count, 1)
  })

  it('owns the mutation key, preconditions and changes before waiting for a writer', async t => {
    const fixture = await setup(), entered = signal(), release = signal()
    t.after(() => { release.resolve(); fixture.instance.auth.close() })
    const blocker = fixture.instance.writer.commit(fixture.root, [], async pos => {
      entered.resolve(); await release.promise
      return { writes: [], record: { pos, kind: 'kernel', executor: 'kernel', caller: 'kernel', entries: [] } }
    })
    await entered.promise
    const opId = { ...fixture.key() }, originalKey = { ...opId }, absent = ['/work/owned']
    const node = { $path: '/work/owned', $type: 't.dir', name: 'original' }
    const pending = fixture.commands.commit({ opId, expect: { absent }, changes: [{ op: 'put', node }] })
    opId.nonce = 'changed'; absent[0] = '/work'; node.$path = '/other/mutated'; node.name = 'mutated'
    release.resolve(); await blocker
    const outcome = await pending
    assert.equal((await fixture.instance.source.node('/work/owned'))?.name, 'original')
    assert.equal(await fixture.instance.source.node('/other/mutated'), null)
    assert.deepEqual(await fixture.commands.commit({ opId: originalKey, expect: { absent: ['/work/owned'] },
      changes: [{ op: 'put', node: { $path: '/work/owned', $type: 't.dir', name: 'original' } }] }), outcome)
  })

  it('denies a credential revoked while its gate is waiting before applying any transition', async t => {
    const entered = signal(), release = signal()
    const fixture = await setup([async operation => {
      if (operation.kind === 'commit' && operation.changes.some(change => change.op === 'put' && change.node.$path === '/work/late')) {
        entered.resolve(); await release.promise
      }
      return 'pass'
    }])
    t.after(() => { release.resolve(); fixture.instance.auth.close() })
    const narrow = await fixture.scoped(['/work'])
    const pending = narrow.commands.commit({ opId: fixture.key(), changes: [{ op: 'put', node: { $path: '/work/late', $type: 't.dir' } }] })
    await entered.promise
    await fixture.commands.commit({ opId: fixture.key(), changes: [{ op: 'patch', path: credentialPath(narrow.credential.token), ops: { $set: { revoked: true } } }] })
    assert.equal(narrow.admission.signal.aborted, true)
    release.resolve()
    await assert.rejects(pending, code('UNAUTHENTICATED'))
    assert.equal(await fixture.instance.source.node('/work/late'), null)
  })

  it('denies a scope crossing atomically even when the same principal holds the admin claim', async t => {
    const fixture = await setup()
    t.after(() => fixture.instance.auth.close())
    const narrow = await fixture.scoped(['/work'])
    await assert.rejects(narrow.commands.commit({ opId: fixture.key(), changes: [
      { op: 'put', node: { $path: '/work/allowed', $type: 't.dir' } },
      { op: 'put', node: { $path: '/other/forbidden', $type: 't.dir' } },
    ] }), code('FORBIDDEN'))
    assert.equal(await fixture.instance.source.node('/work/allowed'), null)
    assert.equal(await fixture.instance.source.node('/other/forbidden'), null)
  })

  it('issues and revokes a credential through actual admin commands while its secret stays unreadable', async t => {
    const fixture = await setup()
    t.after(() => fixture.instance.auth.close())
    const prepared = prepareCredential(fixture.instance.bootstrap.adminId, { expiresAt: Date.now() + 60_000, scope: ['/work'] })
    const outcome = await fixture.commands.commit({ opId: fixture.key(), changes: [{ op: 'put', node: prepared.node }] })
    const admission = await fixture.instance.auth.openCredential(prepared.credential)
    const narrow = fixture.instance.commands(admission)
    assert.equal((await narrow.read({ node: '/work' })).list.length, 1)
    await assert.rejects(fixture.commands.read({ node: credentialPath(prepared.credential.token) }), code('NOT_FOUND'))
    const records = (await fixture.root.scan({ range: { journal: '/' }, budget: scanBudget() })).items
    const position = outcome.pos
    assert.ok(position)
    const record = records.find(row => row.pos.seq === position.seq)
    assert.ok(record)
    assert.equal(record.executor, fixture.commands.actor.principal)
    assert.equal(record.caller, fixture.commands.actor.principal)
    assert.ok(!JSON.stringify(record).includes(prepared.credential.token))
    await fixture.commands.commit({ opId: fixture.key(), changes: [{ op: 'patch', path: prepared.node.$path, ops: { $set: { revoked: true } } }] })
    assert.equal(admission.signal.aborted, true)
    await assert.rejects(narrow.read({ node: '/work' }), code('UNAUTHENTICATED'))
    assert.equal(fixture.commands.signal.aborted, false)
  })

  it('replays durable accepted decisions after reopening without a second gate or effect', async t => {
    let calls = 0
    const fixture = await setup([async operation => {
      if (operation.kind === 'commit' && operation.changes.some(change => change.op === 'patch')) calls++
      return 'pass'
    }])
    t.after(() => fixture.instance.auth.close())
    const request: CommitRequest = { opId: fixture.key(), changes: [{ op: 'patch', path: '/work', ops: { $inc: { count: 1 } } }] }
    const outcome = await fixture.commands.commit(request)
    const reopened = await createInstanceFoundation({ ...fixture.options, writerEpoch: 2 })
    t.after(() => reopened.auth.close())
    const commands = reopened.commands(await reopened.auth.openCredential(fixture.credential))
    assert.deepEqual(await commands.commit(request), outcome)
    assert.equal(calls, 1)
    assert.equal((await reopened.source.node('/work'))?.count, 1)
  })

  it('charges guard ancestor reads to the command allowance and leaves no partial write', async t => {
    const fixture = await setup()
    t.after(() => fixture.instance.auth.close())
    await fixture.commands.commit({ opId: fixture.key(), changes: ['/work/a', '/work/a/b', '/work/a/b/c'].map($path => ({ op: 'put', node: { $path, $type: 't.dir' } })) })
    fixture.budget({ ...scanBudget(), nodes: 4 })
    await assert.rejects(fixture.commands.commit({ opId: fixture.key(), changes: [{ op: 'put', node: { $path: '/work/a/b/c/denied', $type: 't.dir' } }] }), code('BUDGET'))
    fixture.budget()
    assert.equal(await fixture.instance.source.node('/work/a/b/c/denied'), null)
  })

  it('rejects a registry publication during guard even when its handler has identical source text', async t => {
    const fixture = await setup(), entered = signal(), release = signal()
    t.after(() => { release.resolve(); fixture.instance.auth.close() })
    const rule = (mask: number): RightsRule => () => mask
    const manifest = (mask: number): ModuleManifest => ({ id: 'review', types: [
      { name: 'review.item', module: 'review', security: 'ordinary', version: 0, schema: {}, actions: {} },
    ], security: [{ type: 'review.item', context: 'acl', handler: rule(mask) }], open: [] })
    await fixture.commands.commit({ opId: fixture.key(), changes: [{ op: 'put', node: {
      $path: '/sys/types/review.item', $type: 't.type', name: 'review.item', module: 'review', security: 'ordinary',
    } }] })
    fixture.instance.registry.publish(manifest(7))
    await fixture.commands.commit({ opId: fixture.key(), changes: [{ op: 'put', node: { $path: '/work/item', $type: 'review.item', name: 'before' } }] })
    const fill = fixture.instance.writer.cache.fill
    let roots = 0
    t.mock.method(fixture.instance.writer.cache, 'fill', async (...args: Parameters<typeof fill>) => {
      const lease = await fill(...args)
      if ('node' in args[1] && args[1].node === '/' && ++roots === 2) { entered.resolve(); await release.promise }
      return lease
    })
    const pending = fixture.commands.commit({ opId: fixture.key(), changes: [{ op: 'patch', path: '/work/item', ops: { $set: { name: 'forbidden' } } }] })
    await entered.promise
    const digest = fixture.instance.registry.digest
    fixture.instance.registry.publish(manifest(0))
    assert.equal(fixture.instance.registry.digest, digest)
    release.resolve()
    await assert.rejects(pending, code('CONFLICT'))
    assert.equal((await fixture.instance.source.node('/work/item'))?.name, 'before')
  })
})
