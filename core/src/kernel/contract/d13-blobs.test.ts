import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { KernelError } from '#errors'
import { createMemoryBlobStore } from '#kernel/blob-store-memory'
import { createInstanceFoundation } from '#kernel/instance'
import { createNodeLane } from '#kernel/lane'
import { createMemoryStore } from '#kernel/store/memory'
import { R, type BlobStore, type Gate, type Operation, type Position } from '#kernel/types'

const code = (expected: KernelError['code']) => (error: unknown) => error instanceof KernelError && error.code === expected

/** Coordinates a deliberately stalled external stream through actual events. */
function signal() {
  let resolve: () => void = () => {}
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

/** Opens the actual native writer, admission and lane with binary storage. */
async function setup(gates: readonly Gate[] = [], blobs: BlobStore = createMemoryBlobStore()) {
  const root = createMemoryStore({ domain: 'blob-contract' })
  let saved: Position | undefined
  let sequence = 0
  const instance = await createInstanceFoundation({ id: 'blob-contract', root, blobs, writerEpoch: 1,
    counter: { async load() { return saved }, async save(pos) { saved = pos }, async freshEpoch(floor) { return floor + 1 } },
    domains: [{ store: root, epoch: 'blob-domain', persistent: true }],
    firstAdmin: { path: '/admin', name: 'admin', password: 'blob-test-password' },
    initialCredential: { ttlMs: 60_000 }, gates })
  assert.ok(instance.setupCredential)
  const admin = instance.commands(await instance.auth.openCredential(instance.setupCredential))
  const lane = createNodeLane(instance.nodeLaneOptions(await instance.auth.openCredential(instance.setupCredential)))
  const key = () => ({ epoch: instance.writer.intake.epoch, time: Date.now(), nonce: String(++sequence) })
  return { instance, blobs, lane, admin, key, close() { lane.close(); instance.auth.close() } }
}

/** Encodes a small binary fixture without embedding it in a node. */
async function* parts(): AsyncIterable<Uint8Array> {
  yield new Uint8Array([1, 2])
  yield new Uint8Array([3])
}

/** Collects a small fixture from the actual session transfer. */
async function bytes(source: AsyncIterable<Uint8Array>): Promise<number[]> {
  const result: number[] = []
  for await (const part of source) result.push(...part)
  return result
}

describe('native binary session contract', { timeout: 15_000 }, () => {
  it('issues secret references, gates transfers and downloads only through a visible field', async t => {
    const seen: Operation[] = []
    const f = await setup([async operation => { seen.push(operation); return 'pass' }])
    t.after(f.close)
    const ref = await f.lane.upload(parts(), 'application/octet-stream')
    assert.match(ref.$blob, /^[0-9a-f]{64}$/)
    assert.equal(ref.size, 3)
    const another = await f.lane.upload(parts(), 'application/octet-stream')
    assert.notEqual(another.$blob, ref.$blob)
    await f.admin.commit({ opId: f.key(), changes: [{ op: 'put', node: {
      $path: '/file', $type: 't.dir', items: [{ file: ref }], $acl: [{ subject: { group: 'public' }, grant: R }],
    } }] })

    assert.deepEqual(await bytes(f.lane.download('/file', 'items.0.file')), [1, 2, 3])
    await assert.rejects(bytes(f.lane.download('/file', 'missing')), code('NOT_FOUND'))
    assert.ok(seen.some(operation => operation.kind === 'upload' && operation.type === 'application/octet-stream'))
    assert.ok(seen.some(operation => operation.kind === 'download' && operation.path === '/file' && operation.field === 'items.0.file'))
    const reader = createNodeLane(f.instance.nodeLaneOptions(await f.instance.auth.openCredential()))
    t.after(() => reader.close())
    assert.deepEqual(await bytes(reader.download('/file', 'items.0.file')), [1, 2, 3])
    await f.admin.commit({ opId: f.key(), changes: [{ op: 'patch', path: '/file', ops: { $unset: { $acl: true } } }] })
    await assert.rejects(bytes(reader.download('/file', 'items.0.file')), code('NOT_FOUND'))
  })

  it('rejects mismatched, unknown and embedded binary references atomically', async t => {
    const f = await setup()
    t.after(f.close)
    const ref = await f.lane.upload(parts(), 'application/octet-stream')
    for (const value of [{ ...ref, size: 4 }, { ...ref, type: 'text/plain' },
      { ...ref, $blob: 'unknown-secret' }, new Uint8Array([1]), Buffer.from([1]),
      new DataView(new ArrayBuffer(1)), new ArrayBuffer(1), new SharedArrayBuffer(1)]) {
      await assert.rejects(f.admin.commit({ opId: f.key(), changes: [
        { op: 'put', node: { $path: '/first', $type: 't.dir' } },
        { op: 'put', node: { $path: '/second', $type: 't.dir', file: value } },
      ] }), code('INVALID'))
      assert.equal(await f.instance.source.node('/first'), null)
      assert.equal(await f.instance.source.node('/second'), null)
    }
  })

  it('shares the unfinished-request quota and cancels a stalled upload when its lane closes', async t => {
    const f = await setup()
    t.after(f.close)
    await f.admin.commit({ opId: f.key(), changes: [{ op: 'put', node: { $path: '/sys/limits', $type: 't.limits', laneRequests: 1 } }] })
    const entered = signal()
    const blocked = signal()
    const upload = f.lane.upload((async function* () {
      entered.resolve()
      await blocked.promise
      yield new Uint8Array([1])
    })(), 'application/octet-stream')
    const rejected = assert.rejects(upload, code('CANCELLED'))
    await entered.promise
    assert.throws(() => f.lane.read({ node: '/' }), code('BUDGET'))
    await rejected
    blocked.resolve()
  })

  it('releases the binary source when the download consumer pauses and its lane closes', async t => {
    const memory = createMemoryBlobStore()
    const released = signal()
    const blobs: BlobStore = { ...memory, async *get(id) {
      try { yield* memory.get(id) }
      finally { released.resolve() }
    } }
    const f = await setup([], blobs)
    t.after(f.close)
    const ref = await f.lane.upload(parts(), 'application/octet-stream')
    await f.admin.commit({ opId: f.key(), changes: [
      { op: 'put', node: { $path: '/file', $type: 't.dir', file: ref } },
    ] })
    const iterator = f.lane.download('/file', 'file')[Symbol.asyncIterator]()
    t.after(async () => { await iterator.return?.() })
    const first = await iterator.next()
    assert.equal(first.done, false)
    assert.deepEqual(first.value, new Uint8Array([1, 2]))
    f.lane.close()
    await released.promise
    await assert.rejects(iterator.next(), code('CANCELLED'))
  })

  it('refuses an overflowing chunk and a gate denial without publishing binary content', async t => {
    const f = await setup([async operation => operation.kind === 'download' ? { refuse: 'REFUSED' } : 'pass'])
    t.after(f.close)
    await f.admin.commit({ opId: f.key(), changes: [{ op: 'put', node: { $path: '/sys/limits', $type: 't.limits', blobBytes: 2 } }] })
    await assert.rejects(f.lane.upload(parts(), 'application/octet-stream'), code('BUDGET'))
    await assert.rejects(bytes(f.lane.download('/missing', 'file')), code('REFUSED'))
    assert.equal(await f.instance.source.node('/missing'), null)
  })
})
