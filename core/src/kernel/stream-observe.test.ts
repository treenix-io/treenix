import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { KernelError } from '#errors'
import { createMemoryStore } from '#kernel/store/memory'
import { scanBudget, storedNode } from '#kernel/store/contract'
import { createWriter } from '#kernel/writer'
import type { Position, StreamEvent } from '#kernel/types'

async function setup() {
  const store = createMemoryStore({ domain: 'observe' })
  let saved: Position | undefined
  const writer = await createWriter({ instance: 'observe', root: store, writerEpoch: 1,
    counter: { async load() { return saved }, async save(pos) { saved = pos }, async freshEpoch(floor) { return floor + 1 } },
    domains: [{ store, epoch: 'observe1', persistent: true }], budget: scanBudget })
  const commit = (path: string) => writer.commit(store, [], pos => {
    const after = { ...storedNode(path), $pos: pos }
    return { writes: [{ path, node: after }], record: { pos, kind: 'commit', executor: 'kernel', caller: 'kernel',
      entries: [{ id: after.$id, path, change: { t: 'create', after } }] } }
  })
  return { writer, store, commit }
}

describe('native synchronous stream observation', { timeout: 10_000 }, () => {
  it('runs after the actual cache publication and cursor advance without replica registration', async () => {
    const f = await setup(), observed: Position[] = []
    const dispose = f.writer.stream.observe(event => {
      assert.ok(event.t === 'commit')
      assert.deepEqual(f.writer.stream.cursor().pos, event.record.pos)
      assert.deepEqual(f.writer.cache.getAt(f.store, '/item')?.pos, event.record.pos)
      assert.ok(f.writer.cache.getAt(f.store, '/item')?.node)
      observed.push(event.record.pos)
    })
    const pos = await f.commit('/item'); dispose()
    assert.deepEqual(observed, [pos])
  })

  it('releases a synchronous observer without leaving a raw stream consumer behind', async () => {
    const f = await setup(), observed: StreamEvent[] = []
    const dispose = f.writer.stream.observe(event => { observed.push(event) })
    await f.commit('/first'); dispose(); dispose(); await f.commit('/second')
    assert.equal(observed.length, 1)
    assert.ok(observed[0].t === 'commit'); assert.equal(observed[0].record.entries[0].path, '/first')
  })

  it('propagates an observer failure and fences all later Writer effects', async t => {
    const f = await setup(), failure = new KernelError('INVALID', 'Observation failed')
    t.mock.method(console, 'error', () => {})
    const dispose = f.writer.stream.observe(() => { throw failure })
    await assert.rejects(f.commit('/accepted'), error => error === failure); dispose()
    const accepted = await f.store.scan({ range: { node: '/accepted' }, budget: scanBudget() })
    assert.equal(accepted.items.length, 1)
    await assert.rejects(f.commit('/refused'), error => error === failure)
    assert.equal((await f.store.scan({ range: { node: '/refused' }, budget: scanBudget() })).items.length, 0)
  })
})
