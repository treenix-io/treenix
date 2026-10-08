import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { KernelError } from '#errors'
import { authManifest, authKeyInput, prepareAdmin } from '#kernel/auth-module'
import { prepareCredential } from '#kernel/auth/credentials'
import { fixture, put } from '#kernel/contract/changeset-fixture'
import { createRegistry } from '#kernel/registry'
import { createChainIndex } from '#kernel/chain-index'
import { computeRights } from '#kernel/rights'
import { createProjector } from '#kernel/projection'
import { A, R, W, type Actor, type ChangeMember, type NodeInput } from '#kernel/types'

const code = (expected: KernelError['code']) => (error: unknown) => error instanceof KernelError && error.code === expected
const delegated: Actor = { principal: 'u:delegate', claims: ['u:delegate', 'delegates', 'public', 'authenticated'] }

async function setup() {
  const registry = createRegistry()
  registry.publish(authManifest)
  registry.publish({ id: 'test', security: [], open: [], types: ['dir', 'item'].map(name =>
    ({ name, module: 'test', security: 'ordinary', schema: {}, version: 0, actions: {} })) })
  const f = await fixture({ registry })
  await f.commit([
    put('/', { $acl: [{ subject: { group: 'admins' }, grant: R | W | A }, { subject: { group: 'delegates' }, grant: R | W }] }, 'dir'),
    put('/delegated', { $acl: [{ subject: { group: 'delegates' }, grant: A }] }, 'dir'),
  ])
  const asDelegate = (changes: readonly ChangeMember[]) => f.commit(changes,
    { executor: delegated.principal, caller: delegated.principal, actor: delegated })
  return { ...f, asDelegate }
}

describe('native authentication records', () => {
  const records: readonly NodeInput[] = [
    { $path: '/delegated/user', $type: 't.user', name: 'forged', status: 'active' },
    { $path: '/delegated/groups', $type: 't.groups', list: ['admins'] },
    { ...prepareCredential('known-account', { expiresAt: Number.MAX_SAFE_INTEGER }).node, $path: '/delegated/session' },
    { ...authKeyInput('test'), $path: '/delegated/key' },
    { $path: '/delegated/credentials', $type: 't.credentials', accountId: 'known-account', hash: '0'.repeat(32) + ':' + '0'.repeat(128) },
  ]
  for (const node of records) it(`refuses delegated creation of ${node.$type}`, async () => {
    const f = await setup(), before = await f.nodes(), journal = await f.journal()
    await assert.rejects(f.asDelegate([{ op: 'put', node }]), code('FORBIDDEN'))
    assert.deepEqual(await f.nodes(), before)
    assert.deepEqual(await f.journal(), journal)
  })

  it('refuses protected named components and subtree removal or move by delegated A', async () => {
    const f = await setup()
    await f.commit([put('/delegated/folder', {}, 'dir'), put('/delegated/folder/user',
      { name: 'account', status: 'active', '#groups': { $type: 't.groups', list: ['admins'] } }, 't.user')])
    const before = await f.nodes(), journal = await f.journal()
    for (const changes of [
      [put('/delegated/ordinary', { '#membership': { $type: 't.groups', list: ['admins'] } })],
      [{ op: 'remove', path: '/delegated/folder' }],
      [{ op: 'move', from: '/delegated/folder', to: '/delegated/moved' }],
    ] satisfies readonly (readonly ChangeMember[])[]) {
      await assert.rejects(f.asDelegate(changes), code('FORBIDDEN'))
      assert.deepEqual(await f.nodes(), before)
      assert.deepEqual(await f.journal(), journal)
    }
  })

  it('rejects reserved membership as a whole at the native schema boundary', async () => {
    const f = await setup(), before = await f.nodes()
    for (const group of ['public', 'authenticated', 'u:other', 'n:other', 'anon:other', '']) {
      await assert.rejects(f.commit([put('/bad', { list: ['allowed', group] }, 't.groups')]), code('INVALID'))
      assert.deepEqual(await f.nodes(), before)
    }
  })

  it('keeps password, signing key and bearer records invisible even to root admin', async () => {
    const f = await setup()
    const admin = await prepareAdmin({ path: '/admin', name: 'admin', password: 'admin-test-password' })
    await f.commit([{ op: 'put', node: admin.account }])
    const account = (await f.nodes()).find(node => node.$path === '/admin')!
    const credential = prepareCredential(account.$id, { expiresAt: Number.MAX_SAFE_INTEGER })
    await f.commit([admin.passwordRecord(account.$id), credential.node, authKeyInput('test')].map(node => ({ op: 'put', node })))
    const nodes = await f.nodes(), index = createChainIndex()
    for (const node of nodes) index.put(node)
    const actor: Actor = { principal: `u:${account.$id}`, claims: [`u:${account.$id}`, 'admins', 'public', 'authenticated'] }
    const project = createProjector({ registry: f.registry, alert: (path, error) => { throw error } })
    for (const node of nodes) if (['t.credentials', 't.session', 't.auth-key'].includes(node.$type)) {
      const rights = computeRights(actor, index.chain(node.$path), f.registry)
      assert.equal(rights.bits, W)
      assert.equal(project(node, rights.bits), null)
    }
    assert.equal(computeRights(actor, index.chain('/admin'), f.registry).bits, R | W | A)
  })
})
