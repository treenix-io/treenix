import { KernelError } from '#errors'
import type { AuthAdmission } from '#kernel/auth-factory'
import type { CapabilityState } from '#kernel/capability'
import { prepareChangeSet, type PreparedChangeSet } from '#kernel/changeset'
import { judgeGates } from '#kernel/gates'
import { createReader, type ReaderSource } from '#kernel/reader'
import type { Budget, CommitRequest, Gate, Limits, Outcome, Registry, SubSelector } from '#kernel/types'
import type { Writer } from '#kernel/writer'
import { freeze } from '#util/freeze'

export interface CommandOptions {
  readonly writer: Writer
  readonly registry: Registry
  readonly registryRevision: () => number
  readonly admission: AuthAdmission
  readonly source: (budget: Budget) => ReaderSource
  readonly capabilities: (budget: Budget) => CapabilityState
  readonly gates: readonly Gate[]
  readonly limits: () => Limits
  readonly budget: () => Budget
  readonly validate: (prepared: PreparedChangeSet) => void
}

export function createCommands(options: CommandOptions) {
  const { admission, writer, registry } = options
  const gates = Object.freeze([...options.gates])
  function reader(budget: Budget, source: ReaderSource) { return createReader({ admission, writer, registry, source, budget, limits: options.limits() }) }
  function active(budget: Budget): void {
    admission.assertActive()
    if (Date.now() > budget.deadline) throw new KernelError('BUDGET', 'Operation deadline exceeded')
  }
  return {
    actor: admission.actor,
    signal: admission.signal,
    async read(selector: SubSelector) {
      const budget = options.budget()
      active(budget)
      if (Buffer.byteLength(JSON.stringify(selector)) > options.limits().requestBytes) throw new KernelError('BUDGET', 'Read request budget exceeded')
      const owned = freeze(structuredClone(selector))
      await judgeGates(gates, { kind: 'read', selector: owned, origin: admission.origin }, admission.actor,
        { signal: admission.signal, deadline: budget.deadline })
      active(budget)
      return reader(budget, options.source(budget)).read(owned)
    },
    async commit(input: CommitRequest): Promise<Outcome> {
      const budget = options.budget(), limits = options.limits()
      active(budget)
      const serialized = JSON.stringify(input)
      if (Buffer.byteLength(serialized) > limits.requestBytes) throw new KernelError('BUDGET', 'Commit request budget exceeded')
      const request = freeze(structuredClone(input)), opId = request.opId
      if (opId === undefined || typeof opId.epoch !== 'string' || opId.epoch.length === 0
        || !Number.isSafeInteger(opId.time) || opId.time < 0 || typeof opId.nonce !== 'string' || opId.nonce.length === 0)
        throw new KernelError('INVALID', 'A mutation key is required')
      return writer.mutate({ actor: admission.actor, opId, request: { kind: 'commit', changes: request.changes, expect: request.expect } }, async span => {
        active(budget)
        await judgeGates(gates, { kind: 'commit', changes: request.changes, origin: admission.origin }, admission.actor,
          { signal: admission.signal, deadline: budget.deadline })
        active(budget)
        const source = options.source(budget), capabilities = options.capabilities(budget)
        const store = source.resolve(request.changes.length === 0 ? '/' : changePath(request.changes[0])).store
        await span.finish(store, source.domains, async pos => {
          active(budget)
          await admission.validate(source.auth)
          const revision = options.registryRevision(), reads = reader(budget, source)
          const prepared = await prepareChangeSet({ store, cache: writer.cache, registry, limits, budget,
            resolve: path => source.resolve(path).store, readBefore: source.auth.node, capabilities,
            preconditions: { index: writer.influence, read: reads.projectedNode, domains: () => source.domains,
              dependency: reads.dependency, project: reads.project, work: reads.work, limits } },
          request.changes, pos, { executor: admission.actor.principal, caller: admission.actor.principal,
            actor: admission.actor, expect: request.expect })
          options.validate(prepared)
          const check = () => {
            active(budget)
            if (options.registryRevision() !== revision) throw new KernelError('CONFLICT', 'Registry changed during preparation')
          }
          check()
          return { ...prepared, check }
        })
      })
    },
    close() { admission.close() },
  }
}

function changePath(change: CommitRequest['changes'][number]): string {
  if (change.op === 'put') return change.node.$path
  if (change.op === 'move') return change.from
  if (change.op === 'restore') return '/'
  return change.path
}

export type NativeCommands = ReturnType<typeof createCommands>
