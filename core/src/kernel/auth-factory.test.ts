import type { PositionCounter } from '#kernel/types'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { KernelError } from '#errors'
import { authManifest, prepareAdmin } from '#kernel/auth-module'
import { credentialPath, hashPassword, passwordPath } from '#kernel/auth/crypto'
import { createInstanceFoundation } from '#kernel/instance'
import type { AuthReadSource } from '#kernel/session'
import { createMemoryStore } from '#kernel/store/memory'
import { scanBudget } from '#kernel/store/contract'
import type { ChangeMember, ModuleManifest, Position } from '#kernel/types'


const code = (expected: KernelError['code']) => (error: unknown) => error instanceof KernelError && error.code === expected
function signal() {
  let resolve: () => void = () => {}
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

async function setup(ttlMs = 60_000) {
  const root = createMemoryStore({ domain: 'auth-factory' })
  let saved: Position | undefined
  const counter: PositionCounter = { async load() { return saved }, async save(pos) { saved = { ...pos } },
    async freshEpoch(floor) { return floor + 1 } }
  const options = { id: 'auth-factory', root, counter, writerEpoch: 1,
    domains: [{ store: root, epoch: 'root1', persistent: true }], initialCredential: { ttlMs }, budget: scanBudget }
  const instance = await createInstanceFoundation({ ...options,
    firstAdmin: { path: '/auth/users/admin', name: 'admin', password: 'admin-test-password' } })
  const auth = instance.auth, credential = instance.setupCredential
  assert.ok(auth && credential)
  const admin = await auth.openCredential(credential)
  const who = { actor: admin.actor, executor: admin.actor.principal, caller: admin.actor.principal }
  return { instance, root, options, auth, credential, admin, who }
}

async function addAccount(fixture: Awaited<ReturnType<typeof setup>>) {
  const prepared = await prepareAdmin({ path: '/auth/users/alice', name: 'alice', password: 'alice-test-password' })
  await fixture.instance.commit([{ op: 'put', node: { ...prepared.account, '#groups': { $type: 't.groups', list: ['team'] } } }], fixture.who)
  const account = await fixture.instance.source.node('/auth/users/alice')
  assert.ok(account)
  await fixture.instance.commit([{ op: 'put', node: prepared.passwordRecord(account.$id) }], fixture.who)
  return account
}

describe('native authentication factory', { timeout: 10_000 }, () => {
  it('stores the initial credential in the atomic bootstrap and returns its token only to setup', async t => {
    const { instance, root, options, auth, credential, admin } = await setup()
    t.after(() => auth.close())
    const account = await instance.source.nodeById(instance.bootstrap.adminId)
    const record = await instance.source.node(credentialPath(credential.token))
    assert.ok(account && record)
    assert.equal(record.accountId, account.$id)
    assert.deepEqual(record.$pos, account.$pos)
    assert.equal(admin.actor.principal, `u:${account.$id}`)
    const journal = (await root.scan({ range: { journal: '/' }, budget: scanBudget() })).items
    assert.equal(journal.filter(entry => entry.entries.length !== 0).length, 1)
    assert.ok(!JSON.stringify(journal).includes(credential.token))
    const reopened = await createInstanceFoundation({ ...options, writerEpoch: 2 })
    t.after(() => reopened.auth?.close())
    assert.equal(reopened.setupCredential, undefined)
    assert.ok(reopened.auth)
    assert.equal((await reopened.auth.openCredential(credential)).actor.principal, admin.actor.principal)
  })

  it('logs in through accepted password state and owns mutable login inputs before waiting', async t => {
    const fixture = await setup()
    t.after(() => fixture.auth.close())
    const account = await addAccount(fixture), scope = ['/work']
    const input = { account: account.$path, password: 'alice-test-password', scope }
    const pending = fixture.auth.login(input)
    input.account = '/missing'
    input.password = 'wrong'
    scope.push('/secret')
    const credential = await pending
    const admission = await fixture.auth.openCredential(credential, 'observed-client')
    assert.equal(admission.actor.principal, `u:${account.$id}`)
    assert.deepEqual(admission.actor.claims, [`u:${account.$id}`, 'public', 'authenticated', 'team'])
    assert.deepEqual(admission.actor.scope, ['/work'])
    assert.equal(admission.origin, 'observed-client')
    const journal = (await fixture.root.scan({ range: { journal: '/' }, budget: scanBudget() })).items
    const issuance = journal.find(entry => entry.entries.some(change => change.path === credentialPath(credential.token)))
    assert.ok(issuance)
    assert.equal(issuance.executor, 'kernel')
    assert.equal(issuance.caller, 'kernel')
    assert.equal(issuance.entries.length, 1)
    assert.ok(!JSON.stringify(issuance).includes(credential.token))
    assert.ok(!JSON.stringify(issuance).includes('alice-test-password'))
  })

  it('rejects wrong, missing, blocked and pending accounts without issuing a credential', async t => {
    const fixture = await setup()
    t.after(() => fixture.auth.close())
    const account = await addAccount(fixture)
    const before = (await fixture.root.scan({ range: { children: '/auth/sessions' }, budget: scanBudget() })).items.length
    await assert.rejects(fixture.auth.login({ account: account.$path, password: 'wrong' }), code('UNAUTHENTICATED'))
    await assert.rejects(fixture.auth.login({ account: '/missing', password: 'alice-test-password' }), code('UNAUTHENTICATED'))
    for (const status of ['blocked', 'pending']) {
      await fixture.instance.commit([{ op: 'patch', path: account.$path, ops: { $set: { status } } }], fixture.who)
      await assert.rejects(fixture.auth.login({ account: account.$path, password: 'alice-test-password' }), code('UNAUTHENTICATED'))
    }
    assert.equal((await fixture.root.scan({ range: { children: '/auth/sessions' }, budget: scanBudget() })).items.length, before)
  })

  it('rechecks status, identity and password state in Writer order after password verification', async t => {
    for (const change of ['status', 'hash', 'password-id', 'account-id']) {
      const fixture = await setup()
      t.after(() => fixture.auth.close())
      const account = await addAccount(fixture), started = signal(), release = signal()
      const original = fixture.instance.source.read
      let first = true
      const mock = t.mock.method(fixture.instance.source, 'read', function<T>(run: (read: AuthReadSource) => Promise<T>): Promise<T> {
        return original(async read => {
          const result = await run(read)
          if (first) { first = false; started.resolve(); await release.promise }
          return result
        })
      })
      const pending = fixture.auth.login({ account: account.$path, password: 'alice-test-password' })
      await started.promise
      const password = await fixture.root.scan({ range: { node: passwordPath(account.$id) }, budget: scanBudget() })
      const record = password.items[0]
      assert.ok(record && typeof record.hash === 'string')
      let changes: readonly ChangeMember[]
      if (change === 'status') changes = [{ op: 'patch', path: account.$path, ops: { $set: { status: 'blocked' } } }]
      else if (change === 'hash') changes = [{ op: 'patch', path: record.$path, ops: { $set: { hash: await hashPassword('replacement') } } }]
      else if (change === 'password-id') changes = [{ op: 'remove', path: record.$path }, { op: 'put', node: {
        $path: record.$path, $type: 't.credentials', accountId: account.$id, hash: record.hash } }]
      else changes = [{ op: 'remove', path: account.$path }, { op: 'put', node: {
        $path: account.$path, $type: 't.user', name: 'alice', status: 'active' } }]
      const mutation = fixture.instance.commit(changes, fixture.who)
      release.resolve()
      await mutation
      await assert.rejects(pending, code('UNAUTHENTICATED'))
      mock.mock.restore()
      assert.equal((await fixture.root.scan({ range: { children: '/auth/sessions' }, budget: scanBudget() })).items.length, 1)
    }
  })

  it('closes only the credential whose authorization changed and preserves rename-only dependencies', async t => {
    const fixture = await setup()
    t.after(() => fixture.auth.close())
    const account = await addAccount(fixture)
    const first = await fixture.auth.login({ account: account.$path, password: 'alice-test-password' })
    const second = await fixture.auth.login({ account: account.$path, password: 'alice-test-password' })
    const a = await fixture.auth.openCredential(first), b = await fixture.auth.openCredential(second)
    const input = a.dependency(), key = a.dependencyKey
    await fixture.instance.commit([{ op: 'patch', path: account.$path, ops: { $set: { name: 'renamed' } } },
      { op: 'move', from: account.$path, to: '/auth/users/renamed' }], fixture.who)
    assert.equal(a.signal.aborted, false)
    assert.equal(b.signal.aborted, false)
    await fixture.instance.source.read(read => a.validate(read))
    assert.equal(a.dependency(), input)
    assert.equal(a.dependencyKey, key)
    assert.ok(Object.isFrozen(input) && Object.isFrozen(input.sources))
    assert.ok(input.sources.every(dep => !('rev' in dep) && !('path' in dep)))
    await fixture.instance.commit([{ op: 'patch', path: credentialPath(first.token), ops: { $set: { scope: ['/limited'] } } }], fixture.who)
    assert.equal(a.signal.aborted, true)
    assert.equal(b.signal.aborted, false)
    assert.throws(() => a.assertActive(), code('UNAUTHENTICATED'))
    const narrowed = await fixture.auth.openCredential(first)
    assert.deepEqual(narrowed.actor.scope, ['/limited'])
    await fixture.instance.commit([{ op: 'patch', path: credentialPath(second.token), ops: { $set: { revoked: true } } }], fixture.who)
    assert.equal(b.signal.aborted, true)
    assert.equal(narrowed.signal.aborted, false)
    await fixture.instance.commit([{ op: 'patch', path: '/auth/users/renamed', ops: { $set: { '#groups.list': ['other'] } } }], fixture.who)
    assert.equal(narrowed.signal.aborted, true)
    assert.deepEqual((await fixture.auth.openCredential(first)).actor.claims, [`u:${account.$id}`, 'public', 'authenticated', 'other'])
  })

  it('registers lifetime dependencies before the resolution read barrier releases', async t => {
    const fixture = await setup()
    t.after(() => fixture.auth.close())
    const account = await addAccount(fixture), token = await fixture.auth.login({ account: account.$path, password: 'alice-test-password' })
    const started = signal(), release = signal(), original = fixture.instance.source.read
    const mock = t.mock.method(fixture.instance.source, 'read', function<T>(run: (read: AuthReadSource) => Promise<T>): Promise<T> {
      return original(async read => { const result = await run(read); started.resolve(); await release.promise; return result })
    })
    const pending = fixture.auth.openCredential(token)
    await started.promise
    const mutation = fixture.instance.commit([{ op: 'patch', path: credentialPath(token.token), ops: { $set: { revoked: true } } }], fixture.who)
    release.resolve()
    const admission = await pending
    await mutation
    mock.mock.restore()
    assert.equal(admission.signal.aborted, true)
    assert.throws(() => admission.assertActive(), code('UNAUTHENTICATED'))
  })

  it('expires idle admissions at the boundary and preserves a signed anonymous identity on reconnect', async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 })
    const fixture = await setup(1000)
    t.after(() => fixture.auth.close())
    const anon = await fixture.auth.openCredential()
    assert.ok(anon.resolution.credential)
    const reconnect = await fixture.auth.openCredential(anon.resolution.credential)
    assert.equal(reconnect.actor.principal, anon.actor.principal)
    assert.deepEqual(anon.actor.claims, [anon.actor.principal, 'public'])
    t.mock.timers.tick(999)
    assert.equal(anon.signal.aborted, false)
    assert.equal(fixture.admin.signal.aborted, false)
    t.mock.timers.tick(1)
    assert.equal(anon.signal.aborted, true)
    assert.equal(reconnect.signal.aborted, true)
    assert.equal(fixture.admin.signal.aborted, true)
    await assert.rejects(fixture.auth.openCredential(anon.resolution.credential), code('UNAUTHENTICATED'))
  })

  it('checks current expiry before work even when expiry callbacks have not run', async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 })
    const fixture = await setup(1000)
    t.after(() => fixture.auth.close())
    t.mock.timers.setTime(2000)
    assert.equal(fixture.admin.signal.aborted, false)
    assert.throws(() => fixture.admin.assertActive(), code('UNAUTHENTICATED'))
    assert.equal(fixture.admin.signal.aborted, true)
    await assert.rejects(fixture.instance.source.read(read => fixture.admin.validate(read)), code('UNAUTHENTICATED'))
  })

  it('opens local declared node principals and closes them after actual registry publication', async t => {
    const fixture = await setup()
    t.after(() => fixture.auth.close())
    const module: ModuleManifest = { id: 'factory-form', types: [{ name: 'test.form', module: 'factory-form', security: 'user-capability',
      version: 0, schema: {}, actions: { submit: { kind: 'setuid', args: {}, handler: async () => undefined } } }], security: [], open: [] }
    await fixture.instance.commit([{ op: 'put', node: { $path: '/sys/types/test.form', $type: 't.type', name: 'test.form',
      module: module.id, security: 'user-capability' } }], fixture.who)
    fixture.instance.registry.publish(module)
    await fixture.instance.commit([{ op: 'put', node: { $path: '/form', $type: 'test.form' } }], fixture.who)
    const node = await fixture.instance.source.node('/form')
    assert.ok(node)
    const admission = await fixture.auth.openNode('/form')
    assert.equal(admission.actor.principal, `n:${node.$id}`)
    assert.deepEqual(admission.actor.claims, [`n:${node.$id}`])
    fixture.instance.registry.publish({ ...module, types: module.types.map(type => ({ ...type, version: 1 })) })
    assert.equal(admission.signal.aborted, true)
    assert.equal(fixture.admin.signal.aborted, false)
    await assert.rejects(fixture.auth.openNode(fixture.instance.bootstrap.adminPath), code('INVALID'))
  })

  it('preserves canonical group claims when an unused alias changes in the registry', async t => {
    const fixture = await setup()
    t.after(() => fixture.auth.close())
    const account = await addAccount(fixture), alias = 't.group-binding'
    await fixture.instance.commit([{ op: 'put', node: { $path: `/sys/types/${alias}`, $type: 't.type', name: alias,
      module: authManifest.id, security: 'ordinary' } }], fixture.who)
    fixture.instance.registry.publish({ ...authManifest,
      types: authManifest.types.map(type => type.name === 't.groups' ? { ...type, aliases: [alias] } : type) })
    await fixture.instance.commit([{ op: 'patch', path: account.$path, ops: { $set: {
      '#groups': { $type: alias, list: ['team'] } } } }], fixture.who)
    const token = await fixture.auth.login({ account: account.$path, password: 'alice-test-password' })
    const admission = await fixture.auth.openCredential(token)
    assert.ok(admission.actor.claims.includes('team'))
    assert.equal((await fixture.instance.source.nodeById(account.$id))?.['#groups'].$type, 't.groups')
    fixture.instance.registry.publish(authManifest)
    assert.equal((await fixture.auth.openCredential(token)).actor.claims.includes('team'), true)
    assert.equal(admission.signal.aborted, false)
    await fixture.instance.source.read(read => admission.validate(read))
  })

  it('preserves a closed admission reason when its in-flight source read rejects later', async t => {
    const fixture = await setup()
    t.after(() => fixture.auth.close())
    const entered = signal(), release = signal()
    const cancelled = new KernelError('CANCELLED', 'Owner ended admission')
    const failure = new KernelError('UNAVAILABLE', 'Late source failure')
    const logged = t.mock.method(console, 'error', () => {})
    const validation = fixture.instance.source.read(read => fixture.admin.validate({ ...read,
      async nodeById(id) {
        assert.ok(await read.nodeById(id))
        entered.resolve()
        await release.promise
        throw failure
      },
    }))
    const refused = assert.rejects(validation, error => error === cancelled)
    await entered.promise
    fixture.admin.close(cancelled)
    release.resolve()
    await refused
    assert.equal(fixture.admin.signal.reason, cancelled)
    assert.equal(logged.mock.callCount(), 0)
    assert.throws(() => fixture.admin.assertActive(), error => error === cancelled)
  })

  it('propagates auth-source failures and aborts the admission before releasing an operation', async t => {
    const fixture = await setup()
    t.after(() => fixture.auth.close())
    const failure = new KernelError('BUDGET', 'Injected auth source failure')
    const logged = t.mock.method(console, 'error', () => {})
    await assert.rejects(fixture.instance.source.read(read => fixture.admin.validate({ ...read,
      nodeById: async () => { throw failure } })), error => error === failure)
    assert.equal(fixture.admin.signal.aborted, true)
    assert.equal(logged.mock.callCount(), 1)
    assert.throws(() => fixture.admin.assertActive(), error => error === failure)
  })
})
