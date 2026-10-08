import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { KernelError } from '#errors'
import { AUTH_KEY_PATH } from '#kernel/auth-module'
import { prepareCredential } from '#kernel/auth/credentials'
import { credentialPath, signAnonymous } from '#kernel/auth/crypto'
import { createInstanceFoundation } from '#kernel/instance'
import { createActorResolver, type AuthSource } from '#kernel/session'
import { createMemoryStore } from '#kernel/store/memory'
import { computeRights } from '#kernel/rights'
import { createChainIndex } from '#kernel/chain-index'
import type { ModuleManifest, Position } from '#kernel/types'
import type { PositionCounter } from '#kernel/writer'

const code = (expected: KernelError['code']) => (error: unknown) => error instanceof KernelError && error.code === expected
const kernel = { executor: 'kernel', caller: 'kernel' } as const

async function setup(id = 'auth-instance') {
  const root = createMemoryStore({ domain: id })
  let saved: Position | undefined
  const counter: PositionCounter = { load: async () => saved, save: async value => { saved = value }, freshEpoch: async floor => floor + 1 }
  const options = { id, root, counter, writerEpoch: 1, domains: [{ store: root, persistent: false, epoch: `${id}-store` }] }
  const instance = await createInstanceFoundation({ ...options,
    firstAdmin: { path: '/auth/users/admin', name: 'admin', password: 'test-admin-password' } })
  const prepared = prepareCredential(instance.bootstrap.adminId, { expiresAt: Date.now() + 100_000 })
  // Initial fixture provisioning uses the real writer; no actor or accepted index is fabricated.
  await instance.commit([{ op: 'put', node: prepared.node }], kernel)
  const resolver = createActorResolver({ instance: id, registry: instance.registry, source: instance.source })
  const initial = await resolver.resolveCredential(prepared.credential)
  const who = { executor: initial.actor.principal, caller: initial.actor.principal, actor: initial.actor }
  return { instance, resolver, prepared, initial, who, options }
}

