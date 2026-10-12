import { KernelError } from '#errors'
import { createActionControl } from '#kernel/action-context'
import type { MutationIdentity, MutationWaiter } from '#kernel/idempotency'
import type { OperationReadCost } from '#kernel/store/budget'
import { createActionRuntime } from '#kernel/actions'
import type { AuthAdmission } from '#kernel/auth-factory'
import type { CapabilityState } from '#kernel/capability'
import { changeSelectors, selectChangeStore, prepareRoutedChangeSet, type PreparedChangeSet } from '#kernel/changeset'
import { judgeGates } from '#kernel/gates'
import type { createProjector } from '#kernel/projection'
import { createReader, createReaderLedger, readerOperationCost, type ReaderLedger, type ReaderSource, type ReaderOperationCost } from '#kernel/reader'
import { createRequestAdmission, serializeRequest } from '#kernel/request'
import type { AuthReadSource } from '#kernel/session'
import type { ActionPieceDelivery, ActRequest, BlobStore, Budget, CommitRequest, Gate, ActionIoBinding, Limits, NodeId, Outcome, Path, ReadResult, ReadQueryCost, Registry, Rev, Selector, SubSelector, Store, StoredNode } from '#kernel/types'
import type { Writer } from '#kernel/writer'
import { freeze } from '#util/freeze'

/** Supplies an enclosing allowance and receives actual work from the same native Reader. */
export interface ReadAccounting {
  readonly budget: Budget
  readonly spent: (cost: ReadQueryCost) => void
}

export interface NodeActionTarget {
  readonly path: Path
  readonly id: NodeId
  readonly rev: Rev
}

export interface NodeActionBinding {
  readonly admission: AuthAdmission
  readonly options: CommandOptions
  readonly settings: StoredNode
  /** Rechecks the actual admission, configuration version and routed Store identity. */
  validate(source: AuthReadSource): Promise<void>
  /** Advance only from the exact image accepted by this action's own step. */
  acceptOwnStep(node: StoredNode): void
}

export interface ForeignActionInput {
  readonly requestId?: string
  readonly request: ActRequest
  readonly admission: AuthAdmission
  readonly cost: ReaderOperationCost
  readonly identity?: MutationIdentity
  readonly onlyRead: boolean
  readonly wait: MutationWaiter
  readonly signal: AbortSignal
  readonly deliver?: ActionPieceDelivery
}

export interface ForeignCommitInput {
  readonly requestId?: string
  readonly request: CommitRequest
  readonly admission: AuthAdmission
  readonly cost: ReaderOperationCost
  readonly identity: MutationIdentity
  readonly wait: MutationWaiter
  readonly signal: AbortSignal
}

export interface CommandOptions {
  /** Rebinds native routing and projections to an admitted request with narrower rights. */
  readonly withAdmission: (admission: AuthAdmission) => CommandOptions
  readonly writer: Writer
  readonly registry: Registry
  readonly registryRevision: () => number
  readonly admission: AuthAdmission
  readonly source: (budget: Budget, ledger?: ReaderLedger, selectors?: readonly Selector[]) => ReaderSource
  /** Opens required targets before any Writer read or prepare span is held. */
  readonly prepareSource: (budget: Budget, selectors: readonly Selector[], signal: AbortSignal) => Promise<void>
  readonly boundary: (path: string) => boolean
  readonly resolveSelector?: (selector: Selector) => Selector
  readonly viewDefinition?: (selector: SubSelector) => Path | undefined
  readonly readView?: (selector: SubSelector, request: AuthAdmission, budget: Budget) => Promise<ReadResult | undefined>
  /** Identifies foreign blob owners without reading their projected payloads. */
  readonly authority?: (path: Path) => boolean
  readonly readAuthority?: (selector: Selector, request: AuthAdmission, budget: Budget, cost?: ReaderOperationCost) => Promise<ReadResult | undefined>
  readonly commitAuthority?: (input: ForeignCommitInput) => Promise<Outcome | undefined>
  readonly actAuthority?: (input: ForeignActionInput) => Promise<Outcome | undefined>
  readonly capabilities: (budget: Budget, ledger?: ReaderLedger) => CapabilityState
  readonly gates: readonly Gate[]
  readonly limits: () => Limits
  readonly budget: (kind?: 'read' | 'action') => Budget
  readonly validate: (prepared: PreparedChangeSet) => void
  readonly projector?: ReturnType<typeof createProjector>
  readonly io?: ActionIoBinding
  readonly blobs?: BlobStore
  /** Owns a real node session while an action executes under its admission. */
  readonly withNodeExecutor: <T>(target: NodeActionTarget,
    budget: Budget, signal: AbortSignal, wait: <V>(pending: Promise<V>) => Promise<V>,
    run: (binding: NodeActionBinding) => Promise<T>, ledger?: ReaderLedger) => Promise<T>
}

