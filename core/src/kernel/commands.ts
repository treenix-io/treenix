import { KernelError } from '#errors'
import { createActionRuntime } from '#kernel/actions'
import type { AuthAdmission } from '#kernel/auth-factory'
import type { CapabilityState } from '#kernel/capability'
import { prepareChangeSet, type PreparedChangeSet } from '#kernel/changeset'
import { judgeGates } from '#kernel/gates'
import type { createProjector } from '#kernel/projection'
import { createReader, type ReaderSource } from '#kernel/reader'
import { createRequestAdmission } from '#kernel/request'
import type { Budget, CommitRequest, Gate, Io, Limits, Outcome, Registry, SubSelector } from '#kernel/types'
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
  readonly budget: (kind?: 'read' | 'action') => Budget
  readonly validate: (prepared: PreparedChangeSet) => void
  readonly projector?: ReturnType<typeof createProjector>
  readonly io?: Io
}

export function createCommands(options: CommandOptions) {
  const { admission, writer, registry } = options
  const gates = Object.freeze([...options.gates])
  const actions = createActionRuntime(options)
  function reader(budget: Budget, source: ReaderSource, request: AuthAdmission) { return createReader({ admission: request, writer, registry, source, budget, limits: options.limits(), projector: options.projector }) }
  function active(budget: Budget, request: AuthAdmission): void {
    request.assertActive()
    if (Date.now() > budget.deadline) throw new KernelError('BUDGET', 'Operation deadline exceeded')
  }
  return {
    actor: admission.actor,
    signal: admission.signal,
    act: actions.act,
    async read(selector: SubSelector, requestSignal?: AbortSignal) {
      const request = createRequestAdmission(admission, requestSignal)
      const budget = options.budget()
      active(budget, request)
      if (Buffer.byteLength(JSON.stringify(selector)) > options.limits().requestBytes) throw new KernelError('BUDGET', 'Read request budget exceeded')
      const owned = freeze(structuredClone(selector))
      await judgeGates(gates, { kind: 'read', selector: owned, origin: admission.origin }, admission.actor,
        { signal: request.signal, deadline: budget.deadline })
      active(budget, request)
      return reader(budget, options.source(budget), request).read(owned)
    },
    async commit(input: CommitRequest, requestSignal?: AbortSignal): Promise<Outcome> {
      const authorization = createRequestAdmission(admission, requestSignal)
      const budget = options.budget(), limits = options.limits()
      active(budget, authorization)
      const serialized = JSON.stringify(input)
      if (Buffer.byteLength(serialized) > limits.requestBytes) throw new KernelError('BUDGET', 'Commit request budget exceeded')
      const request = freeze(structuredClone(input)), opId = request.opId
      if (opId === undefined || typeof opId.epoch !== 'string' || opId.epoch.length === 0
        || !Number.isSafeInteger(opId.time) || opId.time < 0 || typeof opId.nonce !== 'string' || opId.nonce.length === 0)
        throw new KernelError('INVALID', 'A mutation key is required')
      return writer.mutate({ actor: admission.actor, opId, request: { kind: 'commit', changes: request.changes, expect: request.expect } }, async span => {
        active(budget, authorization)
        await judgeGates(gates, { kind: 'commit', changes: request.changes, origin: admission.origin }, admission.actor,
          { signal: authorization.signal, deadline: budget.deadline })
        active(budget, authorization)
        const source = options.source(budget), capabilities = options.capabilities(budget)
        const store = source.resolve(request.changes.length === 0 ? '/' : changePath(request.changes[0])).store
        await span.finish(store, source.domains, async pos => {
          active(budget, authorization)
          await authorization.validate(source.auth)
          const revision = options.registryRevision(), reads = reader(budget, source, authorization)
          const prepared = await prepareChangeSet({ store, cache: writer.cache, registry, limits, budget,
            resolve: path => source.resolve(path).store, readBefore: source.auth.node, capabilities,
            preconditions: { index: writer.influence, read: reads.projectedNode, domains: () => source.domains,
              dependency: reads.dependency, project: reads.project, work: reads.work, limits } },
          request.changes, pos, { executor: admission.actor.principal, caller: admission.actor.principal,
            actor: admission.actor, expect: request.expect })
          options.validate(prepared)
          const check = () => {
            active(budget, authorization)
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
