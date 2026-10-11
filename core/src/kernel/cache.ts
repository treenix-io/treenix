import { isChildPath } from '#core/path'
import { isDeepStrictEqual } from 'node:util'
import { createHash } from 'node:crypto'
import { KernelError } from '#errors'
import { comparePositions } from '#kernel/position'
import { DEFAULT_LIMITS, type Budget, type DomainId, type FieldDeltas, type NodeId, type NodeTransition, type Position, type ScanRange, type ScanResult, type Store, type StoreCommit, type StoredNode } from '#kernel/types'
import { createInflight } from '#util/inflight'
import { freeze } from '#util/freeze'
import { stableJson } from '#util/stable-json'
import { runStoreQuery } from '#kernel/store/budget'
import { assertCommitGroups, sameStoreOwner } from '#kernel/store/owner'
import type { StoreCommitGroup } from '#kernel/types'

export interface CachedNode {
  readonly node: StoredNode | null
  readonly pos: Position
  readonly delta?: FieldDeltas
  readonly journalBytes?: number
}

export interface Image extends CachedNode {
  readonly id: NodeId
  readonly path: string
  readonly domain: DomainId
  readonly bytes: number
}
interface Entry { image: Image; refs: number; store: Store }
interface Checkpoint { store: Store; path: string; pos: Position; journalBytes: number; fingerprint?: string; bytes: number }
interface Filling {
  readers: number
  generation: number
  bytes: number
  readonly images: Map<NodeId, Image>
}
export interface CacheRead {
  readonly nodes: readonly StoredNode[]
  readonly cost?: NonNullable<ScanResult<StoredNode>['cost']>
  release(): void
}
export interface CacheOptions {
  readonly external?: (store: Store) => boolean
  readonly uncoveredBytes?: number
  readonly checkpointBytes?: number
  readonly fillBytes?: number
  readonly queryMs?: () => number
}

const includes = (range: ScanRange, path: string) => 'node' in range ? path === range.node
  : 'children' in range ? isChildPath(range.children, path, true)
    : path === range.subtree || isChildPath(range.subtree, path, false)
const endsAbsent = (change: NodeTransition) => change.t === 'delete' || change.t === 'reconcile' && change.after === null

