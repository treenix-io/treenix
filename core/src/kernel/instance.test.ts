import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { KernelError } from '#errors'
import { prepareCredential } from '#kernel/auth/credentials'
import { LIMITS_PATH, TYPE_PATH } from '#kernel/bootstrap'
import { prepareChangeSet } from '#kernel/changeset'
import { createInstanceFoundation } from '#kernel/instance'
import { createActorResolver } from '#kernel/session'
import { createMemoryStore } from '#kernel/store/memory'
import { scanBudget } from '#kernel/store/contract'
import { A, DEFAULT_LIMITS, R, W, type ModuleManifest, type Position } from '#kernel/types'
import type { PositionCounter } from '#kernel/writer'

const kernel = { executor: 'kernel', caller: 'kernel' } as const
const code = (expected: KernelError['code']) => (error: unknown) => error instanceof KernelError && error.code === expected
function signal() {
  let resolve: () => void = () => {}
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
async function setup(other = false) {
  const root = createMemoryStore({ domain: 'instance' }), alias = createMemoryStore({ domain: 'instance' })
  let saved: Position | undefined
  const counter: PositionCounter = { async load() { return saved }, async save(pos) { saved = { ...pos } }, async freshEpoch(floor) { return floor + 1 } }
  const options = { id: 'foundation-test', root, counter, writerEpoch: 1,
    domains: (other ? [root, alias] : [root]).map(store => ({ store, epoch: 'root1', persistent: true })), budget: scanBudget }
  const instance = await createInstanceFoundation({ ...options,
    firstAdmin: { path: '/auth/users/admin', name: 'admin', password: 'test-admin-password' } })
  const credential = prepareCredential(instance.bootstrap.adminId, { expiresAt: Date.now() + 100_000 })
  await instance.commit([{ op: 'put', node: credential.node }], kernel)
  const resolver = createActorResolver({ instance: instance.id, registry: instance.registry, source: instance.source })
  const resolution = await resolver.resolveCredential(credential.credential)
  const who = { executor: resolution.actor.principal, caller: resolution.actor.principal, actor: resolution.actor }
  return { instance, root, alias, options, credential, resolver, who }
}

describe('native instance foundation', { timeout: 10_000 }, () => {
  it('refills an evicted account by its indexed address without retaining the complete root body', async t => {
    const { instance, root, who } = await setup()
    const before = await instance.source.nodeById(instance.bootstrap.adminId)
    assert.ok(before)
    await instance.commit(Array.from({ length: 40 }, (_, index) => ({ op: 'put' as const,
      node: { $path: `/bulk/${index}`, $type: 't.dir', payload: 'x'.repeat(240 * 1024) } })), who)
    assert.equal(instance.writer.cache.get(instance.bootstrap.adminId), undefined)
    assert.ok(instance.writer.cache.uncoveredBytes <= DEFAULT_LIMITS.readBytes)
    const scan = t.mock.method(root, 'scan')
    assert.deepEqual(await instance.source.nodeById(instance.bootstrap.adminId), before)
    assert.equal(scan.mock.callCount(), 1)
    assert.deepEqual(scan.mock.calls[0].arguments[0].range, { node: before.$path })
  })

  it('publishes a module only after its real admin metadata commit and journals admin seed writes', async () => {
    const { instance, root, who } = await setup()
    const module: ModuleManifest = { id: 'example', types: [{ name: 'example.item', module: 'example', security: 'ordinary', version: 0,
      schema: { type: 'object', properties: { value: { type: 'number' } } }, actions: {} }], security: [], open: [] }
    const before = instance.registry.digest
    assert.throws(() => instance.registry.publish(module), code('FORBIDDEN'))
    assert.equal(instance.registry.digest, before)
    const metadata = await instance.commit([{ op: 'put', node: { $path: `${TYPE_PATH}/example.item`, $type: 't.type',
      name: 'example.item', module: 'example', security: 'ordinary' } }], who)
    instance.registry.publish(module)
    const seed = await instance.commit([{ op: 'put', node: { $path: '/seed', $type: 'example.item', value: 7 } }], who)
    assert.equal((await instance.source.node('/seed'))?.value, 7)
    const records = (await root.scan({ range: { journal: '/' }, budget: scanBudget() })).items
    for (const pos of [metadata, seed]) {
      const record = records.find(record => record.pos.seq === pos.seq && record.pos.epoch === pos.epoch)
      assert.ok(record)
      assert.equal(record.kind, 'commit')
      assert.equal(record.executor, who.actor.principal)
      assert.equal(record.caller, who.actor.principal)
    }
    const digest = instance.registry.digest
    assert.throws(() => instance.registry.publish({ ...module, types: [{ ...module.types[0], security: 'user-capability' }] }), code('FORBIDDEN'))
    assert.equal(instance.registry.digest, digest)
    await assert.rejects(instance.commit([{ op: 'patch', path: `${TYPE_PATH}/example.item`,
      ops: { $set: { security: 'user-capability' } } }], who), code('FORBIDDEN'))
    assert.equal((await instance.source.node(`${TYPE_PATH}/example.item`))?.security, 'ordinary')
  })

  it('applies optional limit overrides on the next operation and rejects invalid values atomically', async () => {
    const { instance, who } = await setup()
    await instance.commit([{ op: 'patch', path: LIMITS_PATH, ops: { $set: { queryMs: 10 }, $unset: { exprWork: true } } }], who)
    assert.equal(instance.limits().queryMs, 10)
    assert.equal(instance.limits().exprWork, DEFAULT_LIMITS.exprWork)
    const before = await instance.source.node(LIMITS_PATH)
    for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await assert.rejects(instance.commit([{ op: 'patch', path: LIMITS_PATH, ops: { $set: { readNodes: value } } }], who), code('INVALID'))
    }
    await assert.rejects(instance.commit([{ op: 'patch', path: LIMITS_PATH, ops: { $set: { unknownLimit: 10 } } }], who), code('INVALID'))
    assert.deepEqual(await instance.source.node(LIMITS_PATH), before)
    await assert.rejects(instance.commit([{ op: 'remove', path: LIMITS_PATH }], who), code('FORBIDDEN'))
    assert.deepEqual(await instance.source.node(LIMITS_PATH), before)
  })

  it('retains account identity through moves, removes deleted identities and never remints revoked first admins on reopen', async () => {
    for (const change of ['blocked', 'deleted']) {
      const { instance, options, credential, resolver, who } = await setup()
      const adminId = instance.bootstrap.adminId
      if (change === 'blocked') await instance.commit([{ op: 'patch', path: instance.bootstrap.adminPath, ops: { $set: { status: 'blocked' } } }], who)
      else {
        await instance.commit([{ op: 'move', from: instance.bootstrap.adminPath, to: '/auth/users/moved' }], who)
        assert.equal((await instance.source.nodeById(adminId))?.$path, '/auth/users/moved')
        assert.equal(await instance.source.node(instance.bootstrap.adminPath), null)
        await instance.commit([{ op: 'remove', path: '/auth/users/moved' }], who)
        assert.equal(await instance.source.nodeById(adminId), null)
      }
      await assert.rejects(resolver.resolveCredential(credential.credential), code('UNAUTHENTICATED'))
      const reopened = await createInstanceFoundation({ ...options, writerEpoch: 2 })
      const reconnect = createActorResolver({ instance: reopened.id, registry: reopened.registry, source: reopened.source })
      assert.deepEqual(reopened.bootstrap, instance.bootstrap)
      const first = await reopened.source.nodeById(adminId)
      if (change === 'blocked') assert.equal(first?.status, 'blocked')
      else assert.equal(first, null)
      await assert.rejects(reconnect.resolveCredential(credential.credential), code('UNAUTHENTICATED'))
    }
  })

  it('keeps a same-domain target Store out of the root accepted identity index', async () => {
    const { instance, alias } = await setup(true)
    await instance.writer.commit(alias, [], pos => prepareChangeSet({ store: alias, cache: instance.writer.cache,
      registry: instance.registry, budget: scanBudget() }, [{ op: 'put', node: { $path: '/elsewhere', $type: 't.dir' } }], pos))
    const other = (await alias.scan({ range: { node: '/elsewhere' }, budget: scanBudget() })).items[0]
    assert.ok(other)
    assert.equal(await instance.source.node('/elsewhere'), null)
    assert.equal(await instance.source.nodeById(other.$id), null)
    assert.ok(await instance.source.nodeById(instance.bootstrap.adminId))
  })

  it('prepares distinct identities at one physical path in two same-domain Stores', async () => {
    const { instance, root, alias, who } = await setup(true)
    await instance.commit([{ op: 'put', node: { $path: '/shared-path', $type: 't.dir', value: 'root' } }], who)
    const original = await instance.source.node('/shared-path')
    assert.ok(original)
    await instance.writer.commit(alias, [], pos => prepareChangeSet({ store: alias, cache: instance.writer.cache,
      registry: instance.registry, budget: scanBudget() }, [{ op: 'put', node: { $path: '/shared-path', $type: 't.dir', value: 'alias' } }], pos))
    const other = (await alias.scan({ range: { node: '/shared-path' }, budget: scanBudget() })).items[0]
    assert.ok(other)
    assert.notEqual(other.$id, original.$id)
    assert.equal(other.value, 'alias')
    assert.deepEqual(await instance.source.node('/shared-path'), original)
    assert.deepEqual((await root.scan({ range: { node: '/shared-path' }, budget: scanBudget() })).items, [original])
    assert.equal(await instance.source.nodeById(other.$id), null)
    await instance.commit([{ op: 'patch', path: '/shared-path', ops: { $set: { value: 'updated-root' } } }], who)
    assert.equal((await instance.source.node('/shared-path'))?.$id, original.$id)
    assert.equal((await instance.source.node('/shared-path'))?.value, 'updated-root')
    assert.equal((await alias.scan({ range: { node: '/shared-path' }, budget: scanBudget() })).items[0].value, 'alias')
  })

  it('reads one accepted snapshot while a queued real write waits for the whole read', async () => {
    const { instance, who } = await setup(), entered = signal(), release = signal()
    const reading = instance.source.read(async source => {
      const before = await source.nodeById(instance.bootstrap.adminId)
      entered.resolve()
      await release.promise
      const after = await source.nodeById(instance.bootstrap.adminId)
      assert.deepEqual(after, before)
      return before?.name
    })
    await entered.promise
    const writing = instance.commit([{ op: 'patch', path: instance.bootstrap.adminPath, ops: { $set: { name: 'changed' } } }], who)
    release.resolve()
    assert.equal(await reading, 'admin')
    await writing
    assert.equal((await instance.source.nodeById(instance.bootstrap.adminId))?.name, 'changed')
  })

  it('ends the bound read scope and releases a queued write after a rejected read callback', async () => {
    const { instance, who } = await setup(), entered = signal(), release = signal()
    const bound = await instance.source.read(async source => source)
    await assert.rejects(bound.node('/'), code('INVALID'))
    assert.throws(() => bound.shard('/'), code('INVALID'))
    const failure = new KernelError('INVALID', 'Rejected native read')
    const reading = instance.source.read(async source => {
      assert.ok(await source.node('/'))
      entered.resolve()
      await release.promise
      throw failure
    })
    await entered.promise
    const denied = assert.rejects(reading, error => error === failure)
    const writing = instance.commit([{ op: 'put', node: { $path: '/after-read', $type: 't.dir' } }], who)
    release.resolve()
    await denied
    await writing
    assert.ok(await instance.source.node('/after-read'))
  })

  it('rejects direct protected type creation by an actor with delegated parent write and admin bits', async () => {
    const { instance, who, resolver } = await setup()
    await instance.commit([{ op: 'put', node: { $path: '/auth/users/delegated', $type: 't.user', name: 'delegated', status: 'active' } }], who)
    const account = await instance.source.node('/auth/users/delegated')
    assert.ok(account)
    const issued = prepareCredential(account.$id, { expiresAt: Date.now() + 100_000 })
    await instance.commit([{ op: 'put', node: issued.node }, { op: 'patch', path: TYPE_PATH,
      ops: { $set: { $acl: [{ subject: { group: `u:${account.$id}` }, grant: R | W | A }] } } },
      { op: 'put', node: { $path: '/delegated', $type: 't.dir', $acl: [{ subject: { group: `u:${account.$id}` }, grant: R | W | A }] } }], who)
    const resolved = await resolver.resolveCredential(issued.credential)
    const delegate = { executor: resolved.actor.principal, caller: resolved.actor.principal, actor: resolved.actor }
    await instance.commit([{ op: 'put', node: { $path: '/delegated/ordinary', $type: 't.dir' } }], delegate)
    for (const node of [{ $path: `${TYPE_PATH}/forged`, $type: 't.type', name: 'forged', module: 'forged', security: 'ordinary' },
      { $path: '/delegated/limits', $type: 't.limits', readNodes: 10 }]) {
      await assert.rejects(instance.commit([{ op: 'put', node }], delegate), code('FORBIDDEN'))
      assert.equal(await instance.source.node(node.$path), null)
    }
  })
})
