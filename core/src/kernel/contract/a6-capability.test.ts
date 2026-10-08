import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { KernelError } from '#errors'
import { guardCapabilities } from '#kernel/capability'
import { createChainIndex } from '#kernel/chain-index'
import { fixture, put } from '#kernel/contract/changeset-fixture'
import { createRegistry } from '#kernel/registry'
import { positionToRev } from '#kernel/position'
import { A, R, W, type AclEntry, type Actor, type ChangeMember, type Preconditions, type StoredNode } from '#kernel/types'

const all = R | W | A
const actor: Actor = { principal: 'u:alice', claims: ['u:alice', 'users'] }
const grant = (group: string, bits = all): AclEntry => ({ subject: { group }, grant: bits })
const owned = (bits = R | W): AclEntry => ({ subject: { owner: true }, grant: bits })
const code = (expected: KernelError['code']) => (error: unknown) => error instanceof KernelError && error.code === expected

function registry() {
  const result = createRegistry()
  result.publish({ id: 'test', open: [{ type: 'fake', context: 'service:custom', handler: async () => ({ stop: async () => {} }) }],
    security: [{ type: 'limited', context: 'acl', handler: () => R | W }], types: [
      ...['dir', 'item', 'groups', 'limited', 'fake'].map(name => ({ name, module: 'test', security: 'ordinary', version: 0, schema: {}, actions: {} } as const)),
      { name: 'privileged', aliases: ['old.privileged'], module: 'test', security: 'privileged-capability', version: 0, schema: {}, actions: {} },
      { name: 'form', module: 'test', security: 'user-capability', version: 0, schema: {},
        actions: { submit: { kind: 'setuid', args: {}, handler: async () => undefined } } },
    ] })
  return result
}
async function setup(bits = R | W) {
  const f = await fixture({ registry: registry() })
  await f.commit([put('/', { $acl: [grant('users', bits)] }, 'dir')])
  return { ...f, asActor: (changes: readonly ChangeMember[], expect?: Preconditions) =>
    f.commit(changes, { executor: actor.principal, caller: actor.principal, actor, expect }) }
}
async function unchanged(f: Awaited<ReturnType<typeof setup>>, changes: readonly ChangeMember[], expected: KernelError['code'] = 'FORBIDDEN', expect?: Preconditions) {
  const nodes = await f.nodes(), journal = await f.journal()
  await assert.rejects(f.asActor(changes, expect), code(expected))
  assert.deepEqual(await f.nodes(), nodes); assert.deepEqual(await f.journal(), journal)
}
const pin = (node: StoredNode): Preconditions => ({ nodes: [{ path: node.$path, rev: positionToRev(node.$pos) }] })

