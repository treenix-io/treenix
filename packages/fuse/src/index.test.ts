import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { it, type TestContext } from 'node:test'
import type { Position } from '@treenx/core/kernel'
import { createInstance } from '#test-instance'
import { createMemoryStore } from '@treenx/core/kernel/store/memory'
import { createMemoryBlobStore } from '@treenx/core/kernel/blob-store-memory'
import { createTwpHttpServer } from '@treenx/core/server/http-twp'
import { openTwpHttp } from '@treenx/core/client/http-twp'
import { createTwpClient } from '@treenx/core/client/twp'
import { KernelError } from '@treenx/core/errors'
import { createFuseOperations, fuseError } from '#index'

/** Connect the filesystem to a real authenticated kernel Session over the public HTTP transport. */
async function fixture(t: TestContext) {
  const id = randomUUID(), store = createMemoryStore({ domain: id })
  let saved: Position | undefined
  const instance = await createInstance({ id, root: { kind: 'store', store }, modules: [], blobs: createMemoryBlobStore(),
    provisioning: { writerEpoch: 1, domains: [{ store, epoch: randomUUID(), persistent: false }],
      credentialTtlMs: 60_000, counter: { async load() { return saved }, async save(pos) { saved = pos },
        async freshEpoch(floor) { return floor + 1 } },
      bootstrap: { kind: 'fresh', admin: { path: '/admin', name: 'admin', password: randomUUID() } } } })
  assert.ok(instance.setupCredential)
  const credential = instance.setupCredential
  const http = createTwpHttpServer({ instance, allowedOrigins: [], credentialTtlMs: 60_000 })
  t.after(async () => { await http.close(); await instance.close() })
  http.server.listen(0, '127.0.0.1')
  await once(http.server, 'listening')
  const address = http.server.address()
  assert.ok(address !== null && typeof address === 'object')
  const connection = await openTwpHttp({ url: `http://127.0.0.1:${address.port}`, credential })
  const client = createTwpClient(connection, { credential, close: connection.close })
  const operations = createFuseOperations(client)
  t.after(() => operations.close())
  await client.ready
  return { client, operations }
}

it('reads the namespace and commits split JSON, mkdir, rename and remove through the genuine Session', { timeout: 15_000 }, async t => {
  const { operations, client } = await fixture(t)
  await operations.mkdir('/folder')
  await operations.mkdir('/folder/item')
  assert.deepEqual(await operations.readdir('/folder'), ['.', '..', '$.json', 'item'])
  assert.equal((await operations.getattr('/folder/item')).mode, 0o40755)
  const fd = await operations.open('/folder/item/$.json')
  const input = Buffer.from(JSON.stringify({ $type: 't.dir', value: 7 }) + '\n')
  await operations.truncate('/folder/item/$.json', 0)
  const split = Math.floor(input.length / 2)
  assert.equal(await operations.write(fd, input.subarray(0, split), split, 0), split)
  assert.equal(await operations.write(fd, input.subarray(split), input.length - split, split), input.length - split)
  const before = (await client.read({ node: '/folder/item' })).copies[0]
  assert.ok('node' in before)
  assert.equal(before.node.value, undefined)
  await operations.flush(fd)
  await operations.release(fd)
  const after = (await client.read({ node: '/folder/item' })).copies[0]
  assert.ok('node' in after)
  assert.equal(after.node.value, 7)
  const reader = await operations.open('/folder/item/$.json')
  const output = Buffer.alloc((await operations.getattr('/folder/item/$.json')).size)
  assert.equal(await operations.read(reader, output, output.length, 0), output.length)
  assert.equal(JSON.parse(output.toString()).value, 7)
  await operations.release(reader)
  await operations.rename('/folder/item', '/folder/renamed')
  assert.deepEqual(await operations.readdir('/folder'), ['.', '..', '$.json', 'renamed'])
  await operations.rmdir('/folder/renamed')
  assert.deepEqual(await operations.readdir('/folder'), ['.', '..', '$.json'])
  operations.close()
  operations.close()
  await assert.rejects(operations.getattr('/folder'), error => error instanceof KernelError && error.code === 'UNAVAILABLE')
})

it('keeps malformed external JSON atomic and maps the native failure at the filesystem boundary', { timeout: 15_000 }, async t => {
  const { operations, client } = await fixture(t)
  await operations.mkdir('/item')
  const fd = await operations.open('/item/$.json')
  await operations.truncate('/item/$.json', 0)
  const malformed = Buffer.from('{"value":1}')
  await operations.write(fd, malformed, malformed.length, 0)
  await assert.rejects(operations.release(fd), error => error instanceof KernelError && error.code === 'INVALID')
  const result = (await client.read({ node: '/item' })).copies[0]
  assert.ok('node' in result)
  assert.equal(result.node.value, undefined)
  assert.equal(fuseError(new KernelError('NOT_FOUND', 'absent')), -2)
  assert.equal(fuseError(new KernelError('FORBIDDEN', 'denied')), -13)
})
