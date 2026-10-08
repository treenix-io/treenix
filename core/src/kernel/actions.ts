import { createHash } from 'node:crypto'
import { assertSafeSchema, validateValue, type ValidationError } from '#comp/validate'
import { KernelError } from '#errors'
import { createActionControl, createReadActionContext, createWriteActionContext } from '#kernel/action-context'
import { createActionDraft } from '#kernel/action-draft'
import { assertSupportedNeeds, resolveActionNeeds } from '#kernel/action-needs'
import { createChangeBuilder } from '#kernel/change-builder'
import { prepareChangeSet, type ChangeExecutor, type ChangeSetOptions } from '#kernel/changeset'
import type { CommandOptions } from '#kernel/commands'
import { runWithActionContext } from '#kernel/current-action'
import { createSiftTest } from '#kernel/expr'
import { judgeGates } from '#kernel/gates'
import { componentEntries } from '#kernel/migrate'
import { assertPost } from '#kernel/post'
import { createReader } from '#kernel/reader'
import { createRequestAdmission, serializeRequest } from '#kernel/request'
import { R, W, type ActRequest, type ActionDef, type ActionResult, type NestedActRequest, type OpId, type Outcome } from '#kernel/types'
import type { MutationSpan } from '#kernel/writer'
import { freeze } from '#util/freeze'
import { stableJson } from '#util/stable-json'

interface ParentAction {
  readonly depth: number
  readonly deadline: number
  readonly active: () => void
  readonly onlyRead: boolean
}
const AsyncGenerator = Object.getPrototypeOf(async function* () {}).constructor

/** Validate the mutation key before it reaches durable dispatch. */
function assertMutationKey(opId: OpId | undefined): asserts opId is OpId {
  if (opId === undefined || typeof opId.epoch !== 'string' || opId.epoch.length === 0
    || !Number.isSafeInteger(opId.time) || opId.time < 0 || typeof opId.nonce !== 'string' || opId.nonce.length === 0)
    throw new KernelError('INVALID', 'A mutation key is required')
}

/** Reject action kinds and declared needs that this runtime cannot execute. */
function assertSupportedAction(action: ActionDef, options: CommandOptions): void {
  if (action.kind === 'setuid') throw new KernelError('UNAVAILABLE', 'Node executor actions are not implemented')
  if (action.kind !== 'read' && action.io === true && options.io === undefined) throw new KernelError('UNAVAILABLE', 'Action I/O is not configured')
  if (action.handler !== undefined && (action.handler instanceof AsyncGenerator
    || Reflect.get(action.handler, 'implementation') instanceof AsyncGenerator)) throw new KernelError('UNAVAILABLE', 'Streaming actions are not implemented')
  assertSupportedNeeds(action.needs)
  if (action.kind !== 'read' && action.post !== undefined) assertPost(action.post)
}

