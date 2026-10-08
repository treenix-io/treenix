import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { describe, it } from 'node:test'

import { KernelError } from '#errors'
import { createMemoryBlobStore } from '#kernel/blob-store-memory'
import { createInstance } from '#kernel/instance'
import { createMemoryMountHandler } from '#kernel/mount-memory'
import { scanBudget } from '#kernel/store/contract'
import { createMemoryStore } from '#kernel/store/memory'
import type { ModuleManifest, OpenedStoreMountTarget, Position, StoredNode } from '#kernel/types'

const code = (expected: KernelError['code']) =>
  (error: unknown) => error instanceof KernelError && error.code === expected

/** Holds the opener until the test explicitly releases its actual lifecycle boundary. */
function latch() {
  let release: () => void = () => { throw new Error('Latch is not initialized') }
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

/** Opens a seeded native Store through the genuine factory while holding its handler. */
async function fixture() {
  const id = `mount-opening:${randomUUID()}`
  const root = createMemoryStore({ domain: id })
  const entered = latch(), release = latch()
  const memory = createMemoryMountHandler(1)
  let saved: Position | undefined
  let opened = 0, closed = 0, target: OpenedStoreMountTarget | undefined
  const module: ModuleManifest = {
    id: 'mount-opening',
    types: [{ name: 'test.mount.opening', module: 'mount-opening', security: 'user-capability',
      version: 0, schema: {}, actions: {} }],
    security: [{ type: 'test.mount.opening', context: 'mount', async handler(node, session) {
      opened++
      const created = await memory(node, session)
      const pos = instance.writer.stream.cursor().pos
      const value: StoredNode = { $path: '/mount/doc', $id: randomUUID(), $type: 't.dir',
        $pos: pos, value: 'owned-target-value' }
      await created.store.commit({ pos, writerEpoch: created.resources.writerEpoch,
        writes: [{ path: value.$path, node: value }],
        record: { pos, kind: 'kernel', executor: 'kernel', caller: 'kernel',
          entries: [{ id: value.$id, path: value.$path, change: { t: 'create', after: value } }] } })
      target = { ...created, async close() { closed++; await created.close() } }
      entered.release()
      await release.promise
      return target
    } }],
    open: [],
  }
  const instance = await createInstance({ id, root: { kind: 'store', store: root },
    provisioning: { writerEpoch: 1, counter: {
      async load() { return saved }, async save(pos) { saved = pos },
      async freshEpoch(floor) { return floor + 1 },
    }, domains: [{ store: root, epoch: randomUUID(), persistent: false }],
    credentialTtlMs: 60_000,
    bootstrap: { kind: 'fresh', admin: { path: '/admin', name: 'admin', password: 'mount-opening-password' } } },
    blobs: createMemoryBlobStore(), modules: [module],
  })
  assert.ok(instance.setupCredential)
  const first = await instance.auth.openCredential(instance.setupCredential)
  const second = await instance.auth.openCredential(instance.setupCredential)
  const commands = instance.commands(first)
  const other = instance.commands(second)
  await commands.commit({ opId: { epoch: instance.writer.intake.epoch, time: Date.now(), nonce: randomUUID() },
    changes: [{ op: 'put', node: { $path: '/mount', $type: 't.dir',
      '#mount': { $type: 'test.mount.opening', pattern: 'doc' } } }] })

  /** Releases a held handler before waiting for the factory's owned cleanup. */
  async function close() { release.release(); await instance.close() }
  return { instance, first, commands, other, entered, release, close,
    opened: () => opened, closed: () => closed,
    target() { assert.ok(target); return target } }
}

describe('shared mount opening lifetime', { timeout: 10_000 }, () => {
  it('detaches a cancelled caller before the shared opener finishes and preserves the other caller',
    { timeout: 10_000 }, async t => {
      const f = await fixture()
      t.after(f.close)
      const controller = new AbortController()
      const cancelled = f.commands.read({ node: '/mount/doc' }, controller.signal)
      await f.entered.promise
      const other = f.other.read({ node: '/mount/doc' })
      const outcomes = Promise.allSettled([cancelled, other])
      controller.abort()

      await assert.rejects(cancelled, code('CANCELLED'))
      assert.equal(f.closed(), 0)
      assert.equal((await f.target().store.scan({ range: { node: '/mount/doc' }, budget: scanBudget() })).items.length, 1)
      f.release.release()
      const replies = await outcomes
      assert.equal(replies[1].status, 'fulfilled')
      const copy = replies[1].value.copies[0]
      assert.ok('node' in copy)
      assert.equal(copy.node.value, 'owned-target-value')
      assert.equal(f.opened(), 1)
      assert.equal(f.closed(), 0)
      await f.instance.close()
      assert.equal(f.closed(), 1)
    })

  it('releases a revoked caller without exposing the target value or stopping a live caller',
    { timeout: 10_000 }, async t => {
      const f = await fixture()
      t.after(f.close)
      const revoked = f.commands.read({ node: '/mount/doc' })
      await f.entered.promise
      const other = f.other.read({ node: '/mount/doc' })
      const outcomes = Promise.allSettled([revoked, other])
      f.first.close(new KernelError('UNAUTHENTICATED', 'Admission revoked'))

      await assert.rejects(revoked, code('UNAUTHENTICATED'))
      assert.equal(f.closed(), 0)
      f.release.release()
      const replies = await outcomes
      assert.equal(replies[1].status, 'fulfilled')
      const copy = replies[1].value.copies[0]
      assert.ok('node' in copy)
      assert.equal(copy.node.value, 'owned-target-value')
      assert.equal(f.opened(), 1)
      await f.instance.close()
      assert.equal(f.closed(), 1)
    })

  it('cancels a mutation waiting for the shared target without applying its effect',
    { timeout: 10_000 }, async t => {
      const f = await fixture()
      t.after(f.close)
      const controller = new AbortController()
      const cancelled = f.commands.commit({
        opId: { epoch: f.instance.writer.intake.epoch, time: Date.now(), nonce: randomUUID() },
        changes: [{ op: 'patch', path: '/mount/doc', ops: { $set: { value: 'cancelled-effect' } } }],
      }, controller.signal)
      await f.entered.promise
      const other = f.other.read({ node: '/mount/doc' })
      const outcomes = Promise.allSettled([cancelled, other])
      controller.abort()

      await assert.rejects(cancelled, code('CANCELLED'))
      assert.equal(f.closed(), 0)
      f.release.release()
      const replies = await outcomes
      assert.equal(replies[1].status, 'fulfilled')
      const copy = replies[1].value.copies[0]
      assert.ok('node' in copy)
      assert.equal(copy.node.value, 'owned-target-value')
      assert.equal(f.opened(), 1)
      await f.instance.close()
      assert.equal(f.closed(), 1)
    })
})
