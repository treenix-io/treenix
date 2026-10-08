import { KernelError } from '#errors'
import { createActionRuntime } from '#kernel/actions'
import type { AuthAdmission } from '#kernel/auth-factory'
import type { CapabilityState } from '#kernel/capability'
import { prepareChangeSet, type PreparedChangeSet } from '#kernel/changeset'
import { judgeGates } from '#kernel/gates'
import type { createProjector } from '#kernel/projection'
import { createReader, type ReaderSource } from '#kernel/reader'
import { createRequestAdmission, serializeRequest } from '#kernel/request'
import type { BlobStore, Budget, CommitRequest, Gate, Io, Limits, Outcome, Registry, Selector, Store } from '#kernel/types'
import type { Writer } from '#kernel/writer'
import { freeze } from '#util/freeze'

export interface CommandOptions {
  readonly writer: Writer
  readonly registry: Registry
  readonly registryRevision: () => number
  readonly admission: AuthAdmission
  readonly source: (budget: Budget) => ReaderSource
  /** Opens required targets before any Writer read or prepare span is held. */
  readonly prepareSource: (budget: Budget, selectors: readonly Selector[]) => Promise<void>
  readonly boundary: (path: string) => boolean
  readonly capabilities: (budget: Budget) => CapabilityState
  readonly gates: readonly Gate[]
  readonly limits: () => Limits
  readonly budget: (kind?: 'read' | 'action') => Budget
  readonly validate: (prepared: PreparedChangeSet) => void
  readonly projector?: ReturnType<typeof createProjector>
  readonly io?: Io
  readonly blobs?: BlobStore
}

/** Binds read and commit operations to one admission and its current target topology. */
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
    /** Prepare the selector’s targets before taking its ordered read span. */
    async read(selector: Selector, requestSignal?: AbortSignal) {
      const request = createRequestAdmission(admission, requestSignal)
      const budget = options.budget()
      active(budget, request)
      if (Buffer.byteLength(JSON.stringify(selector)) > options.limits().requestBytes) throw new KernelError('BUDGET', 'Read request budget exceeded')
      const owned = freeze(structuredClone(selector))
      await judgeGates(gates, { kind: 'read', selector: owned, origin: admission.origin }, admission.actor,
        { signal: request.signal, deadline: budget.deadline })
      active(budget, request)
      await options.prepareSource(budget, [owned])
      active(budget, request)
      return reader(budget, options.source(budget), request).read(owned)
    },
    /** Resolve every change to one actual Store before preparing the mutation. */
    async commit(input: CommitRequest, requestSignal?: AbortSignal): Promise<Outcome> {
      const authorization = createRequestAdmission(admission, requestSignal)
      const budget = options.budget(), limits = options.limits()
      active(budget, authorization)
      const owned = structuredClone(input)
      const serialized = serializeRequest(owned)
      if (Buffer.byteLength(serialized) > limits.requestBytes) throw new KernelError('BUDGET', 'Commit request budget exceeded')
      const request = freeze(owned), opId = request.opId
      if (opId === undefined || typeof opId.epoch !== 'string' || opId.epoch.length === 0
        || !Number.isSafeInteger(opId.time) || opId.time < 0 || typeof opId.nonce !== 'string' || opId.nonce.length === 0)
        throw new KernelError('INVALID', 'A mutation key is required')
      return writer.mutate({ actor: admission.actor, opId, request: { kind: 'commit', changes: request.changes, expect: request.expect } }, async span => {
        active(budget, authorization)
        await judgeGates(gates, { kind: 'commit', changes: request.changes, origin: admission.origin }, admission.actor,
          { signal: authorization.signal, deadline: budget.deadline })
        active(budget, authorization)
        const selectors: Selector[] = []
        for (const change of request.changes) {
          if (change.op === 'restore') selectors.push({ history: '/' })
          else if (change.op === 'move') selectors.push({ node: change.from }, { node: change.to })
          else selectors.push({ node: change.op === 'put' ? change.node.$path : change.path })
        }
        await options.prepareSource(budget, selectors)
        active(budget, authorization)
        const source = options.source(budget), capabilities = options.capabilities(budget)
        const ownership = reader(budget, source, authorization)
        let store: Store | undefined
        /** Chooses one atomic writer without treating equal domain names as an atomic Store. */
        async function resolveOwners(): Promise<void> {
          for (const change of request.changes) {
            if (change.op !== 'restore') ownership.pin({ node: changePath(change) })
            const target = change.op === 'restore'
              ? await ownership.journalTarget(change.record)
              : source.resolve(changePath(change))
            if (store !== undefined && store !== target.store)
              throw new KernelError('CROSS_DOMAIN', 'ChangeSet spans atomic Store owners')
            store = target.store
            if (change.op === 'move') {
              ownership.pin({ node: change.to })
              if (source.resolve(change.to).store !== store)
                throw new KernelError('CROSS_DOMAIN', 'ChangeSet spans atomic Store owners')
            }
          }
        }
        if (request.changes.some(change => change.op === 'restore'))
          await writer.read(source.domains, async () => {
            await authorization.validate(source.auth)
            await resolveOwners()
          })
        else await resolveOwners()
        const selectedStore = store ?? source.resolve('/').store
        const dependencies = ownership.expect().dependencies
        const remaining = ownership.remainingBudget()
        await span.finish(selectedStore, source.domains, async pos => {
          active(budget, authorization)
          await authorization.validate(source.auth)
          const revision = options.registryRevision(), reads = reader(remaining, source, authorization)
          const prepared = await prepareChangeSet({ store: selectedStore, cache: writer.cache, registry, limits, budget: remaining,
            blobs: options.blobs,
            resolve: path => source.resolve(path).store, boundary: options.boundary, readBefore: source.auth.node, capabilities,
            preconditions: { index: writer.influence, read: reads.projectedNode, domains: () => source.domains,
              dependency: reads.dependency, project: reads.project, work: reads.work, limits } },
          request.changes, pos, { executor: admission.actor.principal, caller: admission.actor.principal,
            actor: admission.actor, expect: { ...request.expect, dependencies } })
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
