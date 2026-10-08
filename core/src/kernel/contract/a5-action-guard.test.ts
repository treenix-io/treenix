import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { KernelError } from '#errors'
import type { ActionProvenance } from '#kernel/action-guard'
import { fixture, put } from '#kernel/contract/changeset-fixture'
import { createRegistry } from '#kernel/registry'
import { A, R, W, type Actor, type ChangeMember, type TypeDef } from '#kernel/types'

const actor: Actor = { principal: 'u:alice', claims: ['u:alice', 'users'] }
const all = R | W | A
const code = (expected: KernelError['code']) => (error: unknown) => error instanceof KernelError && error.code === expected
const origin = (action = 'pay', targets?: ActionProvenance['targets']): ActionProvenance => ({ type: 'locked', action, path: '/source', targets })

function registry() {
  const result = createRegistry()
  const actions: TypeDef['actions'] = {
    approve: { kind: 'write', args: {}, handler: async () => undefined },
    inspect: { kind: 'read', args: {}, handler: async () => undefined },
    pay: { kind: 'write', args: {}, post: { '': { $set: { status: 'paid' } } } },
    transfer: { kind: 'write', args: {}, needs: { other: { node: '/other' } },
      post: { '': { $set: { status: 'paid' } }, other: { $inc: { total: 1 } } } },
    add: { kind: 'write', args: {}, post: { '': { $set: { '#extra': { $type: 'extra' } } } } },
    relocate: { kind: 'write', args: {}, post: { '': { $set: { $path: '/moved' } } } },
    create: { kind: 'write', args: {}, needs: { next: { node: '/new' } }, post: { next: { $set: { $type: 'item', value: 7 } } } },
    unchanged: { kind: 'write', args: {}, post: { '': {} } },
  }
  result.publish({ id: 'test', security: [], open: [], types: [
    ...['dir', 'item', 'extra'].map(name => ({ name, module: 'test', security: 'ordinary', version: 0, schema: {}, actions: {} } as const)),
    { name: 'locked', aliases: ['old.locked'], module: 'test', security: 'ordinary', version: 0, schema: {}, actionsOnly: true, actions },
    { name: 'writer', module: 'test', security: 'ordinary', version: 0, schema: {}, actions: { approve: actions.approve } },
  ] })
  return result
}
async function setup(bits = R | W) {
  const f = await fixture({ registry: registry() })
  await f.commit([put('/', { $acl: [{ subject: { group: 'users' }, grant: bits }] }, 'dir'),
    put('/source', { status: 'draft', retained: 'same' }, 'locked'), put('/other', { total: 0 })])
  return { ...f, asActor: (changes: readonly ChangeMember[], action?: ActionProvenance) =>
    f.commit(changes, { executor: actor.principal, caller: actor.principal, actor, action }) }
}
async function unchanged(f: Awaited<ReturnType<typeof setup>>, changes: readonly ChangeMember[], action?: ActionProvenance, expected: KernelError['code'] = 'FORBIDDEN') {
  const nodes = await f.nodes(), journal = await f.journal()
  await assert.rejects(f.asActor(changes, action), code(expected))
  assert.deepEqual(await f.nodes(), nodes); assert.deepEqual(await f.journal(), journal)
}

