import { KernelError } from '#errors'
import { isDeepStrictEqual } from 'node:util'
import { comparePositions, positionToRev } from '#kernel/position'
import type { Budget, DomainId, InstanceStream, Position, StreamCursor, StreamDomain, StreamEvent } from '#kernel/types'

interface Subscriber {
  readonly events: { readonly event: StreamEvent; readonly bytes: number }[]
  bytes: number
  wake?(): void
  failure?: { readonly error: unknown }
}

/** Recheck failures across asynchronous catch-up and iterator suspension boundaries. */
function checkSubscriber(subscriber: Subscriber): void {
  if (subscriber.failure !== undefined) throw subscriber.failure.error
}

export interface StreamOptions {
  readonly position: Position
  readonly domains: readonly StreamDomain[]
  readonly budget: () => Budget
  readonly bufferedEvents?: number
  readonly bufferedBytes?: number
}

/** Checks continuity before resource acquisition and constructs the stream's domain epochs. */
export function streamDomainEpochs(domains: readonly StreamDomain[]): Map<DomainId, string> {
  const epochs = new Map<DomainId, string>()
  for (const domain of domains) {
    if (domain.epoch.length === 0) throw new KernelError('INVALID', 'Domain continuity epoch must be nonempty')
    const prior = epochs.get(domain.store.domain)
    if (prior !== undefined && prior !== domain.epoch)
      throw new KernelError('INVALID', 'Stores in one domain have different continuity epochs')
    epochs.set(domain.store.domain, domain.epoch)
  }
  return epochs
}

