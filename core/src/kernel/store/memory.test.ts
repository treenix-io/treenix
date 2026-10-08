import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { KernelError } from '#errors'
import type { Store } from '#kernel/types'
import { position, runStoreContract, scanBudget, storeCommit, storedNode } from './contract'
import { createMemoryStore, type MemoryStore } from './memory'

let failing = false
runStoreContract(() => createMemoryStore({ domain: 'memory', beforeRecord: () => {
  if (failing) throw new Error('Injected storage failure')
} }), {
  name: 'memory',
  async crash(run) {
    failing = true
    try { await run() } finally { failing = false }
  },
})

describe('Memory Store publication', () => {
  it('releases owned memory idempotently and rejects every subsequent IO operation', async () => {
    const store = createMemoryStore({ domain: 'owned-memory' })
    await store.commit(storeCommit(1, [storedNode('/owned')]))
    store.close()
    store.close()
    const unavailable = (error: unknown) => error instanceof KernelError && error.code === 'UNAVAILABLE'
    await assert.rejects(store.scan({ range: { node: '/owned' }, budget: scanBudget() }), unavailable)
    await assert.rejects(store.scan({ range: { journal: '/' }, budget: scanBudget() }), unavailable)
    await assert.rejects(store.commit(storeCommit(2, [storedNode('/late')])), unavailable)
  })

  it('rejects a staged commit when its owner closes storage before publication', async () => {
    let store: MemoryStore
    store = createMemoryStore({ domain: 'owned-memory', beforeRecord() { store.close() } })
    await assert.rejects(store.commit(storeCommit(1, [storedNode('/late')])),
      (error: unknown) => error instanceof KernelError && error.code === 'UNAVAILABLE')
  })

  it('owns the staged commit before a failure hook can change its caller input', async () => {
    const input = storeCommit(1, [storedNode('/a', { value: 1 })])
    const store = createMemoryStore({ domain: 'memory', beforeRecord() {
      Reflect.set(input.writes[0].node, 'value', 99)
      Reflect.set(input.record, 'caller', 'external:changed')
    } })
    await store.commit(input)
    assert.equal((await store.scan({ range: { node: '/a' }, budget: scanBudget() })).items[0].value, 1)
    assert.equal((await store.scan({ range: { journal: '/' }, budget: scanBudget() })).items[0].caller, 'kernel')
  })

  it('fences a staged writer if a newer writer commits during staging', async () => {
    let entered = false
    let nested: Promise<void> | undefined
    let store: Store
    store = createMemoryStore({ domain: 'memory', beforeRecord() {
      if (entered) return
      entered = true
      nested = store.commit(storeCommit(2, [storedNode('/new')], [], 2))
    } })
    await assert.rejects(() => store.commit(storeCommit(1, [storedNode('/stale')])),
      (error: unknown) => error instanceof KernelError && error.code === 'CONFLICT')
    assert.ok(nested)
    await nested
    assert.deepEqual((await store.scan({ range: { subtree: '/' }, budget: scanBudget() })).items.map(node => node.$path), ['/new'])
    assert.deepEqual((await store.scan({ range: { journal: '/' }, budget: scanBudget() })).items.map(record => record.pos), [position(2)])
    await assert.rejects(() => store.commit(storeCommit(3, [storedNode('/still-stale')])),
      (error: unknown) => error instanceof KernelError && error.code === 'CONFLICT')
  })
})
