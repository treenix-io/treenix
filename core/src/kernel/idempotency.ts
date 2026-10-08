import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { KernelError } from '#errors'
import { comparePositions, positionToRev } from '#kernel/position'
import type { StreamDomain } from '#kernel/stream'
import { DEFAULT_LIMITS, type Actor, type Budget, type IntakeState, type JournalCommit, type Limits,
  type OpDecision, type OpId, type Outcome, type Position, type Store } from '#kernel/types'
import { freeze } from '#util/freeze'
import { stableJson } from '#util/stable-json'

export interface MutationIdentity {
  readonly actor: Actor
  readonly opId: OpId
  readonly request: unknown
  readonly stream?: OpDecision['stream']
}
export type MutationWaiter = <T>(pending: Promise<T>) => Promise<T>
export interface IdempotencyOptions {
  readonly root: Store
  readonly domains: readonly StreamDomain[]
  readonly budget: () => Budget
  readonly now?: () => number
  readonly limits?: Pick<Limits, 'opIdWindowMs' | 'clockToleranceMs'>
}
interface Flight {
  readonly hash: string
  readonly outcome: Promise<Outcome>
}

/** Bind the normalized request and actor semantics to a durable decision. */
export const requestHash = (request: unknown, actor: Actor) => createHash('sha256').update(stableJson({ request, actor })).digest('hex')

