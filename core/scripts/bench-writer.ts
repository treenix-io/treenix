import { performance } from 'node:perf_hooks'
import { createProcessCache } from '#kernel/cache'
import { createWriter, type PreparedCommit } from '#kernel/writer'
import { createMemoryStore } from '#kernel/store/memory'
import { position, scanBudget, storeCommit, storedNode } from '#kernel/store/contract'
import type { Position } from '#kernel/types'
import { createNode } from '#core'
import { createMemoryTree } from '#tree'
import { mutationLock } from '#server/commit'

const count = 2000
async function measure(label: string, run: () => Promise<void>) {
  const start = performance.now()
  await run()
  const ms = performance.now() - start
  process.stdout.write(JSON.stringify({ label, count, ms, opsPerSecond: count * 1000 / ms }) + '\n')
}

const legacy = createMemoryTree()
await measure('mutationLock + memory Tree set', async () => {
  await Promise.all(Array.from({ length: count }, (_, i) => {
    const path = `/item-${i}`
    return mutationLock(path, async () => { await legacy.set(createNode(path, 'dir', { value: i })) })
  }))
})

let saved: Position | undefined
const store = createMemoryStore({ domain: 'memory' })
const writer = await createWriter({ instance: 'bench', root: store, writerEpoch: 1, domains: [{ store, epoch: 'memory-1', persistent: false }],
  counter: { async load() { return saved }, async save(pos) { saved = pos }, async freshEpoch(floor) { return floor + 1 } },
  budget: scanBudget,
})
await measure('writer + memory Store + journal + counter + cache + stream', async () => {
  await Promise.all(Array.from({ length: count }, (_, i) => writer.commit(store, [], (pos): PreparedCommit => {
    const node = { ...storedNode(`/item-${i}`, { value: i }), $pos: pos }
    return { writes: [{ path: node.$path, node }], record: { pos, kind: 'commit', executor: 'kernel', caller: 'kernel',
      entries: [{ id: node.$id, path: node.$path, change: { t: 'create', after: node } }] } }
  })))
})

for (let round = 0; round < 3; round++) {
  for (const readers of round % 2 === 0 ? [0, 1000] : [1000, 0]) {
    const cache = createProcessCache(), seed = storedNode('/shared', { value: 0 })
    cache.apply('memory', storeCommit(1, [seed]))
    const before = process.memoryUsage().heapUsed
    const releases = Array.from({ length: readers }, () => cache.retain(seed.$id))
    const readerHeapBytes = process.memoryUsage().heapUsed - before
    await measure(`cache feed, ${readers} readers, round ${round + 1}`, async () => {
      for (let i = 0; i < count; i++) {
        const pos = position(i + 2), node = { ...seed, value: i + 1, $pos: pos }
        cache.apply('memory', { pos, writerEpoch: 1, writes: [{ path: node.$path, node }], record: {
          pos, kind: 'commit', executor: 'kernel', caller: 'kernel', entries: [{ id: node.$id, path: node.$path,
            change: { t: 'update', after: node, delta: { value: { from: i, to: i + 1 } } } }],
        } })
      }
    })
    process.stdout.write(JSON.stringify({ readers, round: round + 1, readerHeapBytes, copies: cache.size }) + '\n')
    for (const release of releases) release()
  }
}
