import { KernelError } from '#errors'
import type { ExprWork } from '#kernel/eval'
import { createSiftTest } from '#kernel/expr'
import { DEFAULT_LIMITS, type Budget, type DecisionRange, type JournalCommit, type JournalRange, type Position,
  type OpId, type ScanQuery, type ScanRange, type ScanResult, type Store, type StoreCommit, type StoredNode } from '#kernel/types'
import { stableJson } from '#util/stable-json'
import { mapNodeForSift } from './keys'
import { createJournalIndex } from '#kernel/store/journal-index'
import { treeEnsure, treeNavigate, treeRemove, treeWalk, type TreeNode } from './nested-map'
import { scanPage } from './scan'

export interface MemoryStoreOptions {
  domain: string
  beforeRecord?(): void
}

export interface MemoryStore extends Store {
  close(): void
}

const equalPosition = (a: Position, b: Position) => a.instance === b.instance && a.epoch === b.epoch && a.seq === b.seq
const decisionKey = (caller: string, opId: OpId) => stableJson([caller, opId])

/** Creates an in-memory Store whose node, journal, and decision state publish together. */
export function createMemoryStore(options: MemoryStoreOptions): MemoryStore {
  const root: TreeNode<StoredNode> = { children: new Map() }
  let journalIndex = createJournalIndex()
  const decisions = new Map<string, JournalCommit>()
  let writerEpoch = 0
  let closed = false

  /** Refuse IO after the owner releases this storage instance. */
  function available(): void {
    if (closed) throw new KernelError('UNAVAILABLE', 'Memory Store is closed')
  }

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

  function collect<T extends object>(items: Iterable<T>, query: ScanQuery<unknown>, cost = { nodes: 0, bytes: 0, exprWork: 0 }): T[] {
    const result: T[] = []
    const work: ExprWork = { limit: query.budget.exprWork, used: cost.exprWork }
    const test = query.where === undefined ? undefined : createSiftTest(query.where, DEFAULT_LIMITS)
    check(query.budget)
    for (const item of items) {
      check(query.budget)
      cost.nodes++
      if (cost.nodes > query.budget.nodes) throw new KernelError('BUDGET', 'Scan node budget exceeded')
      cost.bytes += Buffer.byteLength(JSON.stringify(item))
      if (cost.bytes > query.budget.bytes) throw new KernelError('BUDGET', 'Scan byte budget exceeded')
      if (test === undefined || test(mapNodeForSift(item), work)) result.push(item)
    }
    check(query.budget)
    cost.exprWork = work.used
    return result
  }

  function scan(query: ScanQuery<ScanRange>): Promise<ScanResult<StoredNode>>
  function scan(query: ScanQuery<JournalRange | DecisionRange>): Promise<ScanResult<JournalCommit>>
  async function scan(query: ScanQuery<ScanRange | JournalRange | DecisionRange>): Promise<ScanResult<StoredNode> | ScanResult<JournalCommit>> {
    available()
    const range = query.range
    const scopedRange = 'journal' in range ? { journal: range.journal, after: range.after } : range
    const scope = stableJson([options.domain, scopedRange, query.where, query.sort])
    const deadline = () => check(query.budget)
    if ('journal' in range || 'decision' in range) {
      let records: Iterable<JournalCommit>
      if ('decision' in range) {
        const latest = decisions.get(decisionKey(range.decision.caller, range.decision.opId))
        records = latest === undefined ? [] : [latest]
      } else {
        const selected = journalIndex.select(range, query.budget)
        const records = collect(selected.records, query, selected.cost)
        const page = scanPage(records, query.sort ?? [['pos.epoch', 1], ['pos.seq', 1]], record => stableJson(record.pos), scope, query.after, query.limit, deadline)
        return range.accept === undefined ? page : { ...page, cost: selected.cost }
      }
      return scanPage(collect(records, query), query.sort ?? [['pos.epoch', 1], ['pos.seq', 1]], record => stableJson(record.pos), scope, query.after, query.limit, deadline)
    }
    return scanPage(collect(candidates(range, query.budget), query), query.sort ?? [], node => node.$path, scope, query.after, query.limit, deadline)
  }

  return {
    domain: options.domain,
    scan,
    async commit(input: StoreCommit) {
      available()
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
      available()
      if (commit.writerEpoch < writerEpoch) throw new KernelError('CONFLICT', 'Writer epoch is stale')
      const record = commit.record
      const publishJournal = journalIndex.prepare(record, commit.writes)
      const key = record.decision === undefined ? undefined : decisionKey(record.caller, record.decision.opId)
      // All fallible staging finishes before the synchronous data and journal publication.
      for (const write of commit.writes) {
        if (write.node === null) treeRemove(root, write.path)
        else treeEnsure(root, write.path).data = write.node
      }
      publishJournal()
      if (key !== undefined) decisions.set(key, record)
      writerEpoch = commit.writerEpoch
    },
    /** Release the owned node data; repeated release has no effects. */
    close(): void {
      if (closed) return
      closed = true
      root.children.clear()
      root.data = undefined
      decisions.clear()
      journalIndex = createJournalIndex()
    },
  }
}
