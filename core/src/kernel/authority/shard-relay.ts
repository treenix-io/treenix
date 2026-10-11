import { KernelError } from '#errors'
import type { ShardClient } from '#kernel/authority/shard-owner'
import type { NodeLaneFrame } from '#kernel/lane'
import type { LaneChange, LaneProducer, Pending, Position, SubSelector } from '#kernel/types'

interface RelayedRequest {
  readonly local: string
  position?: Position
}
interface RelayedSubscription {
  readonly local: string
  readonly initial: number
  remote?: number
  generation: number
}
interface RelayedLane {
  readonly client: ShardClient
  readonly requests: Map<string, RelayedRequest>
  readonly subscriptions: Map<string, RelayedSubscription>
  readonly stop: () => void
  failure?: KernelError
  welcomed: boolean
}

/** Carries raw frames on origin credit while retaining only their actual correlation ownership. */
export function createShardRelay() {
  const lanes = new Map<ShardClient, RelayedLane>()
  const listeners = new Set<() => void>()
  let closed = false
  const ready = () => { for (const listener of listeners) listener() }
  function lane(client: ShardClient): RelayedLane {
    if (closed) throw new KernelError('CANCELLED', 'Shard relay is closed')
    let retained = lanes.get(client)
    if (retained === undefined) {
      retained = { client, requests: new Map(), subscriptions: new Map(), welcomed: false,
        stop: client.connection.observeReady(ready) }
      lanes.set(client, retained)
    }
    return retained
  }
  function subscription(current: RelayedLane, id: string, generation?: number): RelayedSubscription {
    const owned = current.subscriptions.get(id)
    if (owned === undefined) throw new KernelError('INVALID', 'Shard frame names an unowned subscription')
    if (generation !== undefined) {
      if (owned.remote === undefined) owned.remote = generation
      if (generation < owned.remote) throw new KernelError('INVALID', 'Shard generation moved backwards')
      owned.generation = owned.initial + generation - owned.remote
    }
    return owned
  }
  function request(current: RelayedLane, id: string): RelayedRequest {
    const owned = current.requests.get(id)
    if (owned === undefined) throw new KernelError('INVALID', 'Shard frame names an unowned request')
    return owned
  }
  function producer(current: RelayedLane, value: LaneProducer): LaneProducer {
    if ('req' in value) return { req: request(current, value.req).local }
    const owned = subscription(current, value.sub, value.gen)
    return { sub: owned.local, gen: owned.generation }
  }
  /** Consumes no outstanding remote next() when the current origin credit finds no frame. */
  async function poll(): Promise<NodeLaneFrame | undefined> {
    for (const current of lanes.values()) {
      for (;;) {
        if (current.failure !== undefined) {
          const first = current.subscriptions.entries().next().value
          if (first !== undefined) {
            current.subscriptions.delete(first[0])
            return { t: 'end', sub: first[1].local, error: current.failure }
          }
          lanes.delete(current.client)
          break
        }
        let frame: Awaited<ReturnType<ShardClient['connection']['poll']>>
        try {
          await current.client.check()
          current.client.active()
          frame = await current.client.connection.poll()
          if (frame === undefined) break
          current.client.active()
        } catch (error) {
          current.failure = error instanceof KernelError ? error : new KernelError('UNAVAILABLE', 'Shard delivery failed')
          console.error(error)
          current.stop()
          await current.client.close()
          current.requests.clear()
          continue
        }
        switch (frame.t) {
          case 'welcome':
            if (current.welcomed) throw new KernelError('INVALID', 'Shard lane repeated its welcome')
            current.welcomed = true
            continue
          case 'snap': case 'result': {
            const owned = subscription(current, frame.sub, frame.gen)
            return { ...frame, sub: owned.local, gen: owned.generation,
              foreign: frame.at.map(pos => pos.instance) }
          }
          case 'reset': {
            const owned = subscription(current, frame.sub, frame.gen)
            return { ...frame, sub: owned.local, gen: owned.generation }
          }
          case 'end': return { ...frame, sub: subscription(current, frame.sub).local }
          case 'pos': {
            const list = (change: Extract<LaneChange, { readonly op: 'list' }>) => {
              const owned = subscription(current, change.sub, change.gen)
              return { ...change, sub: owned.local, gen: owned.generation }
            }
            if (frame.coverage === true) return { ...frame,
              changes: frame.changes.map(change => change.op === 'list' ? list(change) : change) }
            const changes = frame.changes.map(change => change.op === 'list' ? list(change) : change)
            let owner = frame.producer === undefined ? undefined : producer(current, frame.producer)
            if (owner === undefined) {
              const pending = current.requests.values().next().value
              const sub = current.subscriptions.values().next().value
              if (pending !== undefined) owner = { req: pending.local }
              else if (sub !== undefined) owner = { sub: sub.local, gen: sub.generation }
              else {
                if (changes.length !== 0) throw new KernelError('INVALID', 'Shard changes lack an owning consumer')
                continue
              }
            }
            for (const pending of current.requests.values()) pending.position = frame.pos
            return { ...frame, changes, producer: owner, intake: undefined }
          }
          case 'chunk': request(current, frame.req); continue
          case 'done': request(current, frame.req); current.requests.delete(frame.req); continue
          case 'fail':
            if (frame.req === undefined) throw frame.error
            request(current, frame.req)
            current.requests.delete(frame.req)
            continue
        }
      }
    }
    return undefined
  }
  return {
    poll,
    observe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    subscribe(client: ShardClient, id: string, generation: number, selector: SubSelector) {
      const current = lane(client)
      if (current.subscriptions.has(id)) throw new KernelError('INVALID', 'Shard subscription is already owned')
      current.subscriptions.set(id, { local: id, initial: generation, generation })
      client.connection.send({ t: 'sub', sub: id, selector })
      return { close() { if (!closed && current.failure === undefined) client.connection.send({ t: 'unsub', sub: id }) } }
    },
    track(client: ShardClient, pending: Pending, local: string) {
      const current = lane(client)
      if (current.requests.has(pending.id)) throw new KernelError('INVALID', 'Shard request is already owned')
      const owned: RelayedRequest = { local }
      current.requests.set(pending.id, owned)
      ready()
      return { position: () => owned.position }
    },
    close() {
      closed = true
      for (const current of lanes.values()) current.stop()
      lanes.clear()
      listeners.clear()
    },
  }
}
