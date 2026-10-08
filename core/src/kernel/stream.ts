import { KernelError } from '#errors'
import { isDeepStrictEqual } from 'node:util'
import { comparePositions, positionToRev } from '#kernel/position'
import type { Budget, DomainId, InstanceStream, Position, Store, StreamCursor, StreamEvent } from '#kernel/types'

export interface StreamDomain {
  readonly store: Store
  readonly epoch: string
  readonly persistent: boolean
}

interface Subscriber {
  readonly events: { readonly event: StreamEvent; readonly bytes: number }[]
  bytes: number
  wake?(): void
  failure?: { readonly error: unknown }
}

export interface StreamOptions {
  readonly position: Position
  readonly domains: readonly StreamDomain[]
  readonly budget: () => Budget
  readonly bufferedEvents?: number
  readonly bufferedBytes?: number
}

export function createInstanceStream(options: StreamOptions) {
  let position = options.position
  const epochs = new Map<DomainId, string>()
  for (const domain of options.domains) {
    const prior = epochs.get(domain.store.domain)
    if (prior !== undefined && prior !== domain.epoch) throw new KernelError('INVALID', 'Stores in one domain have different continuity epochs')
    epochs.set(domain.store.domain, domain.epoch)
  }
  const subscribers = new Set<Subscriber>()
  const observers = new Set<(event: StreamEvent) => void>()
  const maxEvents = options.bufferedEvents ?? 256, maxBytes = options.bufferedBytes ?? 32 * 1024 * 1024

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
    follow(from: StreamCursor): AsyncIterableIterator<StreamEvent> {
      const subscriber: Subscriber = { events: [], bytes: 0 }
      let cancelled = false
      const source = (async function*(): AsyncGenerator<StreamEvent, void, unknown> {
        if (cancelled) return
        // Registration precedes journal I/O so publication during catch-up cannot disappear.
        subscribers.add(subscriber)
        const barrier = position
        const currentEpochs = new Map(epochs)
        try {
          const reset = new Set<DomainId>()
          for (const [domain, old] of Object.entries(from.epochs)) {
            const current = currentEpochs.get(domain)
            if (current !== undefined && (old !== current || from.pos.instance !== barrier.instance)) reset.add(domain)
          }
          for (const domain of reset) yield { t: 'reset', domain, epoch: currentEpochs.get(domain)! }
          const records = new Map<string, Extract<StreamEvent, { t: 'commit' }>>()
          if (from.pos.instance === barrier.instance) {
            for (const domain of options.domains) {
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
        } finally { subscribers.delete(subscriber) }
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
    observe(listener: (event: StreamEvent) => void): () => void {
      observers.add(listener)
      return () => { observers.delete(listener) }
    },
    cursor: (): StreamCursor => ({ pos: { ...position }, epochs: Object.fromEntries(epochs) }) }
}