describe('native actor resolution through accepted instance data', () => {
  it('owns the credential supplied before awaiting the accepted read barrier', async () => {
    const { instance, prepared, initial } = await setup()
    let resume: () => void = () => {}, entered: () => void = () => {}
    const held = new Promise<void>(resolve => { resume = resolve })
    const started = new Promise<void>(resolve => { entered = resolve })
    const source: AuthSource = { ...instance.source, read: operation => instance.source.read(async reader => {
      entered()
      await held
      return operation(reader)
    }) }
    const resolver = createActorResolver({ instance: instance.id, registry: instance.registry, source })
    const credential = { token: prepared.credential.token }
    const pending = resolver.resolveCredential(credential)
    await started
    credential.token = 'invalid'
    resume()
    const resolution = await pending
    assert.deepEqual(resolution.actor, initial.actor)
    assert.equal(resolution.credential?.token, prepared.credential.token)
  })

  it('reads credential and account in one ordered span before a concurrent authorization change', async () => {
    const { instance, prepared, initial, who, resolver } = await setup()
    let resume: () => void = () => {}, entered: () => void = () => {}
    const held = new Promise<void>(resolve => { resume = resolve })
    const started = new Promise<void>(resolve => { entered = resolve })
    const source: AuthSource = { ...instance.source, read: operation => instance.source.read(reader => operation({
      ...reader, async node(path) {
        const node = await reader.node(path)
        if (path === prepared.node.$path) { entered(); await held }
        return node
      },
    })) }
    const controlled = createActorResolver({ instance: instance.id, registry: instance.registry, source })
    const reading = controlled.resolveCredential(prepared.credential)
    await started
    let committed = false
    const writing = instance.commit([
      { op: 'patch', path: prepared.node.$path, ops: { $set: { scope: ['/only'] } } },
      { op: 'patch', path: instance.bootstrap.adminPath, ops: { $set: { '#groups.list': ['admins', 'after'] } } },
    ], who).then(() => { committed = true })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(committed, false)
    resume()
    assert.deepEqual((await reading).actor, initial.actor)
    await writing
    const next = await resolver.resolveCredential(prepared.credential)
    assert.deepEqual(next.actor.scope, ['/only'])
    assert.ok(next.actor.claims.includes('after'))
  })

  it('keeps account identity and semantic sources stable across rename and move', async () => {
    const { instance, resolver, prepared, initial, who } = await setup()
    assert.equal(initial.actor.principal, `u:${instance.bootstrap.adminId}`)
    assert.deepEqual(initial.actor.claims, [initial.actor.principal, 'public', 'authenticated', 'admins'])
    assert.ok(Object.isFrozen(initial) && Object.isFrozen(initial.actor) && Object.isFrozen(initial.actor.claims))
    assert.ok(Object.isFrozen(initial.sources) && initial.sources.every(Object.isFrozen))
    await instance.commit([{ op: 'patch', path: instance.bootstrap.adminPath, ops: { $set: { name: 'renamed' } } },
      { op: 'move', from: instance.bootstrap.adminPath, to: '/auth/users/renamed' }], who)
    const next = await resolver.resolveCredential(prepared.credential)
    assert.deepEqual(next.actor, initial.actor)
    assert.equal(next.sources[0].path, '/auth/users/renamed')
    assert.notEqual(next.sources[0].rev, initial.sources[0].rev)
    assert.equal(next.sources[0].version, initial.sources[0].version)
    assert.equal((await instance.source.nodeById(instance.bootstrap.adminId))?.$path, '/auth/users/renamed')
  })

  it('rejects blocked, pending, revoked, expired and deleted account credentials without anonymous fallback', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 1000 })
    const { instance, resolver, prepared, who } = await setup()
    for (const status of ['blocked', 'pending']) {
      await instance.commit([{ op: 'patch', path: instance.bootstrap.adminPath, ops: { $set: { status } } }], who)
      await assert.rejects(resolver.resolveCredential(prepared.credential), code('UNAUTHENTICATED'))
    }
    await instance.commit([{ op: 'patch', path: instance.bootstrap.adminPath, ops: { $set: { status: 'active' } } },
      { op: 'patch', path: prepared.node.$path, ops: { $set: { revoked: true } } }], who)
    await assert.rejects(resolver.resolveCredential(prepared.credential), code('UNAUTHENTICATED'))
    await instance.commit([{ op: 'patch', path: prepared.node.$path, ops: { $set: { revoked: false, expiresAt: 1100 } } }], who)
    t.mock.timers.setTime(1100)
    await assert.rejects(resolver.resolveCredential(prepared.credential), code('UNAUTHENTICATED'))
    await instance.commit([{ op: 'patch', path: prepared.node.$path, ops: { $set: { expiresAt: 1200 } } },
      { op: 'remove', path: instance.bootstrap.adminPath }], who)
    await instance.commit([{ op: 'put', node: { $path: instance.bootstrap.adminPath, $type: 't.user', name: 'admin', status: 'active' } }], kernel)
    assert.notEqual((await instance.source.node(instance.bootstrap.adminPath))?.$id, instance.bootstrap.adminId)
    await assert.rejects(resolver.resolveCredential(prepared.credential), code('UNAUTHENTICATED'))
    for (const token of ['', 'invalid', 'anon.invalid.signature', 'ab'.repeat(32)]) {
      await assert.rejects(resolver.resolveCredential({ token }), code('UNAUTHENTICATED'))
    }
  })

  it('copies credential scopes and changes only semantic authorization dependencies', async () => {
    const { instance, resolver, prepared, initial, who } = await setup()
    await instance.commit([{ op: 'patch', path: prepared.node.$path, ops: { $set: { scope: ['/only'] } } },
      { op: 'patch', path: instance.bootstrap.adminPath, ops: { $set: { '#groups.list': ['admins', 'team'] } } }], who)
    const next = await resolver.resolveCredential(prepared.credential)
    assert.deepEqual(initial.actor.scope, undefined)
    assert.deepEqual(next.actor.scope, ['/only'])
    assert.ok(Object.isFrozen(next.actor.scope))
    assert.notEqual(next.sources[0].version, initial.sources[0].version)
    assert.notEqual(next.sources[1].version, initial.sources[1].version)
    assert.ok(next.actor.claims.includes('team'))
    const index = createChainIndex()
    for (const path of ['/', '/only', '/else']) {
      const node = await instance.source.node(path)
      if (node !== null) index.put(node)
    }
    assert.equal(computeRights(next.actor, index.chain('/'), instance.registry).bits, 0)
    assert.equal(computeRights(next.actor, index.chain('/else'), instance.registry).bits, 0)
    await instance.commit([{ op: 'patch', path: prepared.node.$path, ops: { $set: { scope: [] } } }], who)
    assert.deepEqual((await resolver.resolveCredential(prepared.credential)).actor.scope, [])
    assert.equal(credentialPath(prepared.credential.token), prepared.node.$path)
  })

  it('persists anonymous signing state per instance across reopening without sharing other instances', async () => {
    const { instance, resolver, options } = await setup('anon-instance')
    const anonymous = await resolver.resolveCredential()
    assert.deepEqual(anonymous.actor.claims, [anonymous.actor.principal, 'public'])
    assert.ok(anonymous.credential)
    const reopened = await createInstanceFoundation(options)
    const reconnect = createActorResolver({ instance: reopened.id, registry: reopened.registry, source: reopened.source })
    assert.deepEqual((await reconnect.resolveCredential(anonymous.credential)).actor, anonymous.actor)
    const other = await setup('another-instance')
    await assert.rejects(other.resolver.resolveCredential(anonymous.credential), code('UNAUTHENTICATED'))
    const stored = await instance.source.node(AUTH_KEY_PATH)
    assert.equal(stored?.$id, (await reopened.source.node(AUTH_KEY_PATH))?.$id)
    assert.ok(stored && typeof stored.key === 'string')
    const scoped = { token: signAnonymous({ instance: instance.id, id: '34'.repeat(16), issuedAt: Date.now(),
      expiresAt: Date.now() + 1000, scope: ['/only'] }, stored.key) }
    assert.deepEqual((await resolver.resolveCredential(scoped)).actor.scope, ['/only'])
  })

  it('creates node actors only from exact native declarations and gives groups only to privileged capabilities', async () => {
    const { instance, resolver, who } = await setup()
    const module: ModuleManifest = { id: 'executor-test', open: [], security: [
      { type: 'test.privileged', context: 'derive', handler: async () => ({ members: [] }) },
    ], types: [
      { name: 'test.form', module: 'executor-test', security: 'user-capability', schema: {}, version: 0,
        actions: { submit: { kind: 'setuid', args: {}, handler: async () => undefined } } },
      { name: 'test.privileged', module: 'executor-test', security: 'privileged-capability', schema: {}, version: 0, actions: {} },
      { name: 'test.ordinary', module: 'executor-test', security: 'ordinary', schema: {}, version: 0, actions: {} },
    ] }
    await instance.commit(module.types.map(type => ({ op: 'put', node: { $path: `/sys/types/${type.name}`,
      $type: 't.type', name: type.name, module: type.module, security: type.security } })), who)
    instance.registry.publish(module)
    await instance.commit([
      { op: 'put', node: { $path: '/form', $type: 'test.form' } },
      { op: 'put', node: { $path: '/privileged', $type: 'test.privileged', '#groups': { $type: 't.groups', list: ['team'] } } },
      { op: 'put', node: { $path: '/grouped-form', $type: 'test.form', '#groups': { $type: 't.groups', list: ['team'] } } },
      { op: 'put', node: { $path: '/ordinary', $type: 'test.ordinary' } },
    ], who)
    const form = await resolver.resolveNode('/form'), privileged = await resolver.resolveNode('/privileged')
    assert.equal(form.actor.principal, `n:${(await instance.source.node('/form'))?.$id}`)
    assert.deepEqual(form.actor.claims, [form.actor.principal])
    assert.deepEqual(privileged.actor.claims, [privileged.actor.principal, 'team'])
    await assert.rejects(resolver.resolveNode('/grouped-form'), code('INVALID'))
    await assert.rejects(resolver.resolveNode('/ordinary'), code('INVALID'))
    await assert.rejects(resolver.resolveNode('/missing'), code('NOT_FOUND'))
    const index = createChainIndex(), root = await instance.source.node('/')
    assert.ok(root)
    index.put(root)
    assert.equal(computeRights(form.actor, index.chain('/'), instance.registry).bits, 0)
    assert.equal(computeRights(privileged.actor, index.chain('/'), instance.registry).bits, 0)
  })
})
