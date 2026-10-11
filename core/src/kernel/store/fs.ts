import { decodeChainNode } from "#kernel/chain-index"
import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { KernelError } from '#errors'
import { createBlobHolds } from '#kernel/blob-holds'
import type { PersistentWriter } from '#kernel/persistence'
import { comparePositions } from '#kernel/position'
import { transferImageDigest } from '#kernel/transfer-image'
import { compactJournal } from '#kernel/journal'
import type { StoreCensusQuery, StoreCensusRange, StoreCensusNode, JournalPositionHeadRange, JournalIntakeHeadRange, DecisionMetadataRange, JournalPositionHead, JournalIntakeHead, DecisionMetadata, Budget, BlobArchiveMutation, ExternalEdits, ExternalCandidate, StorageFault, StorageFaultChange, DecisionRange, JournalCommit, JournalRange, Path, Position, ScanQuery, ScanRange, ScanResult, Store, StoreCommit, StoredNode } from '#kernel/types'
import { DEFAULT_LIMITS } from '#kernel/types'
import { stableJson } from '#util/stable-json'
import { assertPathSafe } from '#util/path-safety'
import { durableDirectory, durableWrite, missing } from './fs-io'
import { decodeCommit, decodeSnapshot, openFsJournal, readBlobArchives, selectedGeneration, validateCommit, type FsPublicationStage, type FsSnapshot } from './fs-journal'
import { fsWriteSafe, readFsNodes, scanFsNodes, writeFsNode } from './fs-layout'
import { createFsNamespace } from './fs-namespace'
import { createSiftTest } from '#kernel/expr'
import type { ExprWork } from '#kernel/eval'
import { mapNodeForSift } from './keys'
import { scanPage } from './scan'
import { createMemoryStore } from './memory'
import { createFsExternalWatcher } from './fs-external'

export type FsPhysicalCost = NonNullable<ScanResult<StoredNode>['cost']>

export interface FsPhysicalLayout {
  readonly preflight?: (commit: StoreCommit) => Promise<FsPhysicalCost>
  readonly release?: () => void
  readonly scan: typeof scanFsNodes
  readonly write: typeof writeFsNode
  readonly writeSafe: typeof fsWriteSafe
}

export interface FsStoreOptions {
  readonly layout?: FsPhysicalLayout
  readonly directory: string
  readonly external?: ExternalEdits
  readonly lease: PersistentWriter
  /** Logical address of the physical root; the persisted journal stays local. */
  readonly logicalBase?: Path
  readonly checkpoint?: (stage: 'beforeRecord' | 'recordSynced' | 'nodeWritten' | FsPublicationStage, path?: string) => void | Promise<void>
}

export interface FsStore extends Store {
  readonly directory: string
  close(): Promise<void>
}