export function createProcessCache(options: CacheOptions = {}) {
  const entries = new Map<NodeId, Entry>(), uncovered = new Map<NodeId, Entry>()
  const paths = new WeakMap<Store, Map<string, NodeId>>()
  const filling = new Map<Store, Filling>()
  const loads = new WeakMap<Store, ReturnType<typeof createInflight<CacheRead>>>()
  const waiters = new WeakMap<Promise<CacheRead>, number>()
  const maxBytes = options.uncoveredBytes ?? DEFAULT_LIMITS.readBytes, fillBytes = options.fillBytes ?? DEFAULT_LIMITS.readBytes
  const checkpoints = new Map<NodeId, Checkpoint>()
  const maxCheckpointBytes = options.checkpointBytes ?? 64 * 1024
  let checkpointBytes = 0
  let bytes = 0, position: Position | undefined

  /** Drops only bounded cadence metadata; losing a hint requires a conservative anchor. */
  function forgetCheckpoint(id: NodeId): void {
    const prior = checkpoints.get(id)
    if (prior !== undefined) {
      checkpointBytes -= prior.bytes
      checkpoints.delete(id)
    }
  }

  /** Fingerprints physical before-images only for Stores that admit external writes. */
  function fingerprint(store: Store, node: StoredNode): string | undefined {
    return options.external?.(store) === true ? createHash('sha256').update(stableJson(node)).digest('hex') : undefined
  }

  /** Retains accepted cadence independently of payload leases and their eviction. */
  function rememberCheckpoint(store: Store, next: Image): void {
    forgetCheckpoint(next.id)
    if (next.node === null || next.journalBytes === undefined) return

    const metadata = { id: next.id, path: next.path, pos: { ...next.node.$pos }, journalBytes: next.journalBytes, fingerprint: fingerprint(store, next.node) }
    const size = Buffer.byteLength(JSON.stringify(metadata))
    checkpoints.set(next.id, { ...metadata, store, bytes: size })
    checkpointBytes += size
    while (checkpointBytes > maxCheckpointBytes || checkpoints.size > 1000) {
      const oldest = checkpoints.keys().next().value
      if (oldest === undefined) throw new KernelError('INVALID', 'Checkpoint byte ledger has no entry')
      forgetCheckpoint(oldest)
    }
  }

  /** Matches the actual data owner and exact image before using its cadence hint. */
  function getJournalBytes(store: Store, before: StoredNode): number | undefined {
    const entry = entries.get(before.$id), cached = entry?.image
    if (entry?.store === store && cached?.path === before.$path && comparePositions(cached.pos, before.$pos) === 0 &&
      cached.journalBytes !== undefined && (options.external?.(store) !== true || isDeepStrictEqual(cached.node, before))) return cached.journalBytes

    const prior = checkpoints.get(before.$id)
    if (prior === undefined) return undefined
    if (prior.store !== store || prior.path !== before.$path || comparePositions(prior.pos, before.$pos) !== 0) return undefined
    if (prior.fingerprint !== fingerprint(store, before)) {
      forgetCheckpoint(before.$id)
      return undefined
    }

    checkpoints.delete(before.$id)
    checkpoints.set(before.$id, prior)
    return prior.journalBytes
  }

  function pathIndex(store: Store): Map<string, NodeId> {
    let index = paths.get(store)
    if (index === undefined) { index = new Map(); paths.set(store, index) }
    return index
  }
  function assertOwner(store: Store, id: NodeId): void {
    const checkpoint = checkpoints.get(id)
    if (checkpoint !== undefined && checkpoint.store !== store) throw new KernelError('INVALID', 'Node identity belongs to another Store')
    const previous = entries.get(id)
    if (previous !== undefined && previous.store !== store &&
      (previous.image.node !== null || !sameStoreOwner(previous.store, store)))
      throw new KernelError('INVALID', 'Node identity belongs to another Store')
  }
  function remove(id: NodeId, entry: Entry): void {
    entries.delete(id); uncovered.delete(id); bytes -= entry.image.bytes
    const index = pathIndex(entry.store)
    if (index.get(entry.image.path) === id) index.delete(entry.image.path)
  }
  function evict(): void {
    while (bytes > maxBytes) {
      const first = uncovered.entries().next().value
      if (first === undefined) break
      remove(first[0], first[1])
    }
  }
  function image(domain: DomainId, id: NodeId, path: string, node: StoredNode | null, pos: Position, delta?: FieldDeltas, journalBytes?: number): Image {
    const value = structuredClone({ id, path, domain, node, pos, ...(delta === undefined ? {} : { delta }),
      ...(journalBytes === undefined ? {} : { journalBytes }) })
    return freeze({ ...value, bytes: Buffer.byteLength(JSON.stringify(value)) })
  }
  function install(store: Store, next: Image): Entry {
    assertOwner(store, next.id)
    const index = pathIndex(store)
    let entry = entries.get(next.id)
    if (entry !== undefined) {
      const order = comparePositions(next.pos, entry.image.pos)
      if (order < 0 || order === 0 && options.external?.(store) !== true && (next.delta === undefined && next.journalBytes === undefined || !isDeepStrictEqual(next.node, entry.image.node))) return entry
    }
    if (entry === undefined) { entry = { image: next, refs: 0, store }; entries.set(next.id, entry) }
    else {
      if (entry.refs === 0) bytes -= entry.image.bytes
      if (index.get(entry.image.path) === next.id) index.delete(entry.image.path)
      entry.image = next
      entry.store = store
    }
    if (next.node !== null) index.set(next.node.$path, next.id)
    if (entry.refs === 0) { bytes += next.bytes; uncovered.delete(next.id); uncovered.set(next.id, entry) }
    return entry
  }
  function retain(id: NodeId): () => void {
    const entry = entries.get(id)
    if (entry === undefined) throw new KernelError('NOT_FOUND', `Uncached node ${id}`)
    if (entry.refs++ === 0) { uncovered.delete(id); bytes -= entry.image.bytes }
    let released = false
    return () => {
      if (released) return
      released = true
      if (--entry.refs === 0 && entries.get(id) === entry) {
        uncovered.set(id, entry); bytes += entry.image.bytes; evict()
      }
    }
  }
  function checkRows(nodes: readonly StoredNode[], budget: Budget): void {
    if (nodes.length > budget.nodes) throw new KernelError('BUDGET', 'Cache read node budget exceeded')
    let loadedBytes = 0
    for (const node of nodes) {
      if (Date.now() > budget.deadline) throw new KernelError('BUDGET', 'Cache read deadline exceeded')
      loadedBytes += Buffer.byteLength(JSON.stringify(node))
      if (loadedBytes > budget.bytes) throw new KernelError('BUDGET', 'Cache read byte budget exceeded')
    }
    if (Date.now() > budget.deadline) throw new KernelError('BUDGET', 'Cache read deadline exceeded')
  }
  function lease(nodes: readonly StoredNode[], range: ScanRange, cost?: CacheRead['cost']): CacheRead {
    const held = nodes.map(node => entries.get(node.$id)!)
    const releases = nodes.map(node => retain(node.$id))
    return {
      cost,
      get nodes(): readonly StoredNode[] {
        const current: StoredNode[] = []
        for (const entry of held) {
          const node = entry.image.node
          if (node !== null && includes(range, node.$path)) current.push(node)
        }
        return Object.freeze(current.sort((a, b) => a.$path < b.$path ? -1 : a.$path > b.$path ? 1 : 0))
      },
      release() { for (const release of releases) release() },
    }
  }
  function buffer(store: Store, next: Image): void {
    const active = filling.get(store)
    if (active === undefined) return
    active.bytes += next.bytes - (active.images.get(next.id)?.bytes ?? 0)
    active.images.set(next.id, next)
    // A stalled fill cannot keep an unbounded history; its caller must retry after a refusal.
    if (active.bytes > fillBytes) { active.generation++; active.images.clear(); active.bytes = 0 }
  }

  async function load(store: Store, range: ScanRange, budget: Budget): Promise<CacheRead> {
    let active = filling.get(store)
    if (active === undefined) { active = { readers: 0, generation: 0, bytes: 0, images: new Map() }; filling.set(store, active) }
    active.readers++
    const generation = active.generation
    try {
      const scanned = await runStoreQuery(
        budget,
        options.queryMs?.() ?? DEFAULT_LIMITS.queryMs,
        (queryBudget) => store.scan({ range, budget: queryBudget }),
      );
      if (Date.now() > budget.deadline) throw new KernelError('BUDGET', 'Cache fill deadline exceeded')
      if (active.generation !== generation) throw new KernelError('BUDGET', 'Cache fill buffer exceeded')
      const candidates = new Map<NodeId, Image>()
      for (const node of scanned.items) {
        if (candidates.has(node.$id)) throw new KernelError('INVALID', 'Duplicate Store node identity')
        candidates.set(node.$id, image(store.domain, node.$id, node.$path, node, node.$pos))
      }
      for (const next of active.images.values()) {
        const previous = candidates.get(next.id)
        if ((previous !== undefined || includes(range, next.path)) && (previous === undefined || comparePositions(next.pos, previous.pos) > 0)) candidates.set(next.id, next)
      }
      for (const next of candidates.values()) assertOwner(store, next.id)
      if (options.external?.(store) === true && 'node' in range && candidates.size === 0) {
        const prior = paths.get(store)?.get(range.node)
        if (prior !== undefined) {
          const previous = entries.get(prior)!.image
          install(store, image(store.domain, prior, range.node, null, previous.pos))
        }
      }
      const nodes: StoredNode[] = []
      for (const next of candidates.values()) {
        const entry = install(store, next)
        if (entry.image.node !== null && includes(range, entry.image.node.$path)) nodes.push(entry.image.node)
      }
      nodes.sort((a, b) => a.$path < b.$path ? -1 : a.$path > b.$path ? 1 : 0)
      checkRows(nodes, budget)
      return lease(nodes, range, scanned.cost)
    } finally {
      if (--active.readers === 0) filling.delete(store)
      evict()
    }
  }

  /** Builds and validates only the images affected by one canonical commit. */
  function prepareImages(store: Store, commit: StoreCommit, owners?: ReadonlyMap<string, Store>): readonly Image[] {
    if (position !== undefined && comparePositions(commit.pos, position) <= 0) throw new KernelError('INVALID', 'Cache commit positions must increase')
    const writes = new Map(commit.writes.map(write => [write.path, write.node]))
    const recorded = new Set(commit.record.entries.flatMap(entry => entry.from === undefined ? [entry.path] : [entry.from, entry.path]))
    const live = new Map<string, NodeId>()
    for (const entry of commit.record.entries) if (!endsAbsent(entry.change)) live.set(entry.path, entry.id)
    for (const write of commit.writes) {
      if (!recorded.has(write.path) || write.node !== null && live.get(write.path) !== write.node.$id) {
        throw new KernelError('INVALID', `Stored write has no matching journal entry at ${write.path}`)
      }
    }
    return commit.record.entries.map(entry => {
      const written = writes.get(entry.path)
      if (written === undefined) throw new KernelError('INVALID', `Journal entry has no stored write at ${entry.path}`)
      // A deletion and creation can share an address while the stored write holds only the final node.
      const node = endsAbsent(entry.change) ? null : written
      if (!endsAbsent(entry.change) && node === null) throw new KernelError('INVALID', 'Journal update has no stored node')
      if (node !== null && (node.$id !== entry.id || node.$path !== entry.path)) throw new KernelError('INVALID', 'Cache image differs from its journal identity')
      const owner = owners === undefined ? store : owners.get(entry.from ?? entry.path)
      if (owner === undefined) throw new KernelError('INVALID', 'Journal source has no atomic participant')
      const cached = entries.get(entry.id)
      const prior = checkpoints.get(entry.id)
      const cachedBytes = cached?.store === owner && cached.image.path === (entry.from ?? entry.path) && comparePositions(cached.image.pos, commit.pos) < 0 ? cached.image.journalBytes : undefined
      const known = cachedBytes ?? (prior?.store === owner && prior.path === (entry.from ?? entry.path) && comparePositions(prior.pos, commit.pos) < 0 ? prior.journalBytes : undefined)
      const changed = entry.change.t === 'update' && entry.change.after === undefined
      const journalBytes = changed ? known === undefined ? undefined
        : known + Buffer.byteLength(JSON.stringify(entry.change.delta)) : 0
      return image(store.domain, entry.id, entry.path, node, commit.pos, entry.change.t === 'update' ? entry.change.delta : undefined, journalBytes)
    })
  }

  return {
    /** Validates every image and ownership transfer before the shared owner persists anything. */
    stageGroups(store: Store, commit: StoreCommit, groups: readonly StoreCommitGroup[]): () => readonly Image[] {
      assertCommitGroups(store, commit, groups)
      const owners = new Map(groups.flatMap(group => group.writes.map(write => [write.path, group.store] as const)))
      const images = prepareImages(store, commit, owners)
      const writes = new Map(commit.writes.map(write => [write.path, write.node]))
      const liveIds = new Set<NodeId>()
      const staged = images.map(next => {
        if (next.node !== null) {
          if (liveIds.has(next.id)) throw new KernelError('INVALID', 'Duplicate accepted node identity')
          liveIds.add(next.id)
        }
        const owner = owners.get(next.path)
        if (owner === undefined) throw new KernelError('INVALID', 'Journal entry has no atomic participant')
        const previous = entries.get(next.id)
        const checkpoint = checkpoints.get(next.id)
        if (previous === undefined && checkpoint !== undefined && checkpoint.store !== owner &&
          (!sameStoreOwner(checkpoint.store, owner) || owners.get(checkpoint.path) !== checkpoint.store || (writes.get(checkpoint.path) === undefined || writes.get(checkpoint.path)?.$id === next.id)))
          throw new KernelError('INVALID', 'Node identity belongs to another Store')
        const replacement = previous === undefined ? undefined : writes.get(previous.image.path)
        if (previous !== undefined && previous.store !== owner &&
          (!sameStoreOwner(previous.store, owner) || previous.image.node !== null &&
            (owners.get(previous.image.path) !== previous.store || replacement === undefined || replacement !== null && replacement.$id === next.id)))
          throw new KernelError('INVALID', 'Node identity belongs to another Store')
        return { owner, image: next }
      })
      return () => {
        for (const next of staged) {
          const previous = entries.get(next.image.id)
          if (previous !== undefined) {
            const index = pathIndex(previous.store)
            if (index.get(previous.image.path) === next.image.id) index.delete(previous.image.path)
          }
        }
        for (const next of staged) {
          const previous = entries.get(next.image.id)
          if (previous !== undefined) previous.store = next.owner
          forgetCheckpoint(next.image.id)
          install(next.owner, next.image)
          buffer(next.owner, next.image)
          rememberCheckpoint(next.owner, next.image)
        }
        position = { ...commit.pos }
        evict()
        return staged.map(next => next.image)
      }
    },
    /** Release retired ownership after Writer readers drain; retained images keep their own release closures. */
    retireStore(store: Store): void {
      for (const [id, entry] of entries) if (entry.store === store) {
        entries.delete(id)
        uncovered.delete(id)
        if (entry.refs === 0) bytes -= entry.image.bytes
      }
      for (const [id, checkpoint] of checkpoints) if (checkpoint.store === store) forgetCheckpoint(id)
      paths.delete(store)
    },
    getJournalBytes,
    get checkpointCost() { return { bytes: checkpointBytes, entries: checkpoints.size } },
    get(id: NodeId): Image | undefined { return entries.get(id)?.image },
    getAt(store: Store, path: string): Image | undefined { const id = paths.get(store)?.get(path); return id === undefined ? undefined : entries.get(id)?.image },
    seedJournalBytes(id: NodeId, pos: Position, journalBytes: number): void {
      const entry = entries.get(id)
      if (entry === undefined) throw new KernelError('NOT_FOUND', `Uncached node ${id}`)
      if (comparePositions(entry.image.pos, pos) !== 0) throw new KernelError('CONFLICT', 'Journal checkpoint belongs to another image')
      const { bytes: oldBytes, ...old } = entry.image
      const value = { ...old, journalBytes }
      const next = Object.freeze({ ...value, bytes: Buffer.byteLength(JSON.stringify(value)) })
      install(entry.store, next)
      rememberCheckpoint(entry.store, next)
      evict()
    },
    retain,
    get size(): number { return entries.size },
    get uncoveredBytes(): number { return bytes },
    async fill(store: Store, range: ScanRange, budget: Budget): Promise<CacheRead> {
      if ('node' in range && options.external?.(store) !== true) {
        const id = paths.get(store)?.get(range.node), entry = id === undefined ? undefined : entries.get(id)
        if (entry !== undefined && entry.image.node !== null) {
          checkRows([entry.image.node], budget)
          return lease([entry.image.node], range)
        }
      }
      let dedup = loads.get(store)
      if (dedup === undefined) { dedup = createInflight<CacheRead>(); loads.set(store, dedup) }
      const pending = dedup(stableJson([range, budget]), () => load(store, range, budget))
      waiters.set(pending, (waiters.get(pending) ?? 0) + 1)
      return pending.then(shared => {
        try {
          const nodes = shared.nodes
          checkRows(nodes, budget)
          return lease(nodes, range, shared.cost)
        } finally {
          const remaining = waiters.get(pending)! - 1
          if (remaining === 0) { waiters.delete(pending); shared.release() }
          else waiters.set(pending, remaining)
        }
      }, error => { waiters.delete(pending); throw error })
    },
    apply(store: Store, commit: StoreCommit): readonly Image[] {
      const images = prepareImages(store, commit)
      for (const next of images) assertOwner(store, next.id)
      const index = pathIndex(store)
      for (const next of images) {
        const prior = entries.get(next.id)
        if (prior !== undefined && comparePositions(next.pos, prior.image.pos) > 0 && index.get(prior.image.path) === next.id) index.delete(prior.image.path)
      }
      for (const next of images) { install(store, next); buffer(store, next); rememberCheckpoint(store, next) }
      position = { ...commit.pos }
      evict()
      return images
    },
  }
}

export type ProcessCache = ReturnType<typeof createProcessCache>
