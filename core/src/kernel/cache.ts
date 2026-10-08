import { isChildPath } from '#core/path'
import { isDeepStrictEqual } from 'node:util'
import { KernelError } from '#errors'
import { comparePositions } from '#kernel/position'
import { DEFAULT_LIMITS, type Budget, type DomainId, type FieldDeltas, type NodeId, type NodeTransition, type Position, type ScanRange, type Store, type StoreCommit, type StoredNode } from '#kernel/types'
import { createInflight } from '#util/inflight'
import { freeze } from '#util/freeze'
import { stableJson } from '#util/stable-json'

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
interface Entry { image: Image; refs: number }
interface Filling {
  readers: number
  generation: number
  bytes: number
  readonly images: Map<NodeId, Image>
}
export interface CacheRead {
  readonly nodes: readonly StoredNode[]
  release(): void
}
export interface CacheOptions {
  readonly uncoveredBytes?: number
  readonly fillBytes?: number
}

const includes = (range: ScanRange, path: string) => 'node' in range ? path === range.node
  : 'children' in range ? isChildPath(range.children, path, true)
    : path === range.subtree || isChildPath(range.subtree, path, false)
const endsAbsent = (change: NodeTransition) => change.t === 'delete' || change.t === 'reconcile' && change.after === null

export function createProcessCache(options: CacheOptions = {}) {
  const entries = new Map<NodeId, Entry>(), paths = new Map<string, NodeId>(), uncovered = new Map<NodeId, Entry>()
  const filling = new Map<DomainId, Filling>()
  const loads = new WeakMap<Store, ReturnType<typeof createInflight<CacheRead>>>()
  const waiters = new WeakMap<Promise<CacheRead>, number>()
  const maxBytes = options.uncoveredBytes ?? DEFAULT_LIMITS.readBytes, fillBytes = options.fillBytes ?? DEFAULT_LIMITS.readBytes
  let bytes = 0, position: Position | undefined

  function remove(id: NodeId, entry: Entry): void {
    entries.delete(id); uncovered.delete(id); bytes -= entry.image.bytes
    if (paths.get(entry.image.path) === id) paths.delete(entry.image.path)
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
  function install(next: Image): Entry {
    let entry = entries.get(next.id)
    if (entry !== undefined) {
      const order = comparePositions(next.pos, entry.image.pos)
      if (order < 0 || order === 0 && (next.delta === undefined && next.journalBytes === undefined || !isDeepStrictEqual(next.node, entry.image.node))) return entry
    }
    if (entry === undefined) { entry = { image: next, refs: 0 }; entries.set(next.id, entry) }
    else {
      if (entry.refs === 0) bytes -= entry.image.bytes
      if (paths.get(entry.image.path) === next.id) paths.delete(entry.image.path)
      entry.image = next
    }
    if (next.node !== null) paths.set(next.node.$path, next.id)
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
  function lease(nodes: readonly StoredNode[], range: ScanRange): CacheRead {
    const held = nodes.map(node => entries.get(node.$id)!)
    const releases = nodes.map(node => retain(node.$id))
    return {
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
  function buffer(next: Image): void {
    const active = filling.get(next.domain)
    if (active === undefined) return
    active.bytes += next.bytes - (active.images.get(next.id)?.bytes ?? 0)
    active.images.set(next.id, next)
    // A stalled fill cannot keep an unbounded history; its caller must retry after a refusal.
    if (active.bytes > fillBytes) { active.generation++; active.images.clear(); active.bytes = 0 }
  }

  async function load(store: Store, range: ScanRange, budget: Budget): Promise<CacheRead> {
    let active = filling.get(store.domain)
    if (active === undefined) { active = { readers: 0, generation: 0, bytes: 0, images: new Map() }; filling.set(store.domain, active) }
    active.readers++
    const generation = active.generation
    try {
      const scanned = await store.scan({ range, budget })
      if (Date.now() > budget.deadline) throw new KernelError('BUDGET', 'Cache fill deadline exceeded')
      if (active.generation !== generation) throw new KernelError('BUDGET', 'Cache fill buffer exceeded')
      const candidates = new Map<NodeId, Image>()
      for (const node of scanned.items) candidates.set(node.$id, image(store.domain, node.$id, node.$path, node, node.$pos))
      for (const next of active.images.values()) {
        const previous = candidates.get(next.id)
        if ((previous !== undefined || includes(range, next.path)) && (previous === undefined || comparePositions(next.pos, previous.pos) > 0)) candidates.set(next.id, next)
      }
      const nodes: StoredNode[] = []
      for (const next of candidates.values()) {
        const entry = install(next)
        if (entry.image.node !== null && includes(range, entry.image.node.$path)) nodes.push(entry.image.node)
      }
      nodes.sort((a, b) => a.$path < b.$path ? -1 : a.$path > b.$path ? 1 : 0)
      checkRows(nodes, budget)
      return lease(nodes, range)
    } finally {
      if (--active.readers === 0) filling.delete(store.domain)
      evict()
    }
  }

  return {
    get(id: NodeId): CachedNode | undefined { return entries.get(id)?.image },
    getAt(path: string): CachedNode | undefined { const id = paths.get(path); return id === undefined ? undefined : entries.get(id)?.image },
    seedJournalBytes(id: NodeId, pos: Position, journalBytes: number): void {
      const entry = entries.get(id)
      if (entry === undefined) throw new KernelError('NOT_FOUND', `Uncached node ${id}`)
      if (comparePositions(entry.image.pos, pos) !== 0) throw new KernelError('CONFLICT', 'Journal checkpoint belongs to another image')
      const { bytes: oldBytes, ...old } = entry.image
      const value = { ...old, journalBytes }
      install(Object.freeze({ ...value, bytes: Buffer.byteLength(JSON.stringify(value)) }))
      evict()
    },
    retain,
    get size(): number { return entries.size },
    get uncoveredBytes(): number { return bytes },
    async fill(store: Store, range: ScanRange, budget: Budget): Promise<CacheRead> {
      if ('node' in range) {
        const id = paths.get(range.node), entry = id === undefined ? undefined : entries.get(id)
        if (entry !== undefined && entry.image.domain === store.domain && entry.image.node !== null) {
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
          return lease(nodes, range)
        } finally {
          const remaining = waiters.get(pending)! - 1
          if (remaining === 0) { waiters.delete(pending); shared.release() }
          else waiters.set(pending, remaining)
        }
      }, error => { waiters.delete(pending); throw error })
    },
    apply(domain: DomainId, commit: StoreCommit): readonly Image[] {
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
      const images = commit.record.entries.map(entry => {
        const written = writes.get(entry.path)
        if (written === undefined) throw new KernelError('INVALID', `Journal entry has no stored write at ${entry.path}`)
        // A deletion and creation can share an address while the stored write holds only the final node.
        const node = endsAbsent(entry.change) ? null : written
        if (!endsAbsent(entry.change) && node === null) throw new KernelError('INVALID', 'Journal update has no stored node')
        if (node !== null && (node.$id !== entry.id || node.$path !== entry.path)) throw new KernelError('INVALID', 'Cache image differs from its journal identity')
        const prior = entries.get(entry.id)?.image
        const changed = entry.change.t === 'update' && entry.change.after === undefined
        const journalBytes = changed ? prior?.journalBytes === undefined ? undefined
          : prior.journalBytes + Buffer.byteLength(JSON.stringify(entry.change.delta)) : 0
        return image(domain, entry.id, entry.path, node, commit.pos, entry.change.t === 'update' ? entry.change.delta : undefined, journalBytes)
      })
      for (const next of images) {
        const prior = entries.get(next.id)
        if (prior !== undefined && comparePositions(next.pos, prior.image.pos) > 0 && paths.get(prior.image.path) === next.id) paths.delete(prior.image.path)
      }
      for (const next of images) { install(next); buffer(next) }
      position = { ...commit.pos }
      evict()
      return images
    },
  }
}

export type ProcessCache = ReturnType<typeof createProcessCache>
