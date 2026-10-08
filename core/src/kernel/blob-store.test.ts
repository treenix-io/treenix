import assert from 'node:assert/strict'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { KernelError } from '#errors'
import { createFsBlobStore } from '#kernel/blob-store-fs'
import { createMemoryBlobStore } from '#kernel/blob-store-memory'
import type { BlobStore } from '#kernel/types'

const code = (expected: KernelError['code']) => (error: unknown) => error instanceof KernelError && error.code === expected

/** Coordinates stream progress without elapsed-time assumptions. */
function signal() {
  let resolve: () => void = () => {}
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

/** Reads the small test payload through the public stream contract. */
async function bytes(store: BlobStore, id: string): Promise<number[]> {
  const result: number[] = []
  for await (const part of store.get(id)) result.push(...part)
  return result
}

/** Allocates a new directory so existing and interrupted runs remain independent. */
async function directory(): Promise<string> {
  const base = resolve('temp')
  await mkdir(base, { recursive: true })
  return mkdtemp(join(base, 'native-blobs-'))
}

const stores = [
  ['memory', async () => createMemoryBlobStore()],
  ['filesystem', async () => createFsBlobStore(await directory())],
] as const

for (const [name, openStore] of stores) describe(`${name} binary storage`, { timeout: 10_000 }, () => {
  it('publishes only complete uploads and owns the supplied chunks', async () => {
    const store = await openStore()
    const id = '1'.repeat(64)
    const first = new Uint8Array([1, 2])
    const reached = signal()
    const release = signal()
    const upload = store.put(id, (async function* () {
      yield first
      reached.resolve()
      await release.promise
      yield new Uint8Array([3, 4])
    })(), 'application/octet-stream')

    await reached.promise
    await assert.rejects(store.stat(id), code('NOT_FOUND'))
    first[0] = 9
    release.resolve()
    const ref = await upload
    assert.deepEqual(ref, { $blob: id, size: 4, type: 'application/octet-stream' })
    assert.deepEqual(await store.stat(id), ref)
    assert.deepEqual(await bytes(store, id), [1, 2, 3, 4])

    for await (const part of store.get(id)) part.fill(0)
    assert.deepEqual(await bytes(store, id), [1, 2, 3, 4])
  })

  it('preserves accepted content across collisions and failed streams', async () => {
    const store = await openStore()
    const id = '2'.repeat(64)
    const failedId = '3'.repeat(64)
    const parts = async function* () { yield new Uint8Array([7, 8]) }
    const accepted = await store.put(id, parts(), 'application/octet-stream')
    await assert.rejects(store.put(id, parts(), 'text/plain'), code('CONFLICT'))
    await assert.rejects(store.put(failedId, (async function* () {
      yield new Uint8Array([0])
      throw new KernelError('CANCELLED', 'Source ended')
    })(), 'application/octet-stream'), code('CANCELLED'))

    assert.deepEqual(await store.stat(id), accepted)
    assert.deepEqual(await bytes(store, id), [7, 8])
    await assert.rejects(store.stat(failedId), code('NOT_FOUND'))
    await store.delete(id)
    await assert.rejects(store.stat(id), code('NOT_FOUND'))
    await assert.rejects(bytes(store, id), code('NOT_FOUND'))
  })
})

describe('persistent binary storage', { timeout: 10_000 }, () => {
  it('reopens accepted references and content without rewriting prior uploads', async () => {
    const path = await directory()
    const store = await createFsBlobStore(path)
    const id = '4'.repeat(64)
    const ref = await store.put(id, (async function* () { yield new Uint8Array([10, 11]) })(), 'application/octet-stream')
    const reopened = await createFsBlobStore(path)
    assert.deepEqual(await reopened.stat(id), ref)
    assert.deepEqual(await bytes(reopened, id), [10, 11])
  })
})
