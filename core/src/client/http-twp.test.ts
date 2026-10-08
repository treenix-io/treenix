import assert from 'node:assert/strict'
import { once } from 'node:events'
import { describe, it, type TestContext } from 'node:test'
import { openTwpHttp } from '#client/http-twp'
import { createTwpClient } from '#client/twp'
import { KernelError } from '#errors'
import { createInstanceFoundation } from '#kernel/instance'
import { scanBudget } from '#kernel/store/contract'
import { createMemoryStore } from '#kernel/store/memory'
import type { Credential, Position } from '#kernel/types'
import { createTwpHttpServer } from '#server/http-twp'

const code = (expected: KernelError['code']) => (error: unknown) => error instanceof KernelError && error.code === expected

async function setup(t: TestContext) {
  const root = createMemoryStore({ domain: 'http-client' })
  let saved: Position | undefined
  const instance = await createInstanceFoundation({ id: 'http-client', root, writerEpoch: 1,
    domains: [{ store: root, epoch: 'client1', persistent: true }], counter: {
      async load() { return saved }, async save(pos) { saved = pos }, async freshEpoch(floor) { return floor + 1 },
    }, budget: scanBudget, firstAdmin: { path: '/admin', name: 'admin', password: 'http-client-password' },
    initialCredential: { ttlMs: 60_000 } })
  assert.ok(instance.setupCredential)
  const credential = instance.setupCredential
  const http = createTwpHttpServer({ instance, allowedOrigins: ['http://client.test'], credentialTtlMs: 60_000 })
  t.after(async () => { await http.close(); instance.auth.close() })
  http.server.listen(0, '127.0.0.1'); await once(http.server, 'listening')
  const address = http.server.address(); assert.ok(address !== null && typeof address === 'object')
  const url = `http://127.0.0.1:${address.port}`
  const connection = await openTwpHttp({ url, credential })
  const client = createTwpClient(connection, { close: connection.close })
  t.after(() => client.close())
  return { instance, credential, url, client }
}

describe('native HTTP client', { timeout: 10_000 }, () => {
  it('carries an explicit credential through handshake, event stream and later mutations', async t => {
    const f = await setup(t), welcome = await f.client.ready
    assert.equal(welcome.principal, `u:${f.instance.bootstrap.adminId}`)
    await assert.rejects(openTwpHttp({ url: f.url, credential: f.credential, headers: { Authorization: 'Bearer different' } }), code('UNAUTHENTICATED'))
    const outcome = await f.client.commit({ changes: [{ op: 'put', node: { $path: '/from-http', $type: 't.dir', value: 7 } }] }).outcome
    assert.ok(outcome.pos)
    const read = await f.client.read({ node: '/from-http' })
    assert.equal(read.list.length, 1)
    assert.ok('node' in read.copies[0])
    assert.equal(read.copies[0].node.value, 7)
  })

  it('preserves a typed read refusal and continues reading on the same lane', async t => {
    const f = await setup(t); await f.client.ready
    await assert.rejects(f.client.read({ node: '/absent' }), code('NOT_FOUND'))
    const read = await f.client.read({ node: '/sys/limits' })
    assert.equal(read.list.length, 1)
    assert.ok('node' in read.copies[0])
    assert.equal(read.copies[0].node.$path, '/sys/limits')
  })

  it('keeps both explicit credential transports healthy when another login rotates the ambient cookie', async t => {
    const f = await setup(t); await f.client.ready
    const realFetch = globalThis.fetch
    const login = await realFetch(`${f.url}/auth/login`, { method: 'POST', headers: {
      'Content-Type': 'application/json', Origin: 'http://client.test',
    }, body: JSON.stringify({ account: '/admin', password: 'http-client-password' }) })
    assert.equal(login.status, 200)
    const credential: Credential = await login.json(), cookie = login.headers.get('Set-Cookie')
    assert.ok(cookie)
    const modes: (RequestCredentials | undefined)[] = []
    t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof realFetch>[0], init: Parameters<typeof realFetch>[1]) => {
      const headers = new Headers(init?.headers)
      if (init?.credentials !== 'omit') headers.set('Cookie', cookie.split(';')[0])
      headers.set('Origin', 'http://client.test')
      modes.push(init?.credentials)
      return realFetch(input, { ...init, headers })
    })
    const connection = await openTwpHttp({ url: f.url, credential })
    const second = createTwpClient(connection, { close: connection.close }); t.after(() => second.close())
    await second.ready
    assert.equal((await f.client.read({ node: '/sys/limits' })).list.length, 1)
    assert.equal((await second.read({ node: '/sys/limits' })).list.length, 1)
    assert.ok(modes.length >= 4)
    assert.ok(modes.every(mode => mode === 'omit'))
  })
})