/** Coalesce live flights and recover outcomes already accepted by a declared Store. */
export async function createIdempotency(options: IdempotencyOptions) {
  const now = options.now ?? Date.now
  const limits = options.limits ?? DEFAULT_LIMITS
  const stores = [...new Set(options.domains.map(domain => domain.store))]
  const domains = Object.fromEntries(options.domains.map(domain => [domain.store.domain, domain.epoch]))
  const saved = await options.root.scan({ range: { journal: '/' }, where: { intake: { $exists: true } },
    sort: [['pos.epoch', -1], ['pos.seq', -1]], limit: 1, budget: options.budget() })
  let state = saved.items[0]?.intake
  const flights = new Map<string, Flight>()

  /** Require persisted intake before admitting a mutation key. */
  function current(): IntakeState {
    if (state === undefined) throw new KernelError('INVALID', 'Mutation intake is not durable')
    return state
  }

  /** Keep the current expiry window above its durable floor. */
  function boundary(): number { return Math.max(0, current().boundary, now() - limits.opIdWindowMs) }

  /** Check the durable epoch and expiry for a previously admitted key. */
  function checkAdmitted(opId: OpId): void {
    if (opId.time < current().boundary) throw new KernelError('EXPIRED', 'Mutation key has expired')
    if (opId.epoch !== current().epoch) throw new KernelError('UNKNOWN_OUTCOME', 'Mutation key belongs to another intake epoch')
  }

  /** Apply clock tolerance as well when admitting a fresh decision. */
  function checkNew(opId: OpId): void {
    checkAdmitted(opId)
    if (opId.time > now() + limits.clockToleranceMs) throw new KernelError('EXPIRED', 'Mutation key is outside the intake window')
  }

  /** Find the newest durable decision within one cumulative read budget. */
  async function lookup(caller: Actor['principal'], opId: OpId): Promise<JournalCommit | undefined> {
    const allowance = options.budget()
    let latest: JournalCommit | undefined
    let nodes = 0
    let bytes = 0

    for (const store of stores) {
      const found = await store.scan({ range: { decision: { caller, opId } }, limit: 1,
        budget: { ...allowance, nodes: allowance.nodes - nodes, bytes: allowance.bytes - bytes } })
      const record = found.items[0]
      nodes++
      if (record !== undefined) bytes += Buffer.byteLength(JSON.stringify(record))
      if (nodes > allowance.nodes || bytes > allowance.bytes || Date.now() > allowance.deadline) throw new KernelError('BUDGET', 'Decision lookup exceeded the read budget')
      if (record !== undefined && (latest === undefined || comparePositions(record.pos, latest.pos) > 0)) latest = record
    }

    return latest
  }

  /** Return a complete outcome only when its request and actor hash match. */
  function replay(record: JournalCommit, hash: string): Outcome {
    const decision = record.decision!
    if (decision.requestHash !== hash) throw new KernelError('KEY_REUSED', 'Mutation key was used by another request or actor')
    if (decision.outcome === undefined) throw new KernelError('UNKNOWN_OUTCOME', 'The stream has no final outcome')
    return structuredClone(decision.outcome)
  }

  /** A refused flight wait can still return success if the Store already accepted it. */
  async function recover(input: MutationIdentity, prior: Flight, hash: string, wait?: MutationWaiter): Promise<Outcome> {
    if (prior.hash !== hash) throw new KernelError('KEY_REUSED', 'Mutation key was used by another request or actor')
    const value = await (wait === undefined ? prior.outcome : wait(prior.outcome)).catch(async error => {
      const record = await lookup(input.actor.principal, input.opId)
      if (record === undefined) throw error
      console.error(error)
      return replay(record, hash)
    })

    return structuredClone(value)
  }

  /** Bound the initial wait; recovery has its own query budget to find accepted success. */
  async function lookupPrevious(input: MutationIdentity, wait?: MutationWaiter): Promise<JournalCommit | undefined> {
    const pending = lookup(input.actor.principal, input.opId)
    return (wait === undefined ? pending : wait(pending)).catch(async error => {
      if (wait === undefined) throw error
      const accepted = await lookup(input.actor.principal, input.opId)
      if (accepted === undefined) throw error
      console.error(error)
      return accepted
    })
  }

  /** Probe a prior outcome without applying fresh-write intake rules to an absent key. */
  async function previous(input: MutationIdentity, wait?: MutationWaiter): Promise<Outcome | undefined> {
    const hash = requestHash(input.request, input.actor)
    const prior = flights.get(stableJson([input.actor.principal, input.opId]))
    if (prior !== undefined) {
      if (input.opId.time < boundary()) throw new KernelError('EXPIRED', 'Mutation key has expired')
      return recover(input, prior, hash, wait)
    }

    const record = await lookupPrevious(input, wait)
    if (record === undefined) return undefined
    if (input.opId.time < boundary()) throw new KernelError('EXPIRED', 'Mutation key has expired')
    return replay(record, hash)
  }

  return {
    /** Return the durable intake state currently installed in this runtime. */
    get state(): IntakeState { return current() },
    boundary,
    checkNew,
    checkAdmitted,
    lookup,
    previous,
    /** Preserve the intake epoch while its declared domain epochs remain unchanged. */
    next(pos: Position, force = false): IntakeState {
      return freeze({ epoch: !force && state !== undefined && isDeepStrictEqual(state.domains, domains) ? state.epoch : positionToRev(pos),
        boundary: Math.max(0, state?.boundary ?? 0, now() - limits.opIdWindowMs), domains: { ...domains } })
    },
    /** Install accepted intake without moving its durable expiry backward. */
    publish(next: IntakeState): void {
      if (state !== undefined && next.boundary < state.boundary) throw new KernelError('INVALID', 'Mutation expiry cannot move backwards')
      state = freeze(structuredClone(next))
    },
    /** Reserve one flight per actor and key, executing only without an accepted prior decision. */
    run(input: MutationIdentity, advance: () => Promise<void>, execute: (decision: OpDecision) => Promise<Outcome>, wait?: MutationWaiter): Promise<Outcome> {
      const caller = input.actor.principal
      const hash = requestHash(input.request, input.actor)
      const key = stableJson([caller, input.opId])
      const prior = flights.get(key)

      const outcome = (async () => {
        const expires = boundary()
        if (input.opId.time < expires && expires > current().boundary) await advance()
        if (input.opId.time < current().boundary) throw new KernelError('EXPIRED', 'Mutation key has expired')
        if (prior !== undefined) {
          return recover(input, prior, hash, wait)
        }
        const record = await lookupPrevious(input, wait)
        if (record !== undefined) return replay(record, hash)
        checkNew(input.opId)
        return execute({ opId: { ...input.opId }, requestHash: hash, ...(input.stream === undefined ? {} : { stream: input.stream }) })
      })()
      if (prior !== undefined) return outcome

      const flight = { hash, outcome }
      flights.set(key, flight)
      return outcome.then(value => structuredClone(value)).finally(() => {
        if (flights.get(key) === flight) flights.delete(key)
      })
    },
  }
}
export type Idempotency = Awaited<ReturnType<typeof createIdempotency>>
