import type { PositionCounter } from '#kernel/types'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { prepareAdmin } from '#kernel/auth-module'
import { passwordPath, verifyPassword } from '#kernel/auth/crypto'
import { createInstanceFoundation } from '#kernel/instance'
import { createMemoryStore } from '#kernel/store/memory'
import { scanBudget } from '#kernel/store/contract'
import type { Position } from '#kernel/types'


function input() {
  let notify: () => void = () => {}
  const read = new Promise<void>(resolve => { notify = resolve })
  const admin = { path: '/auth/users/first', name: 'first', get password() {
    notify()
    return 'initial-test-password'
  } }
  return { admin, read }
}

describe('native first-account provisioning', { timeout: 10_000 }, () => {
  it('owns the first-account fields before hashing its password', async () => {
    const { admin, read } = input()
    const prepared = prepareAdmin(admin)
    await read
    admin.path = '/auth/users'
    admin.name = 'changed'
    const result = await prepared
    assert.equal(result.account.$path, '/auth/users/first')
    assert.equal(result.account.name, 'first')
    const password = result.passwordRecord('generated-account')
    assert.ok(typeof password.hash === 'string')
    assert.equal(await verifyPassword('initial-test-password', password.hash), true)
  })

  it('bootstraps only the checked first-account path despite mutation during hashing', async () => {
    const root = createMemoryStore({ domain: 'provisioning' })
    let saved: Position | undefined
    const counter: PositionCounter = { async load() { return saved }, async save(pos) { saved = { ...pos } },
      async freshEpoch(floor) { return floor + 1 } }
    const { admin, read } = input()
    const pending = createInstanceFoundation({ id: 'provisioning-test', root, counter, writerEpoch: 1,
      domains: [{ store: root, epoch: 'root1', persistent: true }], firstAdmin: admin, budget: scanBudget })
    await read
    admin.path = '/auth/users'
    admin.name = 'changed'
    const instance = await pending
    assert.equal(instance.bootstrap.adminPath, '/auth/users/first')
    const account = await instance.source.node('/auth/users/first')
    assert.ok(account)
    assert.equal(account.name, 'first')
    assert.equal((await instance.source.node('/auth/users'))?.$type, 't.dir')
    const password = await instance.source.node(passwordPath(account.$id))
    assert.ok(password && typeof password.hash === 'string')
    assert.equal(await verifyPassword('initial-test-password', password.hash), true)
  })
})