describe('writing action guards', () => {
  it('denies direct changes to actions-only types, including subtree removal, move and new copies', async () => {
    const f = await setup()
    await unchanged(f, [{ op: 'patch', path: '/source', ops: { $set: { status: 'paid' } } }])
    await unchanged(f, [{ op: 'remove', path: '/' }])
    await unchanged(f, [{ op: 'move', from: '/source', to: '/moved' }])
    await unchanged(f, [put('/copy', { status: 'paid' }, 'locked')])
    const admin = await setup(all)
    await admin.asActor([{ op: 'patch', path: '/source', ops: { $set: { status: 'paid' } } }])
    assert.equal((await admin.nodes()).find(node => node.$path === '/source')?.status, 'paid')
  })

  it('requires the protected type own writing action and rejects read or undeclared provenance', async () => {
    const f = await setup()
    await f.commit([put('/writer', {}, 'writer')])
    const changes: ChangeMember[] = [{ op: 'patch', path: '/source', ops: { $set: { status: 'paid' } } }]
    await unchanged(f, changes, { type: 'writer', action: 'approve', path: '/writer' })
    await unchanged(f, changes, origin('inspect'), 'INVALID')
    await unchanged(f, changes, origin('missing'), 'INVALID')
    await unchanged(f, changes, { type: 'writer', action: 'approve', path: '/other' }, 'INVALID')
    await f.asActor(changes, origin('approve'))
    assert.equal((await f.nodes()).find(node => node.$path === '/source')?.status, 'paid')
  })

  it('protects named components and resolves provenance through a canonical type alias', async () => {
    const f = await setup()
    await f.commit([put('/source', { '#policy': { $type: 'locked' } }, 'locked'), put('/named', { '#policy': { $type: 'locked' } })])
    await unchanged(f, [{ op: 'patch', path: '/named', ops: { $unset: { '#policy': true } } }])
    await f.asActor([{ op: 'patch', path: '/named', ops: { $set: { value: 'allowed' } } }], { ...origin('approve'), type: 'old.locked' })
    assert.equal((await f.nodes()).find(node => node.$path === '/named')?.value, 'allowed')
  })

  it('accepts the exact post result and keeps unrelated fields unchanged', async () => {
    const f = await setup()
    await f.asActor([{ op: 'patch', path: '/source', ops: { $set: { status: 'paid' } } }], origin())
    const node = (await f.nodes()).find(node => node.$path === '/source')!
    assert.equal(node.status, 'paid'); assert.equal(node.retained, 'same')
  })

  it('rejects extra field or metadata changes even for an administrator', async () => {
    const f = await setup(all)
    await unchanged(f, [{ op: 'patch', path: '/source', ops: { $set: { status: 'paid', retained: 'different' } } }], origin())
    await unchanged(f, [{ op: 'patch', path: '/source', ops: { $set: { status: 'paid', $owner: 'u:bob' } } }], origin())
  })

  it('rejects missing declared effects even when the actual ChangeSet is empty', async () => {
    const f = await setup()
    await unchanged(f, [], origin())
    await f.asActor([], origin('unchanged'))
    assert.equal((await f.nodes()).find(node => node.$path === '/source')?.status, 'draft')
  })

  it('checks every resolved need and refuses missing, undeclared or extra writes', async () => {
    const f = await setup()
    const own: ChangeMember = { op: 'patch', path: '/source', ops: { $set: { status: 'paid' } } }
    const other: ChangeMember = { op: 'patch', path: '/other', ops: { $inc: { total: 1 } } }
    const source = origin('transfer', { other: ['/other'] })
    await unchanged(f, [own], source)
    await unchanged(f, [own, other], origin('transfer'), 'INVALID')
    await unchanged(f, [own, other], origin())
    await f.asActor([own, other], source)
    assert.equal((await f.nodes()).find(node => node.$path === '/other')?.total, 1)
  })

  it('accounts for kernel version stamping when post introduces a named component', async () => {
    const f = await setup()
    await f.asActor([{ op: 'patch', path: '/source', ops: { $set: { '#extra': { $type: 'extra' } } } }], origin('add'))
    assert.deepEqual((await f.nodes()).find(node => node.$path === '/source')?.['#extra'], { $type: 'extra', $v: 0 })
  })

  it('checks a declared move against the original node and preserves identity', async () => {
    const f = await setup(), before = (await f.nodes()).find(node => node.$path === '/source')!
    await f.asActor([{ op: 'move', from: '/source', to: '/moved' }], origin('relocate'))
    assert.equal((await f.nodes()).find(node => node.$path === '/moved')?.$id, before.$id)
  })

  it('checks a declared creation while ignoring only its kernel-issued identity', async () => {
    const f = await setup()
    await f.asActor([put('/new', { value: 7 })], origin('create', { next: ['/new'] }))
    const node = (await f.nodes()).find(node => node.$path === '/new')!
    assert.equal(node.value, 7); assert.equal(typeof node.$id, 'string')
  })

  it('refuses removal through an update post', async () => {
    const f = await setup()
    await unchanged(f, [{ op: 'remove', path: '/source' }], origin())
  })
})