/** Creates an ordered event stream over declared Store domains and tracks their continuity epochs. */
export function createInstanceStream(options: StreamOptions) {
  let position = options.position
  const epochs = streamDomainEpochs(options.domains)
  let inventory = options.domains
  const retired = new Map<DomainId, string>()
  const replays = new Set<Promise<void>>()
  const subscribers = new Set<Subscriber>()
  const observers = new Set<(event: StreamEvent) => void>()
  const maxEvents = options.bufferedEvents ?? 256, maxBytes = options.bufferedBytes ?? 32 * 1024 * 1024

  /** Advance continuity and positions before notifying observers or subscribers. */
  function publish(event: StreamEvent): void {
    if (event.t === 'reset') epochs.set(event.domain, event.epoch)
    else {
      const next = event.t === 'commit' ? event.record.pos : event.pos
      if (comparePositions(next, position) <= 0) throw new KernelError('INVALID', 'Stream positions must increase')
      position = next
    }
    for (const observe of observers) observe(event)
    if (subscribers.size === 0) return
    const owned = structuredClone(event)
    const bytes = Buffer.byteLength(JSON.stringify(owned))
    const queued = { event: owned, bytes }
    for (const subscriber of subscribers) {
      if (subscriber.failure !== undefined) continue
      if (subscriber.events.length >= maxEvents || subscriber.bytes + bytes > maxBytes) {
        subscriber.failure = { error: new KernelError('BUDGET', 'Replica stream buffer exceeded') }
        subscriber.events.length = 0; subscriber.bytes = 0
      } else {
        subscriber.events.push(queued)
        subscriber.bytes += bytes
      }
      subscriber.wake?.()
    }
  }

  const stream: InstanceStream = {
    /** Replays retained commits after the cursor, then yields newly published events. */
    follow(from: StreamCursor): AsyncIterableIterator<StreamEvent> {
      const subscriber: Subscriber = { events: [], bytes: 0 }
      let cancelled = false
      const source = (async function*(): AsyncGenerator<StreamEvent, void, unknown> {
        if (cancelled) return
        // Registration precedes journal I/O so publication during catch-up cannot disappear.
        subscribers.add(subscriber)
        const barrier = position
        const currentEpochs = new Map(epochs)
        const currentInventory = inventory
        const retiredEpochs = new Map(retired)
        let release: () => void = () => {}
        const done = new Promise<void>(resolve => { release = resolve })
        replays.add(done)
        try {
          const reset = new Set<DomainId>()
          for (const [domain, old] of Object.entries(from.epochs)) {
            const current = currentEpochs.get(domain)
            if (current !== undefined && (old !== current || from.pos.instance !== barrier.instance)
              || current === undefined && retiredEpochs.has(domain)) reset.add(domain)
          }
          const records = new Map<string, Extract<StreamEvent, { t: 'commit' }>>()
          if (from.pos.instance === barrier.instance) {
            for (const domain of currentInventory) {
              if (reset.has(domain.store.domain)) continue
              const query = await domain.store.scan({ range: { journal: '/', after: from.pos },
                where: { 'pos.instance': barrier.instance }, budget: options.budget() })
              for (const record of query.items) {
                if (comparePositions(record.pos, barrier) > 0) continue
                const key = positionToRev(record.pos)
                const event = { t: 'commit', domain: domain.store.domain, record } as const
                const prior = records.get(key)
                if (prior !== undefined && !isDeepStrictEqual(prior, event)) throw new KernelError('INVALID', 'Conflicting journal records share a position')
                records.set(key, event)
              }
            }
          }
          replays.delete(done); release()
          checkSubscriber(subscriber)
          for (const domain of reset) yield { t: 'reset', domain,
            epoch: currentEpochs.get(domain) ?? retiredEpochs.get(domain) ?? positionToRev(barrier) }
          for (const event of [...records.values()].sort((a, b) => comparePositions(a.record.pos, b.record.pos))) {
            if (cancelled) return
            if (subscriber.failure !== undefined) throw subscriber.failure.error
            yield structuredClone(event)
          }
          while (!cancelled) {
            if (subscriber.failure !== undefined) throw subscriber.failure.error
            const queued = subscriber.events.shift()
            if (queued !== undefined) {
              const { event, bytes } = queued
              subscriber.bytes -= bytes
              if (event.t !== 'reset' && comparePositions(event.t === 'commit' ? event.record.pos : event.pos, barrier) <= 0) continue
              yield structuredClone(event)
            } else await new Promise<void>(resolve => { subscriber.wake = resolve })
          }
        } finally { replays.delete(done); release(); subscribers.delete(subscriber) }
      })()
      const iterator: AsyncIterableIterator<StreamEvent> = {
        next: () => source.next(),
        async return() { cancelled = true; subscriber.wake?.(); return source.return(undefined) },
        async throw(error: unknown) { cancelled = true; subscriber.wake?.(); return source.throw(error) },
        [Symbol.asyncIterator]() { return iterator },
      }
      return iterator
    },
  }
  return { ...stream, publish,
    /** Publish continuity changes and drain replay scans before predecessor resources close. */
    replaceDomains(next: readonly StreamDomain[], pos: Position) {
      const nextEpochs = streamDomainEpochs(next)
      inventory = next
      const draining = Promise.all([...replays]).then(() => {})
      const resets: Extract<StreamEvent, { t: 'reset' }>[] = []
      for (const [domain, epoch] of epochs) if (nextEpochs.get(domain) !== epoch) {
        const replacement = nextEpochs.get(domain) ?? positionToRev(pos)
        retired.set(domain, replacement)
        resets.push({ t: 'reset', domain, epoch: replacement })
      }
      for (const [domain, epoch] of nextEpochs) if (!epochs.has(domain)) resets.push({ t: 'reset', domain, epoch })
      epochs.clear()
      for (const [domain, epoch] of nextEpochs) epochs.set(domain, epoch)
      return { drained: draining, publish(): void {
        for (const reset of resets) {
          publish(reset)
          if (!nextEpochs.has(reset.domain)) epochs.delete(reset.domain)
        }
      } }
    },
    observe(listener: (event: StreamEvent) => void): () => void {
      observers.add(listener)
      return () => { observers.delete(listener) }
    },
    cursor: (): StreamCursor => ({ pos: { ...position }, epochs: Object.fromEntries(epochs) }) }
}
