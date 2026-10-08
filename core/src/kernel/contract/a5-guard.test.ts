import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { KernelError } from '#errors'
import { createGuard } from '#kernel/guard'
import { readJournalImages } from '#kernel/journal'
import { createRegistry } from '#kernel/registry'
import { fixture, put } from '#kernel/contract/changeset-fixture'
import { A, R, W, type Actor, type AclEntry, type ChangeMember, type Registry, type RightsRule, type StoredNode } from '#kernel/types'

const actor: Actor = { principal: 'u:alice', claims: ['u:alice', 'users'] }
const who = { executor: actor.principal, caller: actor.principal, actor }
const all = R | W | A
const grant = (bits: number): AclEntry => ({ subject: { group: 'users' }, grant: bits })
const deny = (bits: number): AclEntry => ({ subject: { group: 'users' }, deny: bits })
const code = (expected: KernelError['code']) => (error: unknown) => error instanceof KernelError && error.code === expected

function registry(rule?: RightsRule) {
  const result = createRegistry()
  result.publish({ id: 'test', open: [], types: [
    { name: 'dir', module: 'test', security: 'ordinary', version: 0, schema: {}, actions: {} },
    { name: 'item', aliases: ['old.item'], module: 'test', security: 'ordinary', version: 1,
      schema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] }, actions: {} },
    { name: 'limit', aliases: ['old.limit'], module: 'test', security: 'ordinary', version: 0, schema: {}, actions: {} },
  ], security: [{ type: 'limit', context: 'acl', handler: rule ?? (() => R | W) }] })
  return result
}
async function setup(bits = R | W, types?: Registry) {
  const f = await fixture(types === undefined ? {} : { registry: types })
  await f.commit([put('/', { $acl: [grant(bits)] }, 'dir')])
  return { ...f, asActor: (changes: readonly ChangeMember[]) => f.commit(changes, who) }
}
async function unchanged(f: Awaited<ReturnType<typeof setup>>, changes: readonly ChangeMember[], expected: KernelError['code'] = 'FORBIDDEN') {
  const nodes = await f.nodes(), journal = await f.journal()
  await assert.rejects(f.asActor(changes), code(expected))
  assert.deepEqual(await f.nodes(), nodes); assert.deepEqual(await f.journal(), journal)
}

