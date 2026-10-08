import assert from 'node:assert/strict'
import { it } from 'node:test'
import { KernelError } from '#errors'
import { createProcessCache } from '#kernel/cache'
import { prepareChangeSet } from '#kernel/changeset'
import { fixture, put } from '#kernel/contract/changeset-fixture'
import { scanBudget } from '#kernel/store/contract'
import { DEFAULT_LIMITS, type DecisionRange, type JournalCommit, type JournalRange, type ScanQuery,
  type ScanRange, type ScanResult, type StoredNode } from '#kernel/types'

it('rejects an overdue journal checkpoint before accepting a ChangeSet', async t => {
  const f = await fixture(); await f.commit([put('/item', { value: 1 })])
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  const original = f.store.scan
  function scan(query: ScanQuery<ScanRange>): Promise<ScanResult<StoredNode>>
  function scan(query: ScanQuery<JournalRange | DecisionRange>): Promise<ScanResult<JournalCommit>>
  async function scan(query: ScanQuery<ScanRange | JournalRange | DecisionRange>): Promise<ScanResult<StoredNode> | ScanResult<JournalCommit>> {
    const range = query.range
    if ('journal' in range || 'decision' in range) {
      const result = await original({ ...query, range }); t.mock.timers.tick(11); return result
    }
    return original({ ...query, range })
  }
  f.store.scan = scan
  const budget = { ...scanBudget(), deadline: Date.now() + 1000 }, cache = createProcessCache()
  await assert.rejects(f.writer.commit(f.store, [], pos => prepareChangeSet({ store: f.store, cache, registry: f.registry,
    budget, limits: { ...DEFAULT_LIMITS, queryMs: 10 } }, [{ op: 'patch', path: '/item', ops: { $set: { value: 2 } } }], pos)),
  error => error instanceof KernelError && error.code === 'BUDGET')
  assert.equal((await f.nodes())[0].value, 1)
  assert.equal((await f.journal()).filter(record => record.entries.length > 0).length, 1)
})