describe('capability guards', () => {
  it('denies privileged main and named types on creation, mutation, removal and relocation', async () => {
    const f = await setup()
    await f.commit([put('/privileged', { value: 'old' }, 'privileged')])
    await unchanged(f, [put('/new', {}, 'privileged')])
    await unchanged(f, [put('/named', { '#cap': { $type: 'old.privileged' } })])
    await unchanged(f, [{ op: 'patch', path: '/privileged', ops: { $set: { value: 'new' } } }])
    await unchanged(f, [{ op: 'remove', path: '/privileged' }])
    await unchanged(f, [{ op: 'move', from: '/privileged', to: '/moved' }])
    const admin = await setup(all)
    await admin.asActor([put('/allowed', {}, 'privileged')])
    assert.equal((await admin.nodes()).find(node => node.$path === '/allowed')?.$type, 'privileged')
  })

  it('permits a user capability without grants to its principal', async () => {
    const f = await setup()
    await f.asActor([put('/form', { target: 'old' }, 'form')])
    await f.asActor([{ op: 'patch', path: '/form', ops: { $set: { target: 'new' } } }])
    assert.equal((await f.nodes()).find(node => node.$path === '/form')?.target, 'new')
  })

  it('requires A on every direct grant target before its executor node can change', async () => {
    const f = await setup()
    await f.commit([put('/form', { $acl: [grant('users')] }, 'form')])
    const form = (await f.nodes()).find(node => node.$path === '/form')!
    await f.commit([put('/allowed', { $acl: [grant('users'), grant(`n:${form.$id}`, W)] }),
      put('/denied', { $acl: [grant(`n:${form.$id}`, W)] })])
    await unchanged(f, [{ op: 'patch', path: '/form', ops: { $set: { target: 'new' } } }])
    await f.commit([{ op: 'patch', path: '/denied', ops: { $set: { $acl: [grant('users'), grant(`n:${form.$id}`, W)] } } }])
    await f.asActor([{ op: 'patch', path: '/form', ops: { $set: { target: 'new' } } }])
    assert.equal((await f.nodes()).find(node => node.$path === '/form')?.target, 'new')
  })

  it('includes grants resolved through the nearest owner when protecting a node', async () => {
    const f = await setup()
    await f.commit([put('/form', {}, 'form')])
    const form = (await f.nodes()).find(node => node.$path === '/form')!
    await f.commit([put('/owned', { $owner: `n:${form.$id}` }, 'dir'), put('/owned/target', { $acl: [owned()] })])
    await unchanged(f, [{ op: 'remove', path: '/form' }])
  })

  it('checks surviving grants when restoring a deleted executor identity', async () => {
    const f = await setup()
    await f.commit([put('/forms', { $acl: [grant('users')] }, 'dir'), put('/forms/form', {}, 'form')])
    const form = (await f.nodes()).find(node => node.$path === '/forms/form')!
    await f.commit([put('/target', { $acl: [grant(`n:${form.$id}`, W)] })])
    const removed = await f.commit([{ op: 'remove', path: '/forms/form' }])
    await unchanged(f, [{ op: 'restore', record: { pos: removed, id: form.$id } }])
  })

  it('treats a groups component at any named key as administrator-only while ordinary nested data stays writable', async () => {
    const f = await setup()
    await unchanged(f, [put('/grouped', { '#membership': { $type: 'groups', list: ['agents'] } })])
    await f.commit([put('/existing', { '#membership': { $type: 'groups', list: [] } })])
    await unchanged(f, [{ op: 'patch', path: '/existing', ops: { $unset: { '#membership': true } } }])
    await f.asActor([put('/ordinary', { snapshot: { $type: 'groups', list: ['agents'] } })])
    assert.deepEqual((await f.nodes()).find(node => node.$path === '/ordinary')?.snapshot, { $type: 'groups', list: ['agents'] })
  })

  it('requires a matching named executor version for a new grant, even from an administrator', async () => {
    const f = await setup(all)
    await f.commit([put('/form', {}, 'form'), put('/target')])
    const form = (await f.nodes()).find(node => node.$path === '/form')!
    const changes: ChangeMember[] = [{ op: 'patch', path: '/target', ops: { $set: { $acl: [grant(`n:${form.$id}`, W)] } } }]
    await unchanged(f, changes, 'INVALID')
    await unchanged(f, changes, 'CONFLICT', { nodes: [{ path: '/form', rev: 'stale' }] })
    await f.asActor(changes, pin(form))
    assert.deepEqual((await f.nodes()).find(node => node.$path === '/target')?.$acl, [grant(`n:${form.$id}`, W)])
  })

  it('requires A on the executor node as well as the grant target', async () => {
    const f = await setup()
    await f.commit([put('/form', {}, 'form'), put('/target', { $acl: [grant('users')] })])
    const form = (await f.nodes()).find(node => node.$path === '/form')!
    await unchanged(f, [{ op: 'patch', path: '/target', ops: { $set: { $acl: [grant(`n:${form.$id}`, W)] } } }], 'FORBIDDEN', pin(form))
  })

  it('rejects grants to path identities and to nodes with no declared executor behavior', async () => {
    const f = await setup(all)
    await f.commit([put('/target'), put('/ordinary')])
    const ordinary = (await f.nodes()).find(node => node.$path === '/ordinary')!
    await unchanged(f, [{ op: 'patch', path: '/target', ops: { $set: { $acl: [grant('n:p:/path', W)] } } }], 'INVALID')
    await unchanged(f, [{ op: 'patch', path: '/target', ops: { $set: { $acl: [grant(`n:${ordinary.$id}`, W)] } } }], 'INVALID', pin(ordinary))
  })

  it('does not admit an open contextual fallback as declared executor behavior', async () => {
    const f = await setup(all)
    await f.commit([put('/fake', {}, 'fake'), put('/target')])
    const fake = (await f.nodes()).find(node => node.$path === '/fake')!
    await unchanged(f, [{ op: 'patch', path: '/target', ops: { $set: { $acl: [grant(`n:${fake.$id}`, W)] } } }], 'INVALID', pin(fake))
  })

  it('rejects a node under a shard as a grant recipient', async () => {
    const f = await setup(all)
    await f.commit([put('/form', {}, 'form'), put('/target')])
    const nodes = await f.nodes(), form = nodes.find(node => node.$path === '/form')!, target = nodes.find(node => node.$path === '/target')!
    await assert.rejects(guardCapabilities([{ id: target.$id, before: target, after: { ...target, $acl: [grant(`n:${form.$id}`, W)] } }],
      { registry: f.registry, admin: true, expect: pin(form), readBefore: async path => nodes.find(node => node.$path === path) ?? null,
        requireA: async () => {}, state: { node: async () => form, grants: () => [], ownerGrants: [], shard: () => true } }), code('INVALID'))
  })

  it('requires a pin only for newly added grant bits', async () => {
    const f = await setup(all)
    await f.commit([put('/form', {}, 'form')])
    const form = (await f.nodes()).find(node => node.$path === '/form')!
    await f.commit([put('/target', { $acl: [grant(`n:${form.$id}`, R)] })])
    await f.asActor([{ op: 'patch', path: '/target', ops: { $set: { value: 'new' } } }])
    await unchanged(f, [{ op: 'patch', path: '/target', ops: { $set: { $acl: [grant(`n:${form.$id}`, R | W)] } } }], 'INVALID')
    assert.equal((await f.nodes()).find(node => node.$path === '/target')?.value, 'new')
  })

  it('rejects a grant when its named executor configuration is changed in the same batch', async () => {
    const f = await setup(all)
    await f.commit([put('/form', { target: 'old' }, 'form'), put('/target')])
    const form = (await f.nodes()).find(node => node.$path === '/form')!
    await unchanged(f, [{ op: 'patch', path: '/form', ops: { $set: { target: 'different' } } },
      { op: 'patch', path: '/target', ops: { $set: { $acl: [grant(`n:${form.$id}`, W)] } } }], 'CONFLICT', pin(form))
  })

  it('requires A at an unchanged owner-grant target when ancestor ownership would assign it to a node', async () => {
    const f = await setup()
    await f.commit([put('/form', { $acl: [grant('users')] }, 'form'),
      put('/owned', { $owner: 'u:bob', $acl: [grant('users')] }, 'dir'),
      put('/owned/target', { $acl: [owned()], '#rule': { $type: 'limited' } })])
    const form = (await f.nodes()).find(node => node.$path === '/form')!
    await unchanged(f, [{ op: 'patch', path: '/owned', ops: { $set: { $owner: `n:${form.$id}` } } }], 'FORBIDDEN', pin(form))
  })

  it('pins the executor version for a grant acquired through an ancestor owner change', async () => {
    const f = await setup()
    await f.commit([put('/form', { $acl: [grant('users')] }, 'form'),
      put('/owned', { $owner: 'u:bob', $acl: [grant('users')] }, 'dir'), put('/owned/target', { $acl: [owned()] })])
    const form = (await f.nodes()).find(node => node.$path === '/form')!
    const changes: ChangeMember[] = [{ op: 'patch', path: '/owned', ops: { $set: { $owner: `n:${form.$id}` } } }]
    await unchanged(f, changes, 'INVALID')
    await f.asActor(changes, pin(form))
    assert.equal((await f.nodes()).find(node => node.$path === '/owned')?.$owner, `n:${form.$id}`)
  })

  it('updates effective owner-grant indexing when ancestors or nearer owners change', () => {
    const index = createChainIndex(), pos = { instance: 'test', epoch: 1, seq: 1 }
    const node = (path: string, fields: Record<string, unknown> = {}): StoredNode => ({ $path: path, $id: path, $type: 'item', $pos: pos, ...fields })
    index.put(node('/', { $owner: 'n:form' }))
    index.put(node('/target', { $acl: [owned()] }))
    assert.deepEqual([...index.grantsTo('n:form')], ['/target'])
    index.put(node('/target', { $owner: 'n:other', $acl: [owned()] }))
    assert.deepEqual([...index.grantsTo('n:form')], []); assert.deepEqual([...index.grantsTo('n:other')], ['/target'])
    index.put(node('/target', { $acl: [owned()] }))
    index.remove('/')
    assert.deepEqual([...index.grantsTo('n:form')], [])
  })
})
