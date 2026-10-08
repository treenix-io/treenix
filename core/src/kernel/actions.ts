import { assertSafeSchema, validateValue, type ValidationError } from '#comp/validate'
import { KernelError } from '#errors'
import { assertSupportedNeeds, resolveActionNeeds } from '#kernel/action-needs'
import { prepareChangeSet } from '#kernel/changeset'
import type { CommandOptions } from '#kernel/commands'
import { createSiftTest } from '#kernel/expr'
import { judgeGates } from '#kernel/gates'
import { componentEntries } from '#kernel/migrate'
import { assertPost } from '#kernel/post'
import { createReader } from '#kernel/reader'
import { createRequestAdmission } from '#kernel/request'
import { R, W, type ActRequest, type ChangeMember, type Outcome } from '#kernel/types'
import { freeze } from '#util/freeze'

export function createActionRuntime(options: CommandOptions) {
  const { writer, registry } = options, gates = Object.freeze([...options.gates])
  return {
    async act(input: ActRequest, requestSignal?: AbortSignal): Promise<Outcome> {
      const admission = createRequestAdmission(options.admission, requestSignal)
      const limits = options.limits(), initial = options.budget()
      const budget = { ...initial, deadline: Math.min(initial.deadline, Date.now() + limits.actionMs) }
      function active(): void {
        admission.assertActive()
        if (Date.now() > budget.deadline) throw new KernelError('BUDGET', 'Action deadline exceeded')
      }
      active()
      if (Buffer.byteLength(JSON.stringify(input)) > limits.requestBytes) throw new KernelError('BUDGET', 'Action request budget exceeded')
      const request = freeze(structuredClone(input)), opId = request.opId
      if (opId === undefined || typeof opId.epoch !== 'string' || opId.epoch.length === 0
        || !Number.isSafeInteger(opId.time) || opId.time < 0 || typeof opId.nonce !== 'string' || opId.nonce.length === 0)
        throw new KernelError('INVALID', 'A mutation key is required')
      if (request.anchor !== undefined) throw new KernelError('UNAVAILABLE', 'Streaming actions are not implemented')
      const component = request.component ?? ''
      return writer.mutate({ actor: admission.actor, opId,
        request: { kind: 'act', path: request.path, component, action: request.action, args: request.args } }, async span => {
        active()
        const revision = options.registryRevision(), source = options.source(budget)
        function check(): void {
          active()
          if (options.registryRevision() !== revision) throw new KernelError('CONFLICT', 'Registry changed during action')
        }
        const reads = createReader({ admission, writer, registry, source, budget, limits, projector: options.projector })
        const result = await reads.read({ node: request.path }), copy = result.copies[0]!
        check()
        if (!('node' in copy)) throw copy.error
        const target = componentEntries(copy.node).find(([name]) => name === component)
        if (target === undefined) throw new KernelError('NOT_FOUND', 'Action component is absent')
        const definition = registry.type(target[1].$type)
        if (!Object.hasOwn(definition.actions, request.action)) throw new KernelError('NOT_FOUND', 'Action is absent')
        const action = definition.actions[request.action]
        if (action.kind !== 'write' || action.post === undefined || action.handler !== undefined || action.io === true)
          throw new KernelError('UNAVAILABLE', 'Only handlerless writing post actions are implemented')
        assertSupportedNeeds(action.needs)
        if ((copy.bits & (R | W)) !== (R | W)) throw new KernelError('FORBIDDEN', 'A writing action requires read and write')
        assertSafeSchema(action.args, 'Action arguments')
        const errors: ValidationError[] = []
        validateValue(request.args, action.args, 'args', errors)
        if (errors.length !== 0) throw new KernelError('INVALID', 'Action arguments violate their schema')
        assertPost(action.post)
        await judgeGates(gates, { kind: 'act', path: request.path, component, action: request.action, args: request.args,
          origin: admission.origin }, admission.actor, { signal: admission.signal, deadline: budget.deadline })
        check()
        const resolved = await resolveActionNeeds(action.needs, request.path, reads, limits)
        check()
        if (action.pre !== undefined && !createSiftTest(action.pre, limits)({ node: copy.node, needs: resolved.needs }, reads.work))
          throw new KernelError('CONFLICT', 'Action precondition does not hold')
        const changes: ChangeMember[] = []
        for (const [name, ops] of Object.entries(action.post)) {
          if (name !== '' && (!Object.hasOwn(action.needs ?? {}, name) || !Object.hasOwn(resolved.targets, name)))
            throw new KernelError('INVALID', 'The post target was not declared as a need')
          if (Object.keys(ops).length === 0) continue
          for (const path of name === '' ? [request.path] : resolved.targets[name]) changes.push({ op: 'patch', path, ops })
        }
        const store = source.resolve(request.path).store
        await span.finish(store, source.domains, async pos => {
          check()
          await admission.validate(source.auth)
          check()
          const prepared = await prepareChangeSet({ store, cache: writer.cache, registry, limits, budget,
            resolve: path => source.resolve(path).store, readBefore: source.auth.node, capabilities: options.capabilities(budget),
            preconditions: { index: writer.influence, read: reads.projectedNode, domains: reads.domains,
              dependency: reads.dependency, project: reads.project, work: reads.work, limits } }, changes, pos,
          { executor: admission.actor.principal, caller: admission.actor.principal, actor: admission.actor,
            expect: reads.expect(), action: { type: definition.name, action: request.action, path: request.path, targets: resolved.targets } })
          options.validate(prepared)
          check()
          return { ...prepared, check }
        })
      })
    },
  }
}
