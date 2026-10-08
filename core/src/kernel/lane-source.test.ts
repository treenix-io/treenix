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
    changes: [{ op: 'put', node: { $path: '/item', $type: 't.dir', value: 1 } }] })
  return { instance, options: instance.nodeLaneOptions(await instance.auth.openCredential(instance.setupCredential)) }
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
})
