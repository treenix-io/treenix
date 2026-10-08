import { KernelError } from '#errors'
import { createProcessCache, type CacheRead, type ProcessCache } from '#kernel/cache'
import type { NodeChange } from '#kernel/changeset'
import { createInfluenceIndex, type InfluenceOptions } from '#kernel/influence'
import { createIdempotency, type IdempotencyOptions, type MutationIdentity } from '#kernel/idempotency'
import { comparePositions } from '#kernel/position'
import { createInstanceStream, type StreamDomain } from '#kernel/stream'
import { DEFAULT_LIMITS, type Budget, type DomainId, type JournalCommit, type Outcome, type Position, type Store, type StoreCommit, type StoredWrite, type StreamEvent } from '#kernel/types'

export interface PositionCounter {
  load(): Promise<Position | undefined>
  save(position: Position, writerEpoch: number): Promise<void>
  /** The lease provider reserves a never-used epoch above every previously issued epoch. */
  freshEpoch(previous: number): Promise<number>
}

export interface WriterOptions {
  readonly instance: string
  readonly root: Store
  readonly writerEpoch: number
  readonly domains: readonly StreamDomain[]
  readonly counter: PositionCounter
  readonly budget?: () => Budget
  readonly cache?: ProcessCache
  readonly influence?: Pick<InfluenceOptions, 'maxWrites' | 'maxBytes'>
  readonly intake?: Pick<IdempotencyOptions, 'now' | 'limits'>
}

export interface PreparedCommit {
  readonly writes: readonly StoredWrite[]
  readonly record: JournalCommit
  readonly transitions?: readonly NodeChange[]
}
export interface PreparedMutation extends PreparedCommit { readonly value?: unknown }
export interface MutationSpan {
  step(store: Store, reads: readonly DomainId[], prepare: (position: Position) => PreparedCommit | Promise<PreparedCommit>): Promise<Position>
  finish(store: Store, reads: readonly DomainId[], prepare: (position: Position) => PreparedMutation | Promise<PreparedMutation>): Promise<Outcome>
}

type Applied =
  | { readonly t: 'committed'; readonly pos: Position; readonly domain: DomainId; readonly commit: StoreCommit; readonly changes: readonly NodeChange[] | null; readonly event: StreamEvent }
  | { readonly t: 'gap'; readonly pos: Position; readonly event: StreamEvent; readonly error: unknown }
  | { readonly t: 'refused'; readonly error: unknown }

