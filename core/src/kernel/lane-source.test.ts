import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { KernelError } from '#errors'
import { createInstanceFoundation } from '#kernel/instance'
import type { NodeLaneImage } from '#kernel/lane'
import { createMemoryStore } from '#kernel/store/memory'
import { scanBudget } from '#kernel/store/contract'
import type { Position } from '#kernel/types'

function signal() {
  let resolve: () => void = () => {}
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
async function setup() {
  const root = createMemoryStore({ domain: 'lane-lifetime' })
  let saved: Position | undefined
  const instance = await createInstanceFoundation({ id: 'lane-lifetime', root, writerEpoch: 1,
    counter: { async load() { return saved }, async save(pos) { saved = pos }, async freshEpoch(floor) { return floor + 1 } },
    domains: [{ store: root, epoch: 'lifetime1', persistent: true }], budget: scanBudget,
    firstAdmin: { path: '/admin', name: 'admin', password: 'lane-password' }, initialCredential: { ttlMs: 60_000 } })
  assert.ok(instance.setupCredential)
  const admin = instance.commands(await instance.auth.openCredential(instance.setupCredential))
  await admin.commit({ opId: { epoch: instance.writer.intake.epoch, time: Date.now(), nonce: 'seed' },
    changes: [{ op: 'put', node: { $path: '/item', $type: 't.dir', value: 1, link: '/related' } },
      { op: 'put', node: { $path: '/empty', $type: 't.dir' } },
      { op: 'put', node: { $path: '/related', $type: 't.dir', value: 2 } }] })
  return { instance, root, admin, options: instance.nodeLaneOptions(await instance.auth.openCredential(instance.setupCredential)) }
}

describe('lane read lifetime', { timeout: 10_000 }, () => {
  it('releases a payload fill which completes after its read span has ended', async t => {
    const f = await setup(); t.after(() => f.instance.auth.close())
    const entered = signal(), release = signal(), fill = f.instance.writer.cache.fill
    let released = 0
    t.mock.method(f.instance.writer.cache, 'fill', async (...args: Parameters<typeof fill>) => {
      if (!('node' in args[1]) || args[1].node !== '/item') return fill(...args)
      entered.resolve(); await release.promise
      const lease = await fill(...args)
      return { ...lease, release() { released++; lease.release() } }
    })
    let pending: Promise<NodeLaneImage | null> | undefined
    await f.options.read(async source => {
      pending = source.image('/item'); void pending.catch(() => {})
      await entered.promise
    })
    release.resolve(); assert.ok(pending)
    await assert.rejects(pending, error => error instanceof KernelError && error.code === 'INVALID')
    assert.equal(released, 1)
  })

  it('rejects a retained image once its owning read span has ended', async t => {
    const f = await setup(); t.after(() => f.instance.auth.close())
    const image = await f.options.read(source => source.image('/item')); assert.ok(image)
    assert.throws(() => image.retain(), error => error instanceof KernelError && error.code === 'INVALID')
  })

  it('selects under the existing read barrier while a later writer waits', async t => {
    const f = await setup(); t.after(() => f.instance.auth.close())
    let writing: Promise<Position> | undefined
    await f.options.read(async source => {
      writing = f.instance.writer.commit(f.root, [], pos => ({ writes: [], transitions: [],
        record: { pos, kind: 'kernel', executor: 'kernel', caller: 'kernel', entries: [] } }))
      const selected = await source.select({ node: '/item', include: [{ ref: 'link' }] })
      const copy = selected.images[0].copy
      assert.ok('node' in copy)
      assert.equal(selected.roots[0].member?.id, copy.node.$id)
      assert.equal(selected.roots[0].covered.length, 2)
      assert.equal(selected.images.length, 2)
    })
    assert.ok(writing)
    assert.deepEqual(await writing, f.instance.writer.stream.cursor().pos)
  })

  it('keeps fixed includes on an empty list and records missing reference dependencies per root', async t => {
    const f = await setup(); t.after(() => f.instance.auth.close())
    await f.options.read(async source => {
      const empty = await source.select({ children: '/empty', include: [{ path: '/related' }] })
      assert.deepEqual(empty.roots, [])
      assert.equal(empty.fixedIncludes.covered.length, 1)
      assert.equal(empty.images.length, 1)
      const selected = await source.select({ node: '/item', include: [{ ref: 'link' }, { path: '/missing' }] })
      assert.equal(selected.roots[0].covered.length, 2)
      assert.ok(selected.roots[0].reads.nodes?.some(node => node.path === '/related'))
      assert.ok(selected.fixedIncludes.reads.absent?.includes('/missing'))
    })
  })

  it('charges and fills one shared payload once for overlapping selections', async t => {
    const f = await setup(); t.after(() => f.instance.auth.close())
    const fill = f.instance.writer.cache.fill
    let itemLoads = 0
    t.mock.method(f.instance.writer.cache, 'fill', async (...args: Parameters<typeof fill>) => {
      if ('node' in args[1] && args[1].node === '/item') itemLoads++
      return fill(...args)
    })
    await f.options.read(async source => {
      for (let i = 0; i < 100; i++) assert.ok(await source.image('/item'))
    })
    assert.equal(itemLoads, 1)
  })

  it('distinguishes an initial absent node from removal in an existing subscription', async t => {
    const f = await setup(); t.after(() => f.instance.auth.close())
    await f.options.read(async source => {
      await assert.rejects(source.select({ node: '/missing' }), error => error instanceof KernelError && error.code === 'NOT_FOUND')
      const selected = await source.select({ node: '/missing' }, ['/missing'])
      assert.equal(selected.roots[0].member, undefined)
      assert.deepEqual(selected.roots[0].covered, [])
      assert.deepEqual(selected.roots[0].reads.absent, ['/missing'])
    })
  })
})
