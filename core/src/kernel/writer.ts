import { KernelError } from '#errors'
import { createProcessCache, type CacheRead, type Image, type ProcessCache } from '#kernel/cache'
import type { NodeChange } from '#kernel/changeset'
import { createInfluenceIndex, type InfluenceOptions } from '#kernel/influence'
import { createIdempotency, type IdempotencyOptions, type MutationIdentity, type MutationWaiter } from '#kernel/idempotency'
import { comparePositions } from '#kernel/position'
import { createInstanceStream, streamDomainEpochs } from '#kernel/stream'
import { DEFAULT_LIMITS, type Budget, type DomainId, type JournalCommit, type OpenedStoreMountTarget, type Outcome, type Position, type PositionCounter, type Rev, type Store, type StoreCommit, type StoredWrite, type StreamDomain, type StreamEvent } from '#kernel/types'

export interface StoreTargetRegistration {
  readonly key: string
  readonly revision: Rev
  readonly target: OpenedStoreMountTarget
}
export interface TargetPublication {
  readonly registration: StoreTargetRegistration
  readonly pos: Position
  readonly kind: 'activate' | 'retire'
}
export interface TargetLifecycle {
  validate(registration: StoreTargetRegistration): void
  publish(event: TargetPublication): void
}
interface TargetPin {
  readonly registration: StoreTargetRegistration
  readonly writerEpoch: number
  active: boolean
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
  readonly applied?: (domain: DomainId, commit: StoreCommit, images: readonly Image[], store: Store) => void
  readonly targetLifecycle?: TargetLifecycle
}

export interface PreparedCommit {
  readonly writes: readonly StoredWrite[]
  readonly record: JournalCommit
  readonly transitions?: readonly NodeChange[]
  readonly check?: () => void
}
export interface PreparedMutation extends PreparedCommit { readonly value?: unknown }
export interface MutationSpan {
  step(store: Store, reads: readonly DomainId[], prepare: (position: Position) => PreparedCommit | Promise<PreparedCommit>): Promise<Position>
  finish(store: Store, reads: readonly DomainId[], prepare: (position: Position) => PreparedMutation | Promise<PreparedMutation>): Promise<Outcome>
}

type Applied =
  | { readonly t: 'committed'; readonly pos: Position; readonly domain: DomainId; readonly store: Store; readonly commit: StoreCommit; readonly changes: readonly NodeChange[] | null; readonly event: StreamEvent }
  | { readonly t: 'gap'; readonly pos: Position; readonly event: StreamEvent; readonly error: unknown }
  | { readonly t: 'refused'; readonly error: unknown }

/** Refuses invalid domain bindings before the counter or Store can accept an effect. */
export function assertWriterDomains(root: Store, domains: readonly StreamDomain[]): void {
  streamDomainEpochs(domains)
  if (!domains.some(domain => domain.store === root))
    throw new KernelError('INVALID', 'Root Store is not a declared target')
}