export async function createWriter(options: WriterOptions) {
  const cache = options.cache ?? createProcessCache()
  const budget = options.budget ?? (() => ({ nodes: DEFAULT_LIMITS.readNodes, bytes: DEFAULT_LIMITS.readBytes,
    exprWork: DEFAULT_LIMITS.exprWork, deadline: Date.now() + DEFAULT_LIMITS.queryMs }))
  const loaded = await options.counter.load()
  let maximum: Position = { instance: options.instance, epoch: 0, seq: 0 }
  for (const domain of options.domains) {
    if (!domain.persistent) continue
    const rows = await domain.store.scan({ range: { journal: '/' }, where: { 'pos.instance': options.instance },
      sort: [['pos.epoch', -1], ['pos.seq', -1]], limit: 1, budget: budget() })
    const last = rows.items[0]?.pos
    if (last !== undefined && comparePositions(last, maximum) > 0) maximum = last
  }
  let position: Position
  if (loaded !== undefined && loaded.instance === options.instance && comparePositions(loaded, maximum) >= 0) position = { ...loaded }
  else {
    const floor = loaded?.instance === options.instance ? Math.max(loaded.epoch, maximum.epoch) : maximum.epoch
    const epoch = await options.counter.freshEpoch(floor)
    if (!Number.isSafeInteger(epoch) || epoch <= floor) throw new KernelError('INVALID', 'Instance epoch must be fresh and increasing')
    position = { instance: options.instance, epoch, seq: 0 }
    await options.counter.save(position, options.writerEpoch)
  }
  const stream = createInstanceStream({ position, domains: options.domains, budget })
  const domains = new Set(options.domains.map(domain => domain.store.domain))
  const stores = new Set(options.domains.map(domain => domain.store))
  if (!stores.has(options.root)) throw new KernelError('INVALID', 'Root Store is not a declared target')
  const intake = await createIdempotency({ root: options.root, domains: options.domains, budget, ...options.intake })
  const influence = createInfluenceIndex({ position, domains: [...domains], ...options.influence })
  const writers = new Map<DomainId, Promise<void>>()
  const readers = new Map<DomainId, Set<Promise<void>>>()
  let reservation = Promise.resolve(), publication = Promise.resolve()
  let fatal: { readonly error: unknown } | undefined

  function allocate(): Promise<Position> {
    const next = reservation.then(async () => {
      if (!Number.isSafeInteger(position.seq + 1)) throw new KernelError('BUDGET', 'Position counter exhausted')
      const assigned = { ...position, seq: position.seq + 1 }
      // A failed reservation never issues a position; issued gaps are durable counter entries too.
      await options.counter.save(assigned, options.writerEpoch)
      position = assigned
      return assigned
    })
    reservation = next.then(() => {}, error => { console.error(error) })
    return next
  }

  // Fence every target before serving writes: an old process may have reserved a position already.
  for (const store of stores) {
    const pos = await allocate()
    const record: JournalCommit = { pos, kind: 'kernel', executor: 'kernel', caller: 'kernel', entries: [],
      ...(store === options.root ? { intake: intake.next(pos) } : {}) }
    try {
      const commit = { pos, writerEpoch: options.writerEpoch, writes: [], record }
      await store.commit(commit)
      if (record.intake !== undefined) intake.publish(record.intake)
      cache.apply(store.domain, commit)
      influence.record(store.domain, pos, [])
      stream.publish({ t: 'commit', domain: store.domain, record })
    } catch (error) {
      console.error(error)
      influence.advance(pos)
      stream.publish({ t: 'gap', pos })
      throw error
    }
  }

  function commit(store: Store, reads: readonly DomainId[], prepare: (position: Position) => PreparedCommit | Promise<PreparedCommit>): Promise<Position> {
      if (fatal !== undefined) return Promise.reject(fatal.error)
      if (!stores.has(store) || reads.some(domain => !domains.has(domain))) return Promise.reject(new KernelError('INVALID', 'Unknown transaction domain'))
      const inputDomains = new Set([...reads, store.domain])
      const dependencies = new Set<Promise<void>>()
      for (const domain of inputDomains) {
        const prior = writers.get(domain)
        if (prior !== undefined) dependencies.add(prior)
      }
      for (const prior of readers.get(store.domain) ?? []) dependencies.add(prior)
      let release: () => void = () => {}
      const done = new Promise<void>(resolve => { release = resolve })
      writers.set(store.domain, done)
      for (const domain of reads) {
        let active = readers.get(domain)
        if (active === undefined) { active = new Set(); readers.set(domain, active) }
        active.add(done)
      }
      const assigned = allocate()
      const applied: Promise<Applied> = (async () => {
        let pos: Position | undefined
        const leases: CacheRead[] = []
        try {
          pos = await assigned
          await Promise.all(dependencies)
          const prepared = await prepare(pos)
          let changes: readonly NodeChange[] | null = prepared.transitions ?? null
          if (prepared.transitions === undefined && !prepared.record.entries.some(entry => entry.change.t === 'reconcile' && entry.change.before === undefined)) {
            const captured: NodeChange[] = [], allowance = budget()
            const after = new Map(prepared.writes.map(write => [write.path, write.node]))
            let nodes = 0, bytes = 0
            for (const entry of prepared.record.entries) {
              const lease = await cache.fill(store, { node: entry.from ?? entry.path }, allowance)
              leases.push(lease)
              const before = entry.change.t === 'reconcile' ? entry.change.before! : lease.nodes[0] ?? null
              if (before !== null) { nodes++; bytes += Buffer.byteLength(JSON.stringify(before)) }
              if (nodes > allowance.nodes || bytes > allowance.bytes) throw new KernelError('BUDGET', 'Influence capture exceeded the read budget')
              const node = entry.change.t === 'delete' ? null : after.get(entry.path)!
              captured.push({ id: entry.id, before, after: node })
            }
            changes = captured
          }
          const commit: StoreCommit = { writes: prepared.writes, record: prepared.record, pos, writerEpoch: options.writerEpoch }
          await store.commit(commit)
          return { t: 'committed', pos, domain: store.domain, commit, changes, event: { t: 'commit', domain: store.domain, record: commit.record } }
        } catch (error) {
          if (pos === undefined) return { t: 'refused', error }
          console.error(error)
          return { t: 'gap', pos, event: { t: 'gap', pos }, error }
        } finally {
          for (const lease of leases) lease.release()
        }
      })()
      const settled = publication.then(async () => {
        const result = await applied
        if (fatal !== undefined) throw fatal.error
        if (result.t === 'committed') {
          if (result.commit.record.intake !== undefined) intake.publish(result.commit.record.intake)
          const images = new Map(cache.apply(result.domain, result.commit).map(image => [image.id, image.node]))
          if (result.changes === null) influence.reset(result.domain, result.pos)
          else influence.record(result.domain, result.pos, result.changes.map(change => ({ ...change,
            after: change.after === null ? null : images.get(change.id)! })))
        } else if (result.t === 'gap') influence.advance(result.pos)
        if (result.t !== 'refused') stream.publish(result.event)
        return result
      }).finally(() => {
        // Later rights checks read the shared cache, so completion includes its ordered update.
        release()
        if (writers.get(store.domain) === done) writers.delete(store.domain)
        for (const domain of reads) {
          const active = readers.get(domain)
          active?.delete(done)
          if (active?.size === 0) readers.delete(domain)
        }
      })
      publication = settled.then(() => {}, error => { console.error(error); fatal = { error } })
      return settled.then(result => {
        if (result.t !== 'committed') throw result.error
        return result.pos
      })
  }
  async function refreshIntake(force = false): Promise<void> {
    await commit(options.root, [...domains], pos => ({ writes: [], transitions: [],
      record: { pos, kind: 'kernel', executor: 'kernel', caller: 'kernel', entries: [], intake: intake.next(pos, force) } }))
  }
  async function mutate(input: MutationIdentity, execute: (span: MutationSpan) => Promise<unknown>): Promise<Outcome> {
    if (fatal !== undefined) throw fatal.error
    return intake.run(input, () => refreshIntake(), async decision => {
      let started = false, pending = false, outcome: Outcome | undefined
      async function apply(store: Store, reads: readonly DomainId[], prepare: (pos: Position) => PreparedMutation | Promise<PreparedMutation>, finish: boolean): Promise<Position> {
        if (pending || outcome !== undefined) throw new KernelError('INVALID', 'Mutation steps must be ordered and finish once')
        pending = true
        try {
          let final: Outcome | undefined
          const position = await commit(store, [...new Set([...reads, options.root.domain])], async pos => {
            intake.checkAdmitted(input.opId)
            const prepared = await prepare(pos)
            if (prepared.record.caller !== input.actor.principal) throw new KernelError('INVALID', 'Mutation caller differs from its journal')
            const value: Outcome = structuredClone({ pos, ...(Object.hasOwn(prepared, 'value') ? { value: prepared.value } : {}) })
            const record = { ...prepared.record, ...(finish || !started ? {
              decision: { ...decision, ...(finish ? { outcome: value } : {}) },
            } : {}) }
            if (finish) final = value
            return { ...prepared, record }
          })
          if (finish) outcome = final
          return position
        } finally { pending = false }
      }
      const span: MutationSpan = {
        async step(store, reads, prepare) {
          if (input.stream === undefined) throw new KernelError('INVALID', 'Only a stream has intermediate mutation steps')
          const pos = await apply(store, reads, prepare, false)
          started = true
          return pos
        },
        async finish(store, reads, prepare) {
          await apply(store, reads, prepare, true)
          return structuredClone(outcome!)
        },
      }
      await execute(span)
      if (outcome === undefined) throw new KernelError('INVALID', 'Mutation returned without its durable final outcome')
      return outcome
    })
  }
  return { stream, cache, influence, get position(): Position { return { ...position } },
    get intake() { return intake.state }, commit, mutate, refreshIntake }
}
