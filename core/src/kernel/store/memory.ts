import { isChildPath } from '#core/path'
import { KernelError } from '#errors'
import type { ExprWork } from '#kernel/eval'
import { createSiftTest } from '#kernel/expr'
import { DEFAULT_LIMITS, type Budget, type DecisionRange, type JournalCommit, type JournalRange, type Position,
  type OpId, type ScanQuery, type ScanRange, type ScanResult, type Store, type StoreCommit, type StoredNode } from '#kernel/types'
import { stableJson } from '#util/stable-json'
import { mapNodeForSift } from './keys'
import { treeEnsure, treeNavigate, treeRemove, treeWalk, type TreeNode } from './nested-map'
import { scanPage } from './scan'

export interface MemoryStoreOptions {
  domain: string
  beforeRecord?(): void
}

const equalPosition = (a: Position, b: Position) => a.instance === b.instance && a.epoch === b.epoch && a.seq === b.seq
const decisionKey = (caller: string, opId: OpId) => stableJson([caller, opId])

export function createMemoryStore(options: MemoryStoreOptions): Store {
  const root: TreeNode<StoredNode> = { children: new Map() }
  const journal: JournalCommit[] = []
  const decisions = new Map<string, JournalCommit>()
  let writerEpoch = 0

  function check(budget: Budget): void {
    if (Date.now() > budget.deadline) throw new KernelError('BUDGET', 'Scan deadline exceeded')
  }

  function* candidates(range: ScanRange, budget: Budget): Iterable<StoredNode> {
    const path = 'node' in range ? range.node : 'children' in range ? range.children : range.subtree
    const start = treeNavigate(root, path)
    if (start === undefined) return
    if ('node' in range) {
      if (start.data !== undefined) yield start.data
      return
    }
    if ('children' in range) {
      for (const child of start.children.values()) {
        check(budget)
        if (child.data !== undefined) yield child.data
      }
      return
    }
    for (const node of treeWalk(start)) {
      check(budget)
      if (node.data !== undefined) yield node.data
    }
  }

  function collect<T extends object>(items: Iterable<T>, query: ScanQuery<unknown>): T[] {
    const result: T[] = []
    const work: ExprWork = { limit: query.budget.exprWork, used: 0 }
    const test = query.where === undefined ? undefined : createSiftTest(query.where, DEFAULT_LIMITS)
    let nodes = 0, bytes = 0
    check(query.budget)
    for (const item of items) {
      check(query.budget)
      nodes++
      if (nodes > query.budget.nodes) throw new KernelError('BUDGET', 'Scan node budget exceeded')
      bytes += Buffer.byteLength(JSON.stringify(item))
      if (bytes > query.budget.bytes) throw new KernelError('BUDGET', 'Scan byte budget exceeded')
      if (test === undefined || test(mapNodeForSift(item), work)) result.push(item)
    }
    check(query.budget)
    return result
  }

  function scan(query: ScanQuery<ScanRange>): Promise<ScanResult<StoredNode>>
  function scan(query: ScanQuery<JournalRange | DecisionRange>): Promise<ScanResult<JournalCommit>>
  async function scan(query: ScanQuery<ScanRange | JournalRange | DecisionRange>): Promise<ScanResult<StoredNode> | ScanResult<JournalCommit>> {
    const scope = stableJson([options.domain, query.range, query.where, query.sort])
    const deadline = () => check(query.budget)
    const range = query.range
    if ('journal' in range || 'decision' in range) {
      let records: Iterable<JournalCommit>
      if ('decision' in range) {
        const latest = decisions.get(decisionKey(range.decision.caller, range.decision.opId))
        records = latest === undefined ? [] : [latest]
      } else {
        const selected: JournalCommit[] = []
        for (const record of collect(journal, query)) {
          if (range.after !== undefined) {
            if (record.pos.instance !== range.after.instance) throw new KernelError('INVALID', 'Journal positions belong to different instances')
            if (record.pos.epoch < range.after.epoch || record.pos.epoch === range.after.epoch && record.pos.seq <= range.after.seq) continue
          }
          if (record.entries.some(entry => entry.path === range.journal || isChildPath(range.journal, entry.path, false)
            || entry.from === range.journal || entry.from !== undefined && isChildPath(range.journal, entry.from, false))
            || range.journal === '/' && record.entries.length === 0) selected.push(record)
        }
        return scanPage(selected, query.sort ?? [['pos.epoch', 1], ['pos.seq', 1]], record => stableJson(record.pos), scope, query.after, query.limit, deadline)
      }
      return scanPage(collect(records, query), query.sort ?? [['pos.epoch', 1], ['pos.seq', 1]], record => stableJson(record.pos), scope, query.after, query.limit, deadline)
    }
    return scanPage(collect(candidates(range, query.budget), query), query.sort ?? [], node => node.$path, scope, query.after, query.limit, deadline)
  }

  return {
    domain: options.domain,
    scan,
    async commit(input: StoreCommit) {
      if (input.writerEpoch < writerEpoch) throw new KernelError('CONFLICT', 'Writer epoch is stale')
      const commit = structuredClone(input)
      if (commit.writerEpoch < writerEpoch) throw new KernelError('CONFLICT', 'Writer epoch is stale')
      if (!equalPosition(commit.pos, commit.record.pos)) throw new KernelError('INVALID', 'Data and journal positions differ')
      const paths = new Set<string>()
      for (const write of commit.writes) {
        if (paths.has(write.path)) throw new KernelError('INVALID', 'Duplicate stored write')
        paths.add(write.path)
        if (write.node !== null && (write.node.$path !== write.path || !equalPosition(write.node.$pos, commit.pos))) {
          throw new KernelError('INVALID', 'Stored node address or position differs from its commit')
        }
      }
      options.beforeRecord?.()
      if (commit.writerEpoch < writerEpoch) throw new KernelError('CONFLICT', 'Writer epoch is stale')
      const record = commit.record
      const key = record.decision === undefined ? undefined : decisionKey(record.caller, record.decision.opId)
      // All fallible staging finishes before the synchronous data and journal publication.
      for (const write of commit.writes) {
        if (write.node === null) treeRemove(root, write.path)
        else treeEnsure(root, write.path).data = write.node
      }
      journal.push(record)
      if (key !== undefined) decisions.set(key, record)
      writerEpoch = commit.writerEpoch
    },
  }
}