describe('result guards', () => {
  it('rejects writes and owner forgery by a reader without changing data or journal', async () => {
    const f = await setup(R)
    await f.commit([put('/item', { value: 'original', $owner: 'u:bob' })])
    await unchanged(f, [{ op: 'put', node: { $path: '/item', $type: 'item', value: 'changed' } }])
    await unchanged(f, [{ op: 'patch', path: '/item', ops: { $set: { $owner: actor.principal } } }])
    await unchanged(f, [{ op: 'remove', path: '/item' }])
    await unchanged(f, [put('/new')])
  })

  it('allows W-only creation and mutation without assigning an owner', async () => {
    const f = await setup(W)
    await f.asActor([put('/item', { count: 1 })])
    await f.asActor([{ op: 'patch', path: '/item', ops: { $inc: { count: 1 } } }])
    const node = (await f.nodes()).find(node => node.$path === '/item')!
    assert.equal(node.count, 2); assert.equal(Object.hasOwn(node, '$owner'), false)
    await f.asActor([{ op: 'remove', path: '/item' }])
    assert.equal((await f.nodes()).some(node => node.$path === '/item'), false)
  })

  it('preserves hidden ACL and owner on a full replacement and keeps ordinary nested data', async () => {
    const f = await setup(), acl = [grant(R | W)]
    await f.commit([put('/item', { value: 'old', $acl: acl, $owner: 'u:bob' })])
    const before = (await f.nodes()).find(node => node.$path === '/item')!
    await f.asActor([put('/item', { value: 'new', snapshot: { $type: 'plain', retained: 7 } })])
    const after = (await f.nodes()).find(node => node.$path === '/item')!
    assert.equal(after.$id, before.$id); assert.equal(after.value, 'new')
    assert.deepEqual(after.$acl, acl); assert.equal(after.$owner, 'u:bob')
    assert.deepEqual(after.snapshot, { $type: 'plain', retained: 7 })
  })

  it('denies explicit ACL and owner changes, nested edits and unsets without A', async () => {
    const f = await setup()
    await f.commit([put('/item', { $acl: [grant(R | W)], $owner: 'u:bob' })])
    for (const changes of [
      [put('/item', { $acl: [grant(all)] })], [put('/item', { $owner: actor.principal })],
      [{ op: 'patch', path: '/item', ops: { $set: { '$acl.0.grant': all } } }],
      [{ op: 'patch', path: '/item', ops: { $unset: { $acl: true } } }],
      [{ op: 'patch', path: '/item', ops: { $unset: { $owner: true } } }],
    ] satisfies readonly ChangeMember[][]) await unchanged(f, changes)
  })

  it('allows valid metadata changes with W and A', async () => {
    const f = await setup(all)
    await f.commit([put('/item')])
    await f.asActor([{ op: 'patch', path: '/item', ops: { $set: { $acl: [grant(R)], $owner: 'u:bob' } } }])
    const node = (await f.nodes()).find(node => node.$path === '/item')!
    assert.deepEqual(node.$acl, [grant(R)]); assert.equal(node.$owner, 'u:bob')
  })

  it('requires parent A to set metadata on a new node', async () => {
    const f = await setup()
    await unchanged(f, [put('/acl', { $acl: [grant(R | W)] })])
    await unchanged(f, [put('/owner', { $owner: actor.principal })])
    const allowed = await setup(all)
    await allowed.asActor([put('/item', { $owner: actor.principal, $acl: [grant(R)] })])
    assert.equal((await allowed.nodes()).find(node => node.$path === '/item')?.$owner, actor.principal)
  })

  it('requires A to add or remove rule-bearing types from an existing object', async () => {
    const f = await setup(R | W, registry())
    await f.commit([put('/item', { value: 'original' }), put('/limited', { value: 'original', '#limit': { $type: 'limit' } })])
    await unchanged(f, [{ op: 'patch', path: '/item', ops: { $set: { '#limit': { $type: 'limit' } } } }])
    await unchanged(f, [{ op: 'patch', path: '/limited', ops: { $unset: { '#limit': true } } }])
  })

  it('permits a rule-bearing type on creation and preserves its canonical type set through alias or component renaming', async () => {
    const f = await setup(R | W, registry())
    await f.asActor([put('/new', {}, 'limit')])
    await f.commit([put('/item', { value: 'original', '#one': { $type: 'limit' } })])
    await f.asActor([put('/item', { value: 'changed', '#two': { $type: 'old.limit' } })])
    const node = (await f.nodes()).find(node => node.$path === '/item')!
    assert.equal(node['#two'].$type, 'limit'); assert.equal(Object.hasOwn(node, '#one'), false)
    assert.equal(node.value, 'changed')
  })

  it('denies an entire subtree removal when a descendant denies W, including behind absent parents', async () => {
    const f = await setup()
    await f.commit([put('/folder', {}, 'dir'), put('/folder/allowed'), put('/folder/gap/deep', { $acl: [deny(W)] })])
    await unchanged(f, [{ op: 'remove', path: '/folder' }])
  })

  it('checks old subtree rights and destination placement separately for relocation', async () => {
    const f = await setup()
    await f.commit([put('/source', {}, 'dir'), put('/source/child'), put('/denied', { $acl: [deny(W)] }, 'dir')])
    await unchanged(f, [{ op: 'move', from: '/source', to: '/denied/new' }])
    await f.commit([{ op: 'patch', path: '/source/child', ops: { $set: { $acl: [deny(W)] } } }])
    await unchanged(f, [{ op: 'move', from: '/source', to: '/new' }])
  })

  it('requires destination parent A when moving an ACL or owner boundary', async () => {
    const f = await setup()
    await f.commit([put('/destination', {}, 'dir'), put('/source', { $acl: [grant(all)] }, 'dir')])
    await unchanged(f, [{ op: 'move', from: '/source', to: '/destination/new' }])
    await f.commit([put('/owned', { $owner: 'u:bob', $acl: [grant(all)] })])
    await unchanged(f, [{ op: 'move', from: '/owned', to: '/destination/owned' }])
  })

  it('preserves hidden metadata when a move precedes a full write in the same batch', async () => {
    const f = await setup(R | W, registry()), acl = [grant(R | W)]
    await f.commit([put('/destination', { $acl: [grant(all)] }, 'dir'),
      put('/source', { value: 'old', $owner: 'u:bob', $acl: acl, '#rule': { $type: 'limit' } })])
    const before = (await f.nodes()).find(node => node.$path === '/source')!
    await f.asActor([{ op: 'move', from: '/source', to: '/destination/item' },
      put('/destination/item', { value: 'new', '#rule': { $type: 'limit' } })])
    const after = (await f.nodes()).find(node => node.$path === '/destination/item')!
    assert.equal(after.$id, before.$id); assert.equal(after.value, 'new')
    assert.deepEqual(after.$acl, acl); assert.equal(after.$owner, 'u:bob')
  })

  it('allows an ordinary move with W and enforces actor scope at placement', async () => {
    const f = await setup()
    await f.commit([put('/team', {}, 'dir'), put('/team/item', { value: 1 }), put('/outside', {}, 'dir')])
    const scoped: Actor = { ...actor, scope: ['/team'] }
    await assert.rejects(f.commit([{ op: 'move', from: '/team/item', to: '/outside/item' }],
      { ...who, actor: scoped }), code('FORBIDDEN'))
    await f.asActor([{ op: 'move', from: '/team/item', to: '/team/new' }])
    assert.equal((await f.nodes()).find(node => node.$path === '/team/new')?.value, 1)
  })

  it('uses rights before the whole batch when an earlier owner change would make a child writable', async () => {
    const f = await setup(all, registry(input => input.owner === actor.principal ? all : R))
    await f.commit([put('/folder', { $owner: 'u:bob' }, 'dir'), put('/folder/item', { value: 'original', '#rule': { $type: 'limit' } })])
    await unchanged(f, [
      { op: 'patch', path: '/folder', ops: { $set: { $owner: actor.principal } } },
      { op: 'patch', path: '/folder/item', ops: { $set: { value: 'changed' } } },
    ])
  })

  it('applies an inherited system-space deny even under a permissive root', async () => {
    const f = await setup()
    await f.commit([put('/sys', { $acl: [deny(W)] }, 'dir')])
    await unchanged(f, [put('/sys/autostart/evil')])
  })

  it('validates the final main and named component shapes atomically', async () => {
    const f = await setup(R | W, registry())
    await f.commit([put('/item', { value: 'original' })])
    await unchanged(f, [{ op: 'patch', path: '/item', ops: { $set: { value: 7 } } }], 'INVALID')
    await unchanged(f, [put('/new', { value: 'valid', '#broken': { $type: 'item', value: 7 } })], 'INVALID')
    await f.asActor([{ op: 'patch', path: '/item', ops: { $unset: { value: true } } },
      { op: 'patch', path: '/item', ops: { $set: { value: 'valid' } } }])
    assert.equal((await f.nodes()).find(node => node.$path === '/item')?.value, 'valid')
  })

  it('keeps identity and type immutable while permitting a canonical alias', async () => {
    const f = await setup(all), before = (await f.nodes())[0]
    const guard = createGuard({ registry: f.registry, executor: 'kernel', readBefore: async () => before })
    await assert.rejects(guard.transition(before, { ...before, $id: 'different' }), code('INVALID'))
    await assert.rejects(guard.transition(before, { ...before, $type: 'item', $v: 1 }), code('INVALID'))
    const item: StoredNode = { ...before, $type: 'old.item', $v: 1 }
    await guard.transition(item, { ...item, $type: 'item' })
    assert.equal(item.$type, 'old.item')
  })

  it('checks only identity invariants for an accepted external reconciliation', async () => {
    const f = await setup(), before = (await f.nodes())[0]
    const guard = createGuard({ registry: f.registry, executor: 'external:memory', readBefore: async () => before })
    const after = { ...before, $owner: undefined }
    Object.defineProperty(after, '#broken', { value: 7, enumerable: true })
    await guard.transition(before, after)
    await assert.rejects(guard.transition(before, { ...before, $id: 'different' }), code('INVALID'))
    assert.equal(before.$type, 'dir')
  })
})