/** Execute native actions through admitted reads and durable mutation decisions. */
export function createActionRuntime(options: CommandOptions) {
  const { writer, registry } = options
  const gates = Object.freeze([...options.gates])

  /** Own one request deadline and read set, including its nested action calls. */
  async function run(input: ActRequest, requestSignal?: AbortSignal, parent?: ParentAction): Promise<Outcome> {
    const admission = createRequestAdmission(options.admission, requestSignal)
    const limits = options.limits()
    const allowance = options.budget('action')
    const depth = parent?.depth ?? 0
    const budget = { ...allowance, deadline: Math.min(allowance.deadline, Date.now() + limits.actionMs, parent?.deadline ?? Infinity) }
    const control = createActionControl(admission, budget.deadline, parent?.active)
    const assertActive = control.active

    try {
      assertActive()
      if (depth > limits.actionDepth) throw new KernelError('BUDGET', 'Action nesting exceeds its limit')
      const owned = structuredClone(input)
      if (Buffer.byteLength(serializeRequest(owned)) > limits.requestBytes) throw new KernelError('BUDGET', 'Action request budget exceeded')
      const request = freeze(owned)
      const opId = request.opId
      const component = request.component ?? ''
      if (request.anchor !== undefined) throw new KernelError('UNAVAILABLE', 'Streaming actions are not implemented')

      const identity = opId === undefined ? undefined : { actor: admission.actor, opId,
        request: { kind: 'act', path: request.path, component, action: request.action, args: request.args } }
      if (identity !== undefined && !parent?.onlyRead) {
        assertMutationKey(opId)
        const replay = await writer.replay(identity, control.wait)
        if (replay !== undefined) return replay
      }
      const revision = options.registryRevision()
      const source = options.source(budget)

      /** Keep authorization tied to the registry used for this action. */
      function assertActionCurrent(): void {
        assertActive()
        if (options.registryRevision() !== revision) throw new KernelError('CONFLICT', 'Registry changed during action')
      }
      const reads = createReader({ admission, writer, registry, source, budget, limits, projector: options.projector })

      /** Resolve the addressed component and exact action through the caller's Reader. */
      async function classifyAction() {
        const result = await reads.read({ node: request.path })
        const copy = result.copies[0]!
        assertActionCurrent()
        if (!('node' in copy)) throw copy.error

        const node = copy.node
        const bits = copy.bits
        const target = componentEntries(node).find(([name]) => name === component)
        if (target === undefined) throw new KernelError('NOT_FOUND', 'Action component is absent')
        const ownComponent = target[1]
        const definition = registry.type(ownComponent.$type)
        if (!Object.hasOwn(definition.actions, request.action)) throw new KernelError('NOT_FOUND', 'Action is absent')
        return { node, bits, ownComponent, definition, action: definition.actions[request.action] }
      }

      let classified: Awaited<ReturnType<typeof classifyAction>>
      try { classified = await classifyAction() } catch (error) {
        if (identity !== undefined && !parent?.onlyRead && error instanceof KernelError && error.code === 'NOT_FOUND') {
          const replay = await writer.replay(identity, control.wait)
          if (replay !== undefined) return replay
        }
        throw error
      }

      const { node, bits, ownComponent, definition, action } = classified
      if (parent?.onlyRead && action.kind !== 'read') throw new KernelError('FORBIDDEN', 'This action may call only read actions')
      if (action.kind === 'read' && identity !== undefined && !parent?.onlyRead) {
        const replay = await writer.replay(identity, control.wait)
        if (replay !== undefined) return replay
      }
      if (action.kind !== 'read') assertMutationKey(opId)

      /** Run checks and the handler once, then finish the supplied mutation span. */
      async function execute(span?: MutationSpan): Promise<Outcome> {
        assertActionCurrent()
        assertSupportedAction(action, options)
        const required = action.kind === 'read' ? R : R | W
        if ((bits & required) !== required) throw new KernelError('FORBIDDEN', 'Action call rights are missing')
        assertSafeSchema(action.args, 'Action arguments')
        const errors: ValidationError[] = []
        validateValue(request.args, action.args, 'args', errors)
        if (errors.length !== 0) throw new KernelError('INVALID', 'Action arguments violate their schema')

        await judgeGates(gates, { kind: 'act', path: request.path, component, action: request.action, args: request.args,
          origin: admission.origin }, admission.actor, { signal: control.signal, deadline: budget.deadline })
        assertActionCurrent()
        const resolved = await resolveActionNeeds(action.needs, request.path, reads, limits)
        assertActionCurrent()
        if (action.pre !== undefined && !createSiftTest(action.pre, limits)({ node, needs: resolved.needs }, reads.work))
          throw new KernelError('CONFLICT', 'Action precondition does not hold')
        const builder = createChangeBuilder(assertActive, limits)
        const keys = new Set<string>()

        /** Commit inner calls independently using stable keys owned by the parent. */
        async function callNestedAction(input: NestedActRequest): Promise<unknown> {
          assertActionCurrent()
          if (Object.hasOwn(input, 'opId') || Object.hasOwn(input, 'anchor')) throw new KernelError('INVALID', 'Nested mutation keys belong to the runtime')
          const nestedInput = structuredClone(input)
          serializeRequest(nestedInput)
          const nestedRequest = freeze(nestedInput)
          const key = nestedRequest.key
          if (key !== undefined) {
            if (typeof key !== 'string' || key.length === 0 || keys.has(key)) throw new KernelError('INVALID', 'Nested call keys must be unique and nonempty')
            keys.add(key)
          }
          const onlyRead = action.kind === 'read' || action.post !== undefined
          const nestedOpId = !onlyRead && key !== undefined && opId !== undefined ? { epoch: opId.epoch, time: opId.time,
            nonce: 'nested:' + createHash('sha256').update(stableJson([opId, key])).digest('hex') } : undefined
          const outcome = await control.wait(run({ path: nestedRequest.path, component: nestedRequest.component, action: nestedRequest.action, args: nestedRequest.args, opId: nestedOpId }, control.signal,
            { depth: depth + 1, deadline: budget.deadline, active: assertActive, onlyRead }))
          assertActionCurrent()
          return outcome.value
        }

        const contextOptions = { node, needs: resolved.needs, reads, actor: admission.actor, active: assertActionCurrent, nested: callNestedAction }
        let value: unknown
        const draft = action.kind === 'read' ? undefined : createActionDraft(ownComponent, node, component)
        try {
          if (action.handler !== undefined) {
            const args = structuredClone(request.args)
            let pending: ActionResult
            if (action.kind === 'read') {
              const context = createReadActionContext(contextOptions)
              const handler = action.handler
              pending = runWithActionContext(context, assertActionCurrent, () => handler.call(freeze(ownComponent), context, args))
            } else {
              const context = createWriteActionContext(contextOptions, builder.change, action.io === true ? options.io : undefined)
              const handler = action.handler
              pending = runWithActionContext(context, assertActionCurrent, () => handler.call(draft!.draft, context, args))
            }
            if ('next' in pending) throw new KernelError('UNAVAILABLE', 'Streaming actions are not implemented')
            value = await control.wait(pending)
            assertActionCurrent()
            draft?.finish(builder.change)
          } else if (action.kind !== 'read' && action.post !== undefined) {
            for (const [name, ops] of Object.entries(action.post)) {
              if (name !== '' && (!Object.hasOwn(action.needs ?? {}, name) || !Object.hasOwn(resolved.targets, name)))
                throw new KernelError('INVALID', 'The post target was not declared as a need')
              if (Object.keys(ops).length === 0) continue
              for (const path of name === '' ? [request.path] : resolved.targets[name]) builder.change.patch(path, ops)
            }
          }

          const changes = builder.finish()
          if (span === undefined) {
            await writer.read(source.domains, async () => { assertActionCurrent(); await admission.validate(source.auth); assertActionCurrent() })
            return { value }
          }

          const store = source.resolve(request.path).store
          return await span.finish(store, source.domains, async pos => {
            assertActionCurrent()
            await admission.validate(source.auth)
            assertActionCurrent()

            const prepareOptions: ChangeSetOptions = { store, cache: writer.cache, registry, limits, budget,
              blobs: options.blobs,
              resolve: path => source.resolve(path).store, readBefore: source.auth.node, capabilities: options.capabilities(budget),
              preconditions: { index: writer.influence, read: reads.projectedNode, domains: reads.domains,
                dependency: reads.dependency, project: reads.project, work: reads.work, limits } }
            const executor: ChangeExecutor = { executor: admission.actor.principal, caller: admission.actor.principal, actor: admission.actor,
              expect: reads.expect(), action: { type: definition.name, action: request.action, path: request.path, targets: resolved.targets } }
            const prepared = await prepareChangeSet(prepareOptions, changes, pos, executor)
            options.validate(prepared)
            assertActionCurrent()

            return { ...prepared, ...(value === undefined ? {} : { value }), check: assertActionCurrent }
          })
        } finally { draft?.discard(); builder.discard() }
      }

      if (action.kind === 'read') return await execute()
      assertMutationKey(opId)
      return await writer.mutate({ actor: admission.actor, opId,
        request: { kind: 'act', path: request.path, component, action: request.action, args: request.args } }, execute, control.wait)
    } finally { control.close() }
  }

  return { act: (input: ActRequest, requestSignal?: AbortSignal) => run(input, requestSignal) }
}