/** Recover one owned logical storage shadow from local files, snapshot and journal. */
export async function createFsStore(options: FsStoreOptions): Promise<FsStore> {
  const layout = options.layout ?? { scan: scanFsNodes, write: writeFsNode, writeSafe: fsWriteSafe }
  const lease = options.lease, checkpoint = options.checkpoint, requestedDirectory = options.directory
  const namespace = createFsNamespace(options.logicalBase ?? '/')
  lease.assertActive()
  await durableDirectory(resolve(requestedDirectory))
  const directory = await realpath(resolve(requestedDirectory)), stateDirectory = join(directory, '.treenix')
  await assertPathSafe(directory, stateDirectory)
  if (lease.directory !== stateDirectory) throw new KernelError('INVALID', 'Filesystem Store and writer lease directories differ')
  let shadow = createMemoryStore({ domain: lease.domain, externalMaintenance: true })
  let failed: unknown, closed = false, closing: Promise<void> | undefined
  const ownHashes = new Map<Path, string>()
  const faults = new Map<Path, StorageFault>()
  const acceptedFaults = new Map<Path, StorageFault>()
  const acceptedPositions = new Map<Path, Position>()
  let reporter: ReturnType<typeof createFsExternalWatcher> | undefined
  let last: Position = { instance: lease.instance, epoch: 0, seq: 0 }
  const startupBudget = (): Budget => options.external === 'trusted'
    ? { nodes: DEFAULT_LIMITS.readNodes, bytes: DEFAULT_LIMITS.readBytes, exprWork: DEFAULT_LIMITS.exprWork,
      deadline: Date.now() + DEFAULT_LIMITS.queryMs }
    : { nodes: Number.MAX_SAFE_INTEGER, bytes: Number.MAX_SAFE_INTEGER, exprWork: Number.MAX_SAFE_INTEGER,
      deadline: Date.now() + 10_000 }
  const assertOpen = (): void => {
    lease.assertActive()
    if (closed) throw new KernelError('UNAVAILABLE', 'Filesystem Store is closed')
    if (failed !== undefined) throw new KernelError('UNAVAILABLE', 'Filesystem Store requires recovery after a failed publication')
  }
  return lease.run(async () => {
    await assertPathSafe(directory, join(stateDirectory, 'generation.json'))
    const generation = await selectedGeneration(stateDirectory)
    if (generation !== undefined) await assertPathSafe(directory, join(stateDirectory, generation.snapshot))
    const recovered = generation === undefined ? undefined : decodeSnapshot(await readFile(join(stateDirectory, generation.snapshot), 'utf8'))
    const snapshotPath = join(stateDirectory, 'snapshot.json'), appliedPath = join(stateDirectory, 'applied.json')
    let initialRecords: StoreCommit[] = [], snapshotPos: Position
    if (recovered !== undefined) {
      snapshotPos = recovered.pos
      for (const change of recovered.quarantine) {
        if (change.fault === null) throw new KernelError('INVALID', 'Filesystem snapshot contains a cleared quarantine')
        acceptedFaults.set(namespace.logicalPath(change.path), change.fault)
      }
    } else {
      let snapshot: StoreCommit
      try { snapshot = decodeCommit(await readFile(snapshotPath, 'utf8')) } catch (error) {
      if (!missing(error)) throw error
      try {
        if ((await readFile(join(stateDirectory, 'journal.log'))).length !== 0) throw new KernelError('INVALID', 'Filesystem snapshot is missing')
      } catch (absent) { if (!missing(absent)) throw absent }
      const pos: Position = { instance: lease.instance, epoch: 0, seq: 0 }
      const imported = await layout.scan(directory, pos, { subtree: '/' }, startupBudget(), options.external === 'trusted')
      const nodes = imported.nodes
      snapshot = { pos, writerEpoch: 0, writes: nodes.map(node => ({ path: node.$path, node })),
        record: { pos, kind: 'kernel', executor: 'kernel', caller: 'kernel', entries: nodes.map(node => ({ id: node.$id, path: node.$path, change: { t: 'create', after: node } })) } }
      await durableWrite(directory, snapshotPath, JSON.stringify(snapshot))
      }
      snapshotPos = snapshot.pos
      if (snapshot.writes.length > 0) {
        await shadow.commit(namespace.logical(snapshot))
        initialRecords = [snapshot]
      }
    }
    if (snapshotPos.instance !== lease.instance) throw new KernelError('INVALID', 'Filesystem snapshot belongs to another instance')
    const journalName = generation?.journal ?? 'journal.log'
    await assertPathSafe(directory, join(stateDirectory, journalName))
    const journal = await openFsJournal(stateDirectory, journalName, generation?.snapshot)
    let journalFloor = recovered?.journalFloor
    let decisionBoundary = recovered?.decisionBoundary ?? 0
    let acceptedClock = recovered?.acceptedAt ?? 0
    let journalBoundary = recovered?.journalRetentionBoundary
    try {
      if (recovered !== undefined) {
        const historical = journal.commits.filter(commit => comparePositions(commit.pos, snapshotPos) <= 0)
        shadow.close()
        shadow = createMemoryStore({ domain: lease.domain, externalMaintenance: true, recovered: {
          nodes: recovered.nodes.map(namespace.logicalNode), commits: historical.map(commit => {
            const { blobArchive: captured, ...accepted } = namespace.logical(commit)
            return accepted
          }), writerEpoch: recovered.writerEpoch, journalRetentionBoundary: journalBoundary,
          ...(recovered.blobHolds === undefined ? {} : { blobHolds: { ...recovered.blobHolds,
            nodes: recovered.blobHolds.nodes.map(item => ({ ...item, path: namespace.logicalPath(item.path) })) } }) } })
        if (recovered.blobArchiveFile !== undefined) {
          await assertPathSafe(directory, join(stateDirectory, recovered.blobArchiveFile))
          for await (const unit of readBlobArchives(stateDirectory, recovered.blobArchiveFile, startupBudget))
            shadow.loadBlobArchives([unit], startupBudget)
        }
      }
      let applied = stableJson(snapshotPos)
      try { applied = await readFile(appliedPath, 'utf8') } catch (error) { if (!missing(error)) throw error }
      const positions = new Set<string>([stableJson(snapshotPos)])
      let redo = applied === stableJson(snapshotPos)
      let previous: Position | undefined
      for (const commit of journal.commits) {
        if (commit.pos.instance !== lease.instance) throw new KernelError('INVALID', 'Filesystem journal position is invalid')
        if (recovered === undefined && comparePositions(commit.pos, snapshotPos) <= 0)
          throw new KernelError('INVALID', 'Filesystem journal precedes its initial snapshot')
        if (previous !== undefined && comparePositions(commit.pos, previous) <= 0) throw new KernelError('INVALID', 'Filesystem journal positions are not increasing')
        previous = commit.pos
        acceptedClock = Math.max(acceptedClock, commit.acceptedAt ?? 0)
        if (commit.record.maintenance !== undefined)
          journalBoundary = Math.max(journalBoundary ?? commit.record.maintenance.journalBefore,
            commit.record.maintenance.journalBefore)
        positions.add(stableJson(commit.pos))
        if (recovered !== undefined && comparePositions(commit.pos, snapshotPos) <= 0) continue
        const replay = namespace.logical(commit)
        // Durable acceptance replays under the recovery allowance, never its spent request deadline.
        await shadow.commit(replay.maintenanceLimits === undefined ? replay : { ...replay,
          maintenanceLimits: { budget: startupBudget(), changeSet: replay.maintenanceLimits.changeSet } })
        for (const change of namespace.logical(commit).record.quarantine ?? []) {
          if (change.fault === null) acceptedFaults.delete(change.path)
          else acceptedFaults.set(change.path, change.fault)
        }
        if (redo && commit.record.kind !== 'reconcile') for (const write of commit.writes) await layout.write(directory, write)
        if (stableJson(commit.pos) === applied) redo = true
      }
      if (!positions.has(applied)) throw new KernelError('INVALID', 'Filesystem apply checkpoint has no journal record')
      last = journal.commits.at(-1)?.pos ?? snapshotPos
      if (comparePositions(last, snapshotPos) < 0) last = snapshotPos
      await durableWrite(directory, appliedPath, stableJson(last))
      const startup = await layout.scan(directory, last, { subtree: '/' }, startupBudget(), options.external === 'trusted')
      const actual = startup.nodes
      for (const change of startup.faults) if (change.fault !== null) faults.set(namespace.logicalPath(change.path), change.fault)
      const accepted = await shadow.scan({ range: { subtree: '/' }, budget: { nodes: Number.MAX_SAFE_INTEGER, bytes: Number.MAX_SAFE_INTEGER, exprWork: 0, deadline: Date.now() + 10_000 } })
      for (const node of accepted.items) acceptedPositions.set(node.$path, node.$pos)
      const images = (nodes: typeof actual) => stableJson(nodes.map(({ $pos, ...node }) => node).sort((a, b) => a.$path.localeCompare(b.$path)))
      if (options.external !== 'trusted' && images(actual.map(namespace.logicalNode)) !== images([...accepted.items])) throw new KernelError('INVALID', 'Filesystem contents differ from accepted storage state')
      if (options.external === 'trusted') reporter = createFsExternalWatcher(directory, namespace.logicalPath, [namespace.logicalPath('/')])
      journal.releaseReplay()
    } catch (error) { await journal.close(); throw error }
    function scan(query: StoreCensusQuery): Promise<ScanResult<StoreCensusNode>>
    function scan(query: ScanQuery<ScanRange>): Promise<ScanResult<StoredNode>>
    function scan(query: ScanQuery<JournalRange | DecisionRange>): Promise<ScanResult<JournalCommit>>
    function scan(query: ScanQuery<JournalPositionHeadRange>): Promise<ScanResult<JournalPositionHead>>
    function scan(query: ScanQuery<JournalIntakeHeadRange>): Promise<ScanResult<JournalIntakeHead>>
    function scan(query: ScanQuery<DecisionMetadataRange>): Promise<ScanResult<DecisionMetadata>>
    function scan(query: ScanQuery<ScanRange | StoreCensusRange | JournalRange | DecisionRange | JournalPositionHeadRange | JournalIntakeHeadRange | DecisionMetadataRange>): Promise<ScanResult<StoreCensusNode> | ScanResult<StoredNode> | ScanResult<JournalCommit> | ScanResult<JournalPositionHead> | ScanResult<JournalIntakeHead> | ScanResult<DecisionMetadata>> {
      assertOpen()
      const range = query.range
      if ("census" in range) {
        if (options.external !== "trusted") return shadow.scan({ range, budget: query.budget })
        return physicalScan({ range: { subtree: namespace.logicalPath("/") }, budget: query.budget }).then(result => ({
          ...result, items: result.items.map(node => ({ $path: node.$path, $id: node.$id, $pos: node.$pos, chain: decodeChainNode(node) })),
        }))
      }
      if ('journalHead' in range) return range.journalHead === 'position'
        ? shadow.scan({ ...query, range: { journalHead: 'position' } }) : shadow.scan({ ...query, range: { journalHead: 'intake' } })
      if ('decisionMetadata' in range) return shadow.scan({ ...query, range })
      if ('journal' in range && range.after !== undefined && journalFloor !== undefined
        && comparePositions(range.after, journalFloor) < 0) return Promise.resolve({ items: [], retainedFrom: journalFloor,
          cost: { nodes: 0, bytes: 0, exprWork: 0 } })
      if ('journal' in range || 'decision' in range) return shadow.scan({ ...query, range }).then(result => ({ ...result,
        ...(journalFloor === undefined ? {} : { retainedFrom: journalFloor }) }))
      if (options.external !== 'trusted') return shadow.scan({ ...query, range })
      return physicalScan({ ...query, range })
    }
    /** Trusted fresh reads see physical data while accepted journal images retain their own positions. */
    async function physicalScan(query: ScanQuery<ScanRange>): Promise<ScanResult<StoredNode>> {
      const range = query.range
      const local: ScanRange = 'node' in range ? { node: namespace.localPath(range.node) }
        : 'children' in range ? { children: namespace.localPath(range.children) } : { subtree: namespace.localPath(range.subtree) }
      const actual = await layout.scan(directory, last, local, query.budget, true)
      for (const node of actual.nodes) faults.delete(namespace.logicalPath(node.$path))
      for (const change of actual.faults) if (change.fault !== null) faults.set(namespace.logicalPath(change.path), change.fault)
      const cost = { ...actual.cost }
      const work: ExprWork = { used: cost.exprWork, limit: query.budget.exprWork }
      const test = query.where === undefined ? undefined : createSiftTest(query.where, DEFAULT_LIMITS)
      const items: StoredNode[] = []
      for (const image of actual.nodes) {
        const node = namespace.logicalNode(image)
        const current = { ...node, $pos: acceptedPositions.get(node.$path) ?? last }
        if (test === undefined || test(mapNodeForSift(current), work)) items.push(current)
      }
      cost.exprWork = work.used
      const check = () => { if (Date.now() > query.budget.deadline) throw new KernelError('BUDGET', 'Filesystem scan deadline exceeded') }
      return { ...scanPage(items, query.sort ?? [], node => node.$path,
        stableJson([lease.domain, range, query.where, query.sort]), query.after, query.limit, check), cost }
    }
    /** Compare one reported physical subtree against its accepted journal shadow. */
    async function readExternal(paths: readonly Path[], allowance: Budget): Promise<ScanResult<ExternalCandidate>> {
      assertOpen()
      const cost = { nodes: 0, bytes: 0, exprWork: 0 }
      const changes = new Map<Path, ExternalCandidate>()
      const diagnostics = new Map<Path, StorageFaultChange>()
      const remaining = (): Budget => ({ ...allowance, nodes: allowance.nodes - cost.nodes,
        bytes: allowance.bytes - cost.bytes, exprWork: allowance.exprWork - cost.exprWork })
      for (const path of paths) {
        const accepted = await shadow.scan({ range: { subtree: path }, budget: remaining() })
        if (accepted.cost === undefined) throw new KernelError('INVALID', 'Filesystem shadow scan has no cost')
        cost.nodes += accepted.cost.nodes; cost.bytes += accepted.cost.bytes; cost.exprWork += accepted.cost.exprWork
        const physical = await layout.scan(directory, last, { subtree: namespace.localPath(path) }, remaining(), true)
        cost.nodes += physical.cost.nodes; cost.bytes += physical.cost.bytes; cost.exprWork += physical.cost.exprWork
        const reportedFaults = new Map(physical.faults.map(change => [namespace.logicalPath(change.path), change.fault!]))
        for (const address of [...faults.keys()]) if (address === path || address.startsWith(`${path === '/' ? '' : path}/`)) faults.delete(address)
        for (const [address, fault] of reportedFaults) {
          faults.set(address, fault)
          if (!acceptedFaults.has(address)) diagnostics.set(address, { path: address, fault })
        }
        for (const address of acceptedFaults.keys()) if ((address === path || address.startsWith(`${path === '/' ? '' : path}/`)) && !reportedFaults.has(address))
          diagnostics.set(address, { path: address, fault: null })
        const before = new Map(accepted.items.map(node => [node.$path, node]))
        const after = new Map(physical.nodes.map(node => { const logical = namespace.logicalNode(node); return [logical.$path, logical] }))
        for (const address of new Set([...before.keys(), ...after.keys()])) {
          if (reportedFaults.has(address)) continue
          const prior = before.get(address) ?? null, current = after.get(address) ?? null
          const body = (node: StoredNode | null): string => {
            if (node === null) return 'null'
            const { $pos, ...content } = node
            return stableJson(content)
          }
          const hash = physical.hashes.get(namespace.localPath(address))
          if (!acceptedFaults.has(address) && hash !== undefined && hash === ownHashes.get(address) && body(prior) === body(current)) continue
          if (!acceptedFaults.has(address) && body(prior) === body(current)) continue
          changes.set(address, { path: address, before: prior, after: current })
        }
      }
      return { items: [...diagnostics.values(), ...changes.values()], cost }
    }
    /** Drop unchanged own notifications before the Writer reserves any reconciliation position. */
    async function* external(signal?: AbortSignal): AsyncGenerator<readonly Path[]> {
      for await (const paths of reporter!.events(signal)) {
        const changed = await lease.run(() => readExternal(paths, { nodes: DEFAULT_LIMITS.readNodes,
          bytes: DEFAULT_LIMITS.readBytes, exprWork: DEFAULT_LIMITS.exprWork, deadline: Date.now() + DEFAULT_LIMITS.queryMs }))
        if (changed.items.length !== 0) yield changed.items.map(image => image.path)
      }
    }
    const store: FsStore = {
      directory, domain: lease.domain, blobOwner: lease.domain,
      get journalRetentionClock() { assertOpen(); return acceptedClock },
      get journalRetentionBoundary() { assertOpen(); return journalBoundary },
      ...(reporter === undefined ? {} : { external, readExternal }),
      scan,
      /** Streams only this root's accepted archive pages under the Writer lifecycle barrier. */
      async *blobArchiveCensus(owner) {
        assertOpen()
        for await (const unit of shadow.blobArchiveCensus(owner)) { assertOpen(); yield unit }
      },
      /** Reads the durable archive catalogue without scanning archived node bodies. */
      async archivedBlobHolds(ids, clock, budget) {
        assertOpen()
        return shadow.archivedBlobHolds(ids, clock, budget)
      },
      /** Streams the accepted shadow under the caller's lifecycle barrier. */
      async *blobCensus() {
        assertOpen()
        for await (const row of shadow.blobCensus()) { assertOpen(); yield row }
      },
      /** Reads accepted owner metadata only while this Fs authority remains usable. */
      async blobHolds(ids, budget) {
        assertOpen()
        return shadow.blobHolds(ids, budget)
      },
      storageFault: path => faults.get(path),
      acceptedFault: path => acceptedFaults.get(path),
      async commit(input) {
        lease.assertActive()
        const commit = structuredClone(input)
        validateCommit(commit)
        const mapped = namespace.local(commit)

        if (closing) throw new KernelError('UNAVAILABLE', 'Filesystem Store is closing')
        await lease.run(async authority => {
          try {
          assertOpen()
          if (commit.pos.instance !== lease.instance) throw new KernelError('INVALID', 'Filesystem commit belongs to another instance')
          if (comparePositions(commit.pos, last) <= 0) throw new KernelError('CONFLICT', 'Filesystem commit position is already used')
          const local = mapped.acceptedAt === undefined
            ? mapped
            : { ...mapped, acceptedAt: Math.max(acceptedClock, mapped.acceptedAt) }

          for (const write of local.writes) {
            await layout.writeSafe(directory, write.path)
            if (write.node?.$id.startsWith('p:') && write.node.$id !== `p:${write.path}`) throw new KernelError('INVALID', 'Path identity differs from its address')
          }
          let publication = commit
          if (local.record.kind !== 'reconcile' && layout.preflight !== undefined) {
            const context = commit.maintenanceLimits ?? { budget: { nodes: DEFAULT_LIMITS.readNodes,
              bytes: DEFAULT_LIMITS.readBytes, exprWork: DEFAULT_LIMITS.exprWork,
              deadline: Date.now() + DEFAULT_LIMITS.queryMs }, changeSet: DEFAULT_LIMITS.changeSet }
            const cost = await layout.preflight({ ...local, maintenanceLimits: context })
            const remaining = { ...context.budget, nodes: context.budget.nodes - cost.nodes,
              bytes: context.budget.bytes - cost.bytes, exprWork: context.budget.exprWork - cost.exprWork }
            if (remaining.nodes < 0 || remaining.bytes < 0 || remaining.exprWork < 0)
              throw new KernelError('BUDGET', 'Filesystem physical publication exhausted its allowance')
            publication = { ...commit, maintenanceLimits: { ...context, budget: remaining } }
          }
          const referenceWork = { exprWork: 0 }
          let allowance = publication.maintenanceLimits?.budget ?? startupBudget()
          if (options.external === 'trusted' && (commit.transferBefore !== undefined || commit.transferAbsent !== undefined)) {
            for (const original of commit.transferBefore ?? []) {
              const actual = await layout.scan(directory, last,
                { node: namespace.localPath(original.path) }, allowance, false)
              allowance = { ...allowance, nodes: allowance.nodes - actual.cost.nodes,
                bytes: allowance.bytes - actual.cost.bytes, exprWork: allowance.exprWork - actual.cost.exprWork }
              const image = actual.nodes[0]
              if (image !== undefined) {
                const logical = namespace.logicalNode(image)
                const current = { ...logical, $pos: acceptedPositions.get(logical.$path) ?? last }
                if (current.$id !== original.sourceId || comparePositions(current.$pos, original.pos) !== 0
                  || transferImageDigest(current, allowance, referenceWork) !== original.digest)
                  throw new KernelError('CONFLICT', 'Transfer source original changed before cleanup')
              }
            }
            for (const path of commit.transferAbsent ?? []) {
              const actual = await layout.scan(directory, last, { node: namespace.localPath(path) }, allowance, false)
              allowance = { ...allowance, nodes: allowance.nodes - actual.cost.nodes,
                bytes: allowance.bytes - actual.cost.bytes, exprWork: allowance.exprWork - actual.cost.exprWork }
              if (actual.nodes.length !== 0) throw new KernelError('CONFLICT', 'Transfer destination appeared before copy')
            }
            publication = { ...publication, maintenanceLimits: {
              changeSet: publication.maintenanceLimits?.changeSet ?? DEFAULT_LIMITS.changeSet, budget: allowance } }
          }
          const nextClock = Math.max(acceptedClock, local.acceptedAt ?? 0)
          const intent = commit.record.maintenance
          let compaction: { readonly snapshot: FsSnapshot; readonly retained: readonly StoreCommit[];
            readonly next: ReturnType<typeof createMemoryStore>; readonly floor: Position;
            readonly decisionBoundary: number; readonly journalBoundary: number } | undefined
          const publishShadow = intent === undefined ? shadow.stageCommit(publication, referenceWork) : undefined
          if (intent !== undefined) {
            const nextDecisionBoundary = Math.max(decisionBoundary, intent.decisionBefore)
            const nextJournalBoundary = Math.max(journalBoundary ?? intent.journalBefore, intent.journalBefore)
              // Untimed legacy history gets one durable retention horizon before it can be retired.
              const history = [...journal.commits, local].map(item => ({
                ...item,
                acceptedAt: item.acceptedAt === undefined ? nextClock : item.acceptedAt,
                journalRetentionMs: item.journalRetentionMs ?? (item.acceptedAt === undefined ? commit.journalRetentionMs : undefined)
              }))
              const all = [...initialRecords, ...history]
              const oldest = history.find(item => item.acceptedAt >= intent.journalBefore
                || item.journalRetentionMs !== undefined && item.acceptedAt + item.journalRetentionMs >= nextClock)
              const cutoff = oldest?.pos ?? commit.pos
              const nextFloor = journalFloor === undefined || comparePositions(cutoff, journalFloor) > 0 ? cutoff : journalFloor
              const retainedRecords = compactJournal(all.map(item => item.record), nextFloor, nextDecisionBoundary)
              const originals = new Map(all.map(item => [stableJson(item.pos), item]))

              const retained = retainedRecords.map(record => {
                const original = originals.get(stableJson(record.pos))
                if (original === undefined) throw new KernelError('INVALID', 'Retained journal record has no accepted commit')
                return { ...original, record, writes: record.entries.length === 0 ? [] : original.writes }
              })
              const current = await shadow.scan({
                range: { subtree: '/' },
                budget: { ...allowance, exprWork: allowance.exprWork - referenceWork.exprWork }
              })
              if (current.next !== undefined)
                throw new KernelError('BUDGET', 'Filesystem maintenance requires the complete live snapshot')
              const scanned = current.cost!
              referenceWork.exprWork += scanned.exprWork
              const remaining = { ...allowance,
                nodes: allowance.nodes - scanned.nodes,
                bytes: allowance.bytes - scanned.bytes }
              const retainedHolds = createBlobHolds(shadow.blobSnapshot())
              retainedHolds.stage({ ...commit, acceptedAt: nextClock }, remaining,
                retained, undefined, referenceWork)()
              const blobHolds = retainedHolds.save()
              const snapshot: FsSnapshot = {
                pos: commit.pos,
                writerEpoch: commit.writerEpoch,
                nodes: current.items.map(namespace.localNode),
                quarantine: [...acceptedFaults].map(([path, fault]) => ({
                  path: namespace.localPath(path),
                  fault
                })),
                journalFloor: nextFloor,
                decisionBoundary: nextDecisionBoundary,
                acceptedAt: nextClock,
                journalRetentionBoundary: nextJournalBoundary,
                blobHolds: { ...blobHolds,
                  nodes: blobHolds.nodes.map(item => ({ ...item, path: namespace.localPath(item.path) })) },
              }
              const next = createMemoryStore({
                domain: lease.domain, externalMaintenance: true,
                recovered: {
                  nodes: current.items,
                  commits: retained.map(commit => {
                    const { blobArchive: captured, ...accepted } = namespace.logical(commit)
                    return accepted
                  }),
                  blobHolds,
                  journalRetentionBoundary: nextJournalBoundary,
                  writerEpoch: commit.writerEpoch
                }
              })
              /** Reconstruct archive units under the same remaining snapshot allowance. */
              function loadArchive(unit: BlobArchiveMutation): void {
                const nodes = unit.t === 'page' ? unit.rows.length : 1
                const bytes = Buffer.byteLength(JSON.stringify(unit))
                if (nodes > remaining.nodes || bytes > remaining.bytes)
                  throw new KernelError('BUDGET', 'Filesystem archive reconstruction exceeded its allowance')
                next.loadBlobArchives([unit], () => remaining, referenceWork)
                remaining.nodes -= nodes
                remaining.bytes -= bytes
              }
              for await (const unit of shadow.blobArchiveCensus()) loadArchive(unit)
              for (const unit of commit.blobArchive ?? []) loadArchive(unit)
              compaction = { snapshot, retained, next, floor: nextFloor, decisionBoundary: nextDecisionBoundary,
                journalBoundary: nextJournalBoundary }
          }
          await checkpoint?.('beforeRecord')
          lease.assertActive()
          await authority.reserveFence(commit.writerEpoch)
          try {
            await journal.append(local)
            await checkpoint?.('recordSynced')
            for (const write of local.record.kind === 'reconcile' ? [] : local.writes) {
              const content = await layout.write(directory, write)
              if (write.node === null) ownHashes.delete(namespace.logicalPath(write.path))
              else ownHashes.set(namespace.logicalPath(write.path), createHash('sha256').update(content!).digest('hex'))
              await checkpoint?.('nodeWritten', write.path)
            }
            await durableWrite(directory, appliedPath, stableJson(commit.pos))
            publishShadow?.()

            for (const change of commit.record.quarantine ?? []) {
              if (change.fault === null) {
                acceptedFaults.delete(change.path);
                faults.delete(change.path)
              } else {
                acceptedFaults.set(change.path, change.fault);
                faults.set(change.path, change.fault)
              }
            }
            for (const write of commit.writes) {
              if (write.node === null) acceptedPositions.delete(write.path)
              else acceptedPositions.set(write.path, write.node.$pos)
            }
            last = commit.pos
            acceptedClock = Math.max(acceptedClock, local.acceptedAt ?? 0)
            if (intent !== undefined) journalBoundary = Math.max(journalBoundary ?? intent.journalBefore, intent.journalBefore)

            if (compaction !== undefined) {
              await journal.publish(compaction.snapshot, compaction.retained, checkpoint, compaction.next.blobArchiveCensus())
              const previousShadow = shadow
              shadow = compaction.next
              previousShadow.close()
              journalFloor = compaction.floor
              decisionBoundary = compaction.decisionBoundary
              journalBoundary = compaction.journalBoundary
              initialRecords = []
            }
          } catch (error) { failed = error; throw error }
          } finally { layout.release?.() }
        })
      },
      close() {
        if (closing !== undefined) return closing
        reporter?.close()
        closing = lease.run(async () => { closed = true; try { await journal.close() } finally { layout.release?.() } })
        return closing
      },
    }
    return store
  })
}