describe('journal restoration guards', () => {
  it('hides a journal record from a W holder without A and restores it for an A holder', async () => {
    const f = await setup()
    await f.commit([put('/item', { value: 1 })])
    const item = (await f.nodes()).find(node => node.$path === '/item')!
    const removed = await f.commit([{ op: 'remove', path: '/item' }])
    await unchanged(f, [{ op: 'restore', record: { pos: removed, id: item.$id } }], 'NOT_FOUND')
    await f.commit([{ op: 'patch', path: '/', ops: { $set: { $acl: [grant(all)] } } }])
    await f.asActor([{ op: 'restore', record: { pos: removed, id: item.$id } }])
    assert.equal((await f.nodes()).find(node => node.$path === '/item')?.$id, item.$id)
  })

  it('applies historical type rules even when the deleted path is now administrable', async () => {
    const f = await setup(all, registry(() => R | W))
    await f.commit([put('/item', { value: 'secret', '#rule': { $type: 'limit' } })])
    const item = (await f.nodes()).find(node => node.$path === '/item')!
    const removed = await f.commit([{ op: 'remove', path: '/item' }])
    await unchanged(f, [{ op: 'restore', record: { pos: removed, id: item.$id } }], 'NOT_FOUND')
  })

  it('requires journal visibility on both paths of a historical move', async () => {
    const f = await setup(all)
    await f.commit([put('/from', {}, 'dir'), put('/to', {}, 'dir'), put('/from/item')])
    const item = (await f.nodes()).find(node => node.$path === '/from/item')!
    const moved = await f.commit([{ op: 'move', from: '/from/item', to: '/to/item' }])
    await f.commit([{ op: 'remove', path: '/to/item' }])
    await f.commit([{ op: 'patch', path: '/', ops: { $set: { $acl: [grant(R | W)] } } },
      { op: 'patch', path: '/from', ops: { $set: { $acl: [grant(all)] } } }])
    await unchanged(f, [{ op: 'restore', record: { pos: moved, id: item.$id } }], 'NOT_FOUND')
  })

  it('converges old stored bases on patch, move and restore while the journal retains their raw before-images', async () => {
    const types = createRegistry()
    const publish = (version: number) => types.publish({ id: 'test', open: [], types: [
      { name: 'dir', module: 'test', security: 'ordinary', version: 0, schema: {}, actions: {} },
      { name: 'item', module: 'test', security: 'ordinary', version,
        schema: { type: 'object', properties: { [version === 0 ? 'text' : 'body']: { type: 'string' } }, required: [version === 0 ? 'text' : 'body'] }, actions: {} },
    ], security: version === 0 ? [] : [{ type: 'item', context: 'migrate', handler: [{ from: 0, to: 1, up: component => {
      const { text, ...fields } = component
      return { ...fields, body: text }
    } }] }] })
    publish(0)
    const f = await setup(all, types)
    await f.commit([put('/patched', { text: 'old' }), put('/moved', { text: 'old' }), put('/restored', { text: 'old' })])
    const before = await f.nodes(), restored = before.find(node => node.$path === '/restored')!
    const removed = await f.commit([{ op: 'remove', path: '/restored' }])
    publish(1)
    const pos = await f.asActor([{ op: 'patch', path: '/patched', ops: { $set: { body: 'new' } } },
      { op: 'move', from: '/moved', to: '/new' }, { op: 'restore', record: { pos: removed, id: restored.$id } }])
    const after = await f.nodes(), records = await f.journal()
    for (const path of ['/patched', '/new', '/restored']) {
      const node = after.find(node => node.$path === path)!
      assert.equal(node.$v, 1); assert.equal(Object.hasOwn(node, 'text'), false)
      assert.equal(node.body, path === '/patched' ? 'new' : 'old')
      if (path !== '/restored') assert.deepEqual(readJournalImages(records, { pos, id: node.$id }).before, before.find(prior => prior.$id === node.$id))
    }
    await unchanged(f, [put('/stale', { body: 'valid', $v: 0 })], 'INVALID')
  })
})
