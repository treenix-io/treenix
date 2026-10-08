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

export const requestHash = (request: unknown, actor: Actor) => createHash('sha256').update(stableJson({ request, actor })).digest('hex')

export async function createIdempotency(options: IdempotencyOptions) {
  const now = options.now ?? Date.now, limits = options.limits ?? DEFAULT_LIMITS
  const stores = [...new Set(options.domains.map(domain => domain.store))]
  const domains = Object.fromEntries(options.domains.map(domain => [domain.store.domain, domain.epoch]))
  const saved = await options.root.scan({ range: { journal: '/' }, where: { intake: { $exists: true } },
    sort: [['pos.epoch', -1], ['pos.seq', -1]], limit: 1, budget: options.budget() })
  let state = saved.items[0]?.intake
  const flights = new Map<string, Flight>()

  function current(): IntakeState {
    if (state === undefined) throw new KernelError('INVALID', 'Mutation intake is not durable')
    return state
  }
  function boundary(): number { return Math.max(0, current().boundary, now() - limits.opIdWindowMs) }
  function checkAdmitted(opId: OpId): void {
    if (opId.time < current().boundary) throw new KernelError('EXPIRED', 'Mutation key has expired')
    if (opId.epoch !== current().epoch) throw new KernelError('UNKNOWN_OUTCOME', 'Mutation key belongs to another intake epoch')
  }
  function checkNew(opId: OpId): void {
    checkAdmitted(opId)
    if (opId.time > now() + limits.clockToleranceMs) throw new KernelError('EXPIRED', 'Mutation key is outside the intake window')
  }
  async function lookup(caller: Actor['principal'], opId: OpId): Promise<JournalCommit | undefined> {
    const allowance = options.budget()
    let latest: JournalCommit | undefined, nodes = 0, bytes = 0
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
  function replay(record: JournalCommit, hash: string): Outcome {
    const decision = record.decision!
    if (decision.requestHash !== hash) throw new KernelError('KEY_REUSED', 'Mutation key was used by another request or actor')
    if (decision.outcome === undefined) throw new KernelError('UNKNOWN_OUTCOME', 'The stream has no final outcome')
    return structuredClone(decision.outcome)
  }

  return {
    get state(): IntakeState { return current() },
    boundary,
    checkNew,
    checkAdmitted,
    lookup,
    next(pos: Position, force = false): IntakeState {
      return freeze({ epoch: !force && state !== undefined && isDeepStrictEqual(state.domains, domains) ? state.epoch : positionToRev(pos),
        boundary: Math.max(0, state?.boundary ?? 0, now() - limits.opIdWindowMs), domains: { ...domains } })
    },
    publish(next: IntakeState): void {
      if (state !== undefined && next.boundary < state.boundary) throw new KernelError('INVALID', 'Mutation expiry cannot move backwards')
      state = freeze(structuredClone(next))
    },
    run(input: MutationIdentity, advance: () => Promise<void>, execute: (decision: OpDecision) => Promise<Outcome>): Promise<Outcome> {
      const caller = input.actor.principal, hash = requestHash(input.request, input.actor)
      const key = stableJson([caller, input.opId]), prior = flights.get(key)
      const outcome = (async () => {
        const expires = boundary()
        if (input.opId.time < expires && expires > current().boundary) await advance()
        if (input.opId.time < current().boundary) throw new KernelError('EXPIRED', 'Mutation key has expired')
        if (prior !== undefined) {
          const value = await prior.outcome.catch(async error => {
            const record = await lookup(caller, input.opId)
            if (record === undefined) throw error
            console.error(error)
            return replay(record, hash)
          })
          if (prior.hash !== hash) throw new KernelError('KEY_REUSED', 'Mutation key was used by another request or actor')
          return structuredClone(value)
        }
        const record = await lookup(caller, input.opId)
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
