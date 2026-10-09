import assert from 'node:assert/strict'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { it } from 'node:test'
import { KernelError } from '#errors'
import { openPersistentWriter } from '#kernel/persistence'
import { createFsStore } from '#kernel/store/fs'
import { createMemoryStore } from '#kernel/store/memory'
import { scanBudget, storeCommit, storedNode } from '#kernel/store/contract'

for (const persistent of [false, true]) {
  it(`reports inspected rows before filtering and paging in ${persistent ? 'Fs' : 'Memory'} scans`, async (t) => {
    const parent = resolve('../../temp/k34-native-store-cost')
    await mkdir(parent, { recursive: true })
    const directory = await mkdtemp(join(parent, 'dataset-'))
    const lease = persistent
      ? await openPersistentWriter({ directory: join(directory, '.treenix'), instance: 'test' })
      : undefined
    const store =
      lease === undefined
        ? createMemoryStore({ domain: 'cost' })
        : await createFsStore({ directory, lease })
    t.after(async () => {
      await store.close()
      await lease?.close()
    })
    const commit = storeCommit(
      1,
      [
        storedNode('/data/a', { count: 1 }),
        storedNode('/data/b', { count: 2 }),
        storedNode('/data/c', { count: 3 }),
      ],
      [],
      lease?.writerEpoch ?? 0,
    )
    await store.commit(commit)
    const query = {
      range: { children: '/data' },
      where: { count: { $gte: 2 } },
      limit: 1,
      budget: scanBudget(),
    }
    const result = await store.scan(query)
    assert.equal(result.items.length, 1)
    assert.ok(result.next)
    assert.ok(result.cost)
    assert.equal(result.cost.nodes, 3)
    assert.equal(
      result.cost.bytes,
      commit.writes.reduce(
        (total, write) => total + Buffer.byteLength(JSON.stringify(write.node)),
        0,
      ),
    )
    assert.ok(result.cost.exprWork > 0)
    await assert.rejects(
      store.scan({ ...query, budget: { ...scanBudget(), nodes: 2 } }),
      (error) => error instanceof KernelError && error.code === 'BUDGET',
    )
  })
}