/** Owns ordered positions, commit delivery, decision intake, and registered target lifetimes. */
export async function createWriter(options: WriterOptions) {
  assertWriterDomains(options.root, options.domains)
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
  let inventory = [...options.domains]
  const targets = new Map<string, TargetPin>()
  const storePins = new Map<Store, TargetPin>()
  const domainPins = new Map<DomainId, Set<TargetPin>>()
  const cleanup = new WeakMap<OpenedStoreMountTarget, Promise<void>>()
  const ownedTargets = new Set<OpenedStoreMountTarget>()
  const intake = await createIdempotency({ root: options.root, domains: options.domains, budget, ...options.intake })
  const influence = createInfluenceIndex({ position, domains: [...domains], ...options.influence })
  const writers = new Map<DomainId, Promise<void>>()
  const readers = new Map<DomainId, Set<Promise<void>>>()
  let reservation = Promise.resolve(), publication = Promise.resolve()
  let admission = Promise.resolve()
  let fatal: { readonly error: unknown } | undefined
  let closing = false, closedTargets: Promise<void> | undefined
  function checkFailure(): void {
    if (fatal !== undefined) throw fatal.error
    if (closing) throw new KernelError('UNAVAILABLE', 'Writer is closing')
  }

  /** Persist the next position before making it available to a Store. */
  async function reservePosition(): Promise<Position> {
    if (!Number.isSafeInteger(position.seq + 1))
      throw new KernelError('BUDGET', 'Position counter exhausted');
    const assigned = { ...position, seq: position.seq + 1 };
    // A failed reservation never issues a position; issued gaps are durable counter entries too.
    await options.counter.save(assigned, options.writerEpoch);
    position = assigned;
    return assigned;
  }
  function allocate(): Promise<Position> {
    const barrier = admission
    const next = reservation.then(() => barrier).then(() => { checkFailure(); return reservePosition() })
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
      const images = cache.apply(store, commit)
      options.applied?.(store.domain, commit, images, store)
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
      try { checkFailure() } catch (error) { return Promise.reject(error) }
      if (!stores.has(store) || reads.some(domain => !domains.has(domain))) return Promise.reject(new KernelError('INVALID', 'Unknown transaction domain'))
      const pin = storePins.get(store)
      const writerEpoch = pin?.writerEpoch ?? options.writerEpoch
      const assertPin = () => {
        if (pin !== undefined) {
          if (!pin.active || storePins.get(store) !== pin) throw new KernelError('UNAVAILABLE', 'Target registration changed')
          options.targetLifecycle!.validate(pin.registration)
        }
      }
      try { assertPin() } catch (error) { return Promise.reject(error) }
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
          checkFailure()
          assertPin()
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
          const commit: StoreCommit = { writes: prepared.writes, record: prepared.record, pos, writerEpoch }
          checkFailure()
          assertPin()
          prepared.check?.()
          await store.commit(commit)
          return { t: 'committed', pos, domain: store.domain, store, commit, changes, event: { t: 'commit', domain: store.domain, record: commit.record } }
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
          const accepted = cache.apply(result.store, result.commit)
          options.applied?.(result.domain, result.commit, accepted, result.store)
          const images = new Map(accepted.map(image => [image.id, image.node]))
          if (result.changes === null) influence.reset(result.domain, result.pos)
          else influence.record(result.domain, result.pos, result.changes.map(change => ({ ...change,
            after: change.after === null ? null : images.get(change.id)! })))
        } else if (result.t === 'gap') influence.advance(result.pos)
        if (result.t !== 'refused') stream.publish(result.event)
        return result
      }).catch(error => { fatal = { error }; throw error }).finally(() => {
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
  async function read<T>(inputs: readonly DomainId[], run: () => Promise<T>): Promise<T> {
    checkFailure()
    const locked = new Set(inputs)
    const pinned = new Set<TargetPin>()
    for (const domain of locked) for (const pin of domainPins.get(domain) ?? []) pinned.add(pin)
    if ([...locked].some(domain => !domains.has(domain))) throw new KernelError('INVALID', 'Unknown read domain')
    const dependencies = new Set<Promise<void>>()
    dependencies.add(admission)
    let release: () => void = () => {}
    const done = new Promise<void>(resolve => { release = resolve })
    for (const domain of locked) {
      const prior = writers.get(domain)
      if (prior !== undefined) dependencies.add(prior)
      let active = readers.get(domain)
      if (active === undefined) { active = new Set(); readers.set(domain, active) }
      active.add(done)
    }
    try {
      await Promise.all(dependencies)
      checkFailure()
      if ([...locked].some(domain => !domains.has(domain))) throw new KernelError('UNAVAILABLE', 'Read target was retired')
      for (const pin of pinned) {
        if (!pin.active || storePins.get(pin.registration.target.store) !== pin)
          throw new KernelError('UNAVAILABLE', 'Read target registration changed')
        options.targetLifecycle!.validate(pin.registration)
      }
      return await run()
    } finally {
      release()
      for (const domain of locked) {
        const active = readers.get(domain)
        active?.delete(done)
        if (active?.size === 0) readers.delete(domain)
      }
    }
  }
  async function refreshIntake(force = false): Promise<void> {
    await commit(options.root, [...domains], pos => ({ writes: [], transitions: [],
      record: { pos, kind: 'kernel', executor: 'kernel', caller: 'kernel', entries: [], intake: intake.next(pos, force) } }))
  }
  /** Release the resource exactly once, including concurrent failed-open and retirement paths. */
  function closeTarget(target: OpenedStoreMountTarget): Promise<void> {
    let pending = cleanup.get(target)
    if (pending === undefined) {
      pending = Promise.resolve().then(() => target.close()).then(() => { ownedTargets.delete(target) })
      cleanup.set(target, pending)
    }
    return pending
  }

  /** Reserve a lifecycle span before subsequent allocations and domain readers enter. */
  function lifecycle<T>(run: () => Promise<T>): Promise<T> {
    const dependencies = new Set([admission, reservation, publication, ...writers.values()])
    for (const active of readers.values()) for (const done of active) dependencies.add(done)
    let release: () => void = () => {}
    const done = new Promise<void>(resolve => { release = resolve })
    admission = done; reservation = done; publication = done
    return Promise.all(dependencies).then(run).finally(release)
  }

  /** Publish accepted kernel records through the same cache and observer path as ordinary commits. */
  function applyKernel(store: Store, commit: StoreCommit): StreamEvent {
    if (commit.record.intake !== undefined) intake.publish(commit.record.intake)
    const images = cache.apply(store, commit)
    options.applied?.(store.domain, commit, images, store)
    influence.record(store.domain, commit.pos, [])
    return { t: 'commit', domain: store.domain, record: commit.record }
  }

  /** Install a complete inventory synchronously; returned work drains its former lookup resources. */
  function installInventory(next: readonly StreamDomain[], pos: Position, changed: readonly DomainId[] = []) {
    inventory = [...next]
    stores.clear(); domains.clear()
    for (const domain of next) { stores.add(domain.store); domains.add(domain.store.domain) }
    domainPins.clear()
    for (const pin of storePins.values()) {
      const domain = pin.registration.target.store.domain
      let selected = domainPins.get(domain)
      if (selected === undefined) { selected = new Set(); domainPins.set(domain, selected) }
      selected.add(pin)
    }
    influence.replaceDomains([...domains], pos, changed)
    const decisionDrain = intake.replaceDomains(next)
    const replay = stream.replaceDomains(next, pos)
    return { drained: Promise.all([decisionDrain, replay.drained]).then(() => {}), publish: replay.publish }
  }

  /** Acquire target authority and durable intake before admitting its exact registration. */
  function activateTarget(registration: StoreTargetRegistration): Promise<Position> {
    return lifecycle(async () => {
      const owner = options.targetLifecycle
      const target = registration.target, resources = target.resources, store = target.store
      const previous = targets.get(registration.key)
      const releaseOnFailure = !stores.has(store)
      let accepted = false, rootAttempted = false
      const reserved: Position[] = []
      try {
        checkFailure()
        if (owner === undefined) throw new KernelError('INVALID', 'Target lifecycle owner is missing')
        owner.validate(registration)
        if (!Number.isSafeInteger(resources.writerEpoch) || resources.writerEpoch < 0)
          throw new KernelError('INVALID', 'Target writer token is invalid')
        if (stores.has(store)) throw new KernelError('INVALID', 'Store already has a writer owner')
        const next = inventory.filter(domain => domain.store !== previous?.registration.target.store)
        next.push({ store, epoch: resources.epoch, persistent: resources.persistent })
        const epochs = Object.fromEntries(streamDomainEpochs(next))
        if (resources.persistent) {
          const result = await store.scan({ range: { journal: '/' }, sort: [['pos.epoch', -1], ['pos.seq', -1]],
            limit: 1, budget: budget() })
          const last = result.items[0]?.pos
          if (last !== undefined && last.instance !== options.instance)
            throw new KernelError('INVALID', 'Target belongs to another instance')
          if (last !== undefined && comparePositions(last, position) > 0) {
            const epoch = await options.counter.freshEpoch(Math.max(position.epoch, last.epoch))
            if (!Number.isSafeInteger(epoch) || epoch <= Math.max(position.epoch, last.epoch))
              throw new KernelError('INVALID', 'Instance epoch must be fresh and increasing')
            const floor = { instance: options.instance, epoch, seq: 0 }
            await options.counter.save(floor, options.writerEpoch)
            position = floor
          }
        }
        owner.validate(registration)
        const fencePos = await reservePosition(); reserved.push(fencePos)
        const fence: StoreCommit = { pos: fencePos, writerEpoch: resources.writerEpoch, writes: [],
          record: { pos: fencePos, kind: 'kernel', executor: 'kernel', caller: 'kernel', entries: [] } }
        owner.validate(registration)
        await store.commit(fence)
        owner.validate(registration)
        const pos = await reservePosition(); reserved.push(pos)
        const root: StoreCommit = { pos, writerEpoch: options.writerEpoch, writes: [],
          record: { pos, kind: 'kernel', executor: 'kernel', caller: 'kernel', entries: [],
            intake: intake.next(pos, previous !== undefined || resources.decisionHistory !== 'fresh', epochs, previous === undefined && resources.decisionHistory === 'fresh') } }
        owner.validate(registration)
        // A rejected Store promise can follow durable journal acceptance.
        rootAttempted = true
        await options.root.commit(root)
        accepted = true
        ownedTargets.add(target)
        const pin: TargetPin = { registration, writerEpoch: resources.writerEpoch, active: true }
        if (previous !== undefined) { previous.active = false; storePins.delete(previous.registration.target.store) }
        targets.set(registration.key, pin); storePins.set(store, pin)
        const drained = installInventory(next, fencePos, [store.domain])
        const fenceEvent = applyKernel(store, fence)
        const rootEvent = applyKernel(options.root, root)
        owner.publish({ registration, pos, kind: 'activate' })
        drained.publish()
        stream.publish(fenceEvent)
        stream.publish(rootEvent)
        await drained.drained
        if (previous !== undefined) await closeTarget(previous.registration.target)
        return pos
      } catch (error) {
        console.error(error)
        if (rootAttempted) fatal = { error }
        if (!accepted) {
          if (!rootAttempted) for (const pos of reserved) { influence.advance(pos); stream.publish({ t: 'gap', pos }) }
          if (releaseOnFailure) try { await closeTarget(target) } catch (closeError) { throw new AggregateError([error, closeError], 'Target activation and release failed') }
        }
        throw error
      }
    })
  }

  /** Retire lookup authority durably before releasing its owned Store. */
  function retireTarget(key: string, revision: Rev): Promise<Position> {
    const pinned = targets.get(key)
    if (pinned === undefined || pinned.registration.revision !== revision)
      return Promise.reject(new KernelError('UNAVAILABLE', 'Target registration changed'))
    pinned.active = false
    return lifecycle(async () => {
      let rootAttempted = false, pos: Position | undefined
      try {
        checkFailure()
        if (targets.get(key) !== pinned) throw new KernelError('UNAVAILABLE', 'Target registration changed')
        const next = inventory.filter(domain => domain.store !== pinned.registration.target.store)
        pos = await reservePosition()
        const root: StoreCommit = { pos, writerEpoch: options.writerEpoch, writes: [],
          record: { pos, kind: 'kernel', executor: 'kernel', caller: 'kernel', entries: [],
            intake: intake.next(pos, true, Object.fromEntries(streamDomainEpochs(next))) } }
        // The Store contract cannot distinguish pre-effect refusal from failed durable publication.
        rootAttempted = true
        await options.root.commit(root)
        targets.delete(key); storePins.delete(pinned.registration.target.store)
        const drained = installInventory(next, pos)
        const rootEvent = applyKernel(options.root, root)
        options.targetLifecycle!.publish({ registration: pinned.registration, pos, kind: 'retire' })
        drained.publish()
        stream.publish(rootEvent)
        await drained.drained
        await closeTarget(pinned.registration.target)
        return pos
      } catch (error) {
        console.error(error)
        if (rootAttempted) fatal = { error }
        else if (pos !== undefined) { influence.advance(pos); stream.publish({ t: 'gap', pos }) }
        throw error
      }
    })
  }
  /** Drain accepted work and release mounted resources while preserving the borrowed root authority. */
  function closeTargets(): Promise<void> {
    if (closedTargets !== undefined) return closedTargets
    closing = true
    const dependencies = new Set([admission, reservation, publication, ...writers.values()])
    for (const active of readers.values()) for (const done of active) dependencies.add(done)
    closedTargets = (async () => {
      await Promise.all(dependencies)
      await Promise.all([intake.replaceDomains(options.domains), stream.replaceDomains(options.domains, position).drained])
      const failures: unknown[] = []
      for (const pin of targets.values()) pin.active = false
      const results = await Promise.allSettled([...ownedTargets].map(closeTarget))
      for (const result of results) if (result.status === 'rejected') failures.push(result.reason)
      targets.clear(); storePins.clear(); domainPins.clear()
      if (failures.length !== 0) throw new AggregateError(failures, 'Target resource release failed')
    })()
    return closedTargets
  }
  async function mutate(input: MutationIdentity, execute: (span: MutationSpan) => Promise<unknown>, wait?: MutationWaiter): Promise<Outcome> {
    checkFailure()
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
    }, wait)
  }
  function replay(input: MutationIdentity, wait?: MutationWaiter): Promise<Outcome | undefined> {
    checkFailure()
    return intake.previous(input, wait)
  }
  return { stream, cache, influence, get position(): Position { return { ...position } },
    get intake() { return intake.state }, commit, read, mutate, replay, refreshIntake, activateTarget, retireTarget, closeTargets }
}

export type Writer = Awaited<ReturnType<typeof createWriter>>
