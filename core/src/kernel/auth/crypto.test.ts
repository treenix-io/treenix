import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { KernelError } from '#errors'
import { credentialPath, credentialScope, hashPassword, signAnonymous, tokenHash, verifyAnonymous, verifyPassword } from '#kernel/auth/crypto'

const key = 'ab'.repeat(32)
const code = (expected: KernelError['code']) => (error: unknown) => error instanceof KernelError && error.code === expected

describe('native credential cryptography', () => {
  it('salts passwords and compares valid hashes without accepting another password', async () => {
    const hash = await hashPassword('correct-password')
    assert.equal(await verifyPassword('correct-password', hash), true)
    assert.equal(await verifyPassword('wrong-password', hash), false)
    assert.notEqual(await hashPassword('correct-password'), hash)
    await assert.rejects(verifyPassword('correct-password', 'malformed'), code('INVALID'))
  })

  it('binds anonymous identity and scope to the persistent instance key and expiry', () => {
    const identity = { instance: 'instance-a', id: '12'.repeat(16), issuedAt: 1000, expiresAt: 2000, scope: ['/safe'] }
    const token = signAnonymous(identity, key)
    const [, body] = token.split('.')
    assert.deepEqual(verifyAnonymous(token, key, 'instance-a', 1999), identity)
    for (const [credential, signingKey, instance, now] of [
      [token + 'x', key, 'instance-a', 1999],
      [`anon.${body}.${'é'.repeat(43)}`, key, 'instance-a', 1999],
      [token, 'cd'.repeat(32), 'instance-a', 1999],
      [token, key, 'instance-b', 1999],
      [token, key, 'instance-a', 2000],
      [token, key, 'instance-a', 999],
    ] as const) assert.throws(() => verifyAnonymous(credential, signingKey, instance, now), code('UNAUTHENTICATED'))
  })

  it('stores only a one-way bearer digest and copies scopes without silently dropping entries', () => {
    const token = 'ef'.repeat(32), scope = ['/safe', '/safe']
    assert.equal(credentialPath(token), `/auth/sessions/${tokenHash(token)}`)
    assert.ok(!credentialPath(token).includes(token))
    const copied = credentialScope(scope)
    scope.push('/later')
    assert.deepEqual(copied, ['/safe'])
    assert.ok(Object.isFrozen(copied))
    assert.deepEqual(credentialScope([]), [])
    assert.throws(() => credentialScope(['/safe', 1]), code('INVALID'))
    assert.throws(() => credentialScope(null), code('INVALID'))
  })
})