/** Binds read and commit operations to one admission and its current target topology. */
export function createCommands(options: CommandOptions) {
  const { admission, writer, registry } = options
  const gates = Object.freeze([...options.gates])
  const actions = createActionRuntime(options)
  /** Creates a Reader with this request's admission and selected source. */
  function reader(budget: Budget, source: ReaderSource, request: AuthAdmission, ledger?: ReaderLedger) {
    return createReader({
      admission: request,
      writer,
      registry,
      source,
      budget,
      ledger,
      limits: options.limits(),
      projector: options.projector,
    });
  }
  function active(budget: Budget, request: AuthAdmission): void {
    request.assertActive()
    if (Date.now() > budget.deadline) throw new KernelError('BUDGET', 'Operation deadline exceeded')
  }
  return {
    actor: admission.actor,
    signal: admission.signal,
    act: actions.act,
    /** Prepare the selector’s targets before taking its ordered read span. */
    async read(selector: Selector, requestSignal?: AbortSignal, accounting?: ReadAccounting) {
      const request = createRequestAdmission(admission, requestSignal)
      const own = options.budget(), parent = accounting?.budget
      const budget = parent === undefined ? own : { nodes: Math.min(own.nodes, parent.nodes),
        bytes: Math.min(own.bytes, parent.bytes), exprWork: Math.min(own.exprWork, parent.exprWork),
        deadline: Math.min(own.deadline, parent.deadline) }
      const ledger = createReaderLedger(budget, options.limits())
      try {
      active(budget, request)
      if (Buffer.byteLength(JSON.stringify(selector)) > options.limits().requestBytes) throw new KernelError('BUDGET', 'Read request budget exceeded')
      const owned = freeze(structuredClone(selector))
      await judgeGates(gates, { kind: 'read', selector: owned, origin: admission.origin }, admission.actor,
        { signal: request.signal, deadline: budget.deadline })
      active(budget, request)
      await options.prepareSource(budget, [owned], request.signal)
      active(budget, request)
      if ('history' in owned || owned.include === undefined) {
        const foreign = await options.readAuthority?.(owned, request, budget, readerOperationCost(ledger))
        if (foreign !== undefined) return foreign
      }
      if (!('history' in owned)) {
        const view = await options.readView?.(owned, request, budget)
        if (view !== undefined) return view
      }
      const resolved = options.resolveSelector?.(owned) ?? owned
      await options.prepareSource(budget, [resolved], request.signal)
      const declaration = 'history' in owned ? undefined : options.viewDefinition?.(owned)
      const selectors: Selector[] = [resolved]
      if (declaration !== undefined) selectors.push({ node: declaration })
      const reads = reader(budget, options.source(budget, ledger, selectors), request, ledger)
      if (declaration !== undefined) await reads.read({ node: declaration })
      return await reads.read(resolved)
      } finally {
        accounting?.spent({ nodes: ledger.scanned, bytes: ledger.bytes, exprWork: ledger.work.used, requestBytes: ledger.requestBytes })
      }
    },
    /** Resolve every change to one actual Store before preparing the mutation. */
    async commit(input: CommitRequest, requestSignal?: AbortSignal, requestId?: string): Promise<Outcome> {
      const authorization = createRequestAdmission(admission, requestSignal);
      const budget = options.budget(),
        limits = options.limits();
      active(budget, authorization);
      const owned = structuredClone(input);
      const serialized = serializeRequest(owned);
      if (Buffer.byteLength(serialized) > limits.requestBytes)
        throw new KernelError('BUDGET', 'Commit request budget exceeded');
      const ledger = createReaderLedger(budget, limits);
      const request = freeze(owned),
        opId = request.opId;
      if (
        opId === undefined ||
        typeof opId.epoch !== 'string' ||
        opId.epoch.length === 0 ||
        !Number.isSafeInteger(opId.time) ||
        opId.time < 0 ||
        typeof opId.nonce !== 'string' ||
        opId.nonce.length === 0
      )
        throw new KernelError('INVALID', 'A mutation key is required');
      if (options.commitAuthority !== undefined) {
        const control = createActionControl(authorization, budget.deadline)
        try {
          const foreign = await options.commitAuthority({ request, requestId, admission: authorization,
            identity: { actor: admission.actor, opId, request: { kind: 'commit', changes: request.changes, expect: request.expect } },
            cost: readerOperationCost(ledger), wait: control.wait, signal: control.signal })
          if (foreign !== undefined) return foreign
        } finally { control.close() }
      }
      return writer.mutate(
        {
          actor: admission.actor,
          opId,
          request: { kind: 'commit', changes: request.changes, expect: request.expect },
        },
        async (span) => {
          active(budget, authorization);
          await judgeGates(
            gates,
            { kind: 'commit', changes: request.changes, origin: admission.origin },
            admission.actor,
            { signal: authorization.signal, deadline: budget.deadline },
          );
          active(budget, authorization);
          await options.prepareSource(budget, changeSelectors(request.changes), authorization.signal);
          active(budget, authorization);
          const source = options.source(budget, ledger, changeSelectors(request.changes)),
            capabilities = options.capabilities(budget, ledger);
          const ownership = reader(budget, source, authorization, ledger);
          let selectedStore: Store;
          if (request.changes.some((change) => change.op === 'restore' || change.op === 'undo'))
            selectedStore = await writer.read(source.domains, async () => {
              await authorization.validate(source.auth);
              return selectChangeStore(request.changes, source, ownership, source.resolve('/').store);
            });
          else
            selectedStore = await selectChangeStore(
              request.changes,
              source,
              ownership,
              source.resolve('/').store,
            );
          const dependencies = ownership.expect().dependencies;
          const remaining = ownership.remainingBudget();
          await span.finish(selectedStore, source.domains, async (pos) => {
            active(budget, authorization);
            await authorization.validate(source.auth);
            const revision = options.registryRevision(),
              reads = reader(remaining, source, authorization, ledger);
            const prepared = await prepareRoutedChangeSet(
              source,
              {
                store: selectedStore,
                cache: writer.cache,
                registry,
                limits,
                budget: remaining,
                readCost: readerOperationCost(ledger),
                blobs: options.blobs,
                resolve: (path) => source.resolve(path).store,
                boundary: options.boundary,
                readBefore: source.auth.node,
                capabilities,
                preconditions: {
                  index: writer.influence,
                  read: reads.projectedNode,
                  domains: () => source.domains,
                  dependency: reads.dependency,
                  project: reads.project,
                  historyVisible: reads.historyVisible,
                  work: reads.work,
                  limits,
                },
              },
              request.changes,
              pos,
              {
                executor: admission.actor.principal,
                caller: admission.actor.principal,
                actor: admission.actor,
                shard: authorization.shard,
                expect: { ...request.expect, dependencies },
              },
            );
            options.validate(prepared);
            const check = () => {
              active(budget, authorization);
              if (options.registryRevision() !== revision)
                throw new KernelError('CONFLICT', 'Registry changed during preparation');
            };
            check();
            return { ...prepared, check };
          });
        },
      );
    },
    close() { admission.close() },
  }
}

export type NativeCommands = ReturnType<typeof createCommands>
