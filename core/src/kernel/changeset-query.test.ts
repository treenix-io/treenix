import type { StoreCensusQuery, StoreCensusRange, StoreCensusNode } from "#kernel/types"
import type { JournalPositionHeadRange, JournalIntakeHeadRange, DecisionMetadataRange, JournalPositionHead, JournalIntakeHead, DecisionMetadata } from '#kernel/types'
import assert from 'node:assert/strict'
import { it } from 'node:test'
import { KernelError } from '#errors'
import { createProcessCache } from '#kernel/cache'
import { prepareChangeSet } from '#kernel/changeset'
import { fixture, put } from '#kernel/contract/changeset-fixture'
import { scanBudget } from '#kernel/store/contract'
import { DEFAULT_LIMITS, type DecisionRange, type JournalCommit, type JournalRange, type ScanQuery,
  type ScanRange, type ScanResult, type StoredNode } from '#kernel/types'

it('rejects an overdue canonical journal selection before accepting a restore', async t => {
  const f = await fixture(); await f.commit([put('/item', { value: 1 })])
  const id = (await f.nodes())[0].$id
  const pos = await f.commit([{ op: 'remove', path: '/item' }])
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  const original = f.store.scan
  function scan(query: StoreCensusQuery): Promise<ScanResult<StoreCensusNode>>
  function scan(query: ScanQuery<ScanRange>): Promise<ScanResult<StoredNode>>
  function scan(query: ScanQuery<JournalRange | DecisionRange>): Promise<ScanResult<JournalCommit>>
  function scan(query: ScanQuery<JournalPositionHeadRange>): Promise<ScanResult<JournalPositionHead>>
  function scan(query: ScanQuery<JournalIntakeHeadRange>): Promise<ScanResult<JournalIntakeHead>>
  function scan(query: ScanQuery<DecisionMetadataRange>): Promise<ScanResult<DecisionMetadata>>
  async function scan(query: ScanQuery<ScanRange | StoreCensusRange | JournalRange | DecisionRange | JournalPositionHeadRange | JournalIntakeHeadRange | DecisionMetadataRange>): Promise<ScanResult<StoreCensusNode> | ScanResult<StoredNode> | ScanResult<JournalCommit> | ScanResult<JournalPositionHead> | ScanResult<JournalIntakeHead> | ScanResult<DecisionMetadata>> {
    const range = query.range
    if ("census" in range) return original({ range, budget: query.budget })
    if ('journalHead' in range) return range.journalHead === 'position'
      ? original({ ...query, range: { journalHead: 'position' } }) : original({ ...query, range: { journalHead: 'intake' } })
    if ('decisionMetadata' in range) {
      return original({ ...query, range })
    }
    if ('journal' in range || 'decision' in range) {
      const result = await original({ ...query, range }); t.mock.timers.tick(11); return result
    }
    return original({ ...query, range })
  }
  f.store.scan = scan
  const budget = { ...scanBudget(), deadline: Date.now() + 1000 }, cache = createProcessCache()
  await assert.rejects(f.writer.commit(f.store, [], position => prepareChangeSet({ store: f.store, cache, registry: f.registry,
    budget, limits: { ...DEFAULT_LIMITS, queryMs: 10 } }, [{ op: 'restore', record: { pos, id } }], position)),
  error => error instanceof KernelError && error.code === 'BUDGET')
  assert.deepEqual(await f.nodes(), [])
  assert.equal((await f.journal()).filter(record => record.entries.length > 0).length, 2)
})
