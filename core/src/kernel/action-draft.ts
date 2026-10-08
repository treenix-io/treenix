import { createDraft, finishDraft, type Draft } from 'immer'
import { KernelError } from '#errors'
import type { ChangeBuilder, Component, Node, NodeInput, UpdateOps } from '#kernel/types'
import { computeDelta } from '#kernel/update-ops'

/** Collect component-local Immer edits into the caller's native change builder. */
export function createActionDraft(component: Component, node: Node, name: string) {
  const draft: Draft<Component> = createDraft(component)
  let closed = false
  return { draft,
    /** Preserve literal fields with a whole-node write when update paths cannot address them. */
    finish(change: ChangeBuilder): void {
      const after = finishDraft(draft)
      closed = true
      for (const field of ['$id', '$rev', '$pos', '$path']) if (Object.hasOwn(after, field))
        throw new KernelError('INVALID', 'A component draft cannot change node identity')

      const delta = computeDelta(component, after)
      if (Object.keys(delta).length === 0) return
      if (name.includes('.') || delta.set !== undefined && Object.hasOwn(delta.set, '')) {
        const { $id, $rev, ...body } = node
        const input: NodeInput = body
        if (name !== '') Reflect.set(input, name, after)
        else {
          for (const key of Object.keys(component)) Reflect.deleteProperty(input, key)
          for (const [key, value] of Object.entries(after)) Reflect.set(input, key, value)
        }
        change.put(input)
        return
      }

      const field = (key: string) => name === '' ? key : `${name}.${key}`
      const ops: UpdateOps = {
        ...(delta.set === undefined ? {} : { $set: Object.fromEntries(Object.entries(delta.set).map(([key, value]) => [field(key), value])) }),
        ...(delta.unset === undefined ? {} : { $unset: Object.fromEntries(delta.unset.map(key => [field(key), true as const])) }),
      }
      if (Object.keys(ops).length !== 0) change.patch(node.$path, ops)
    },
    /** Revoke an unfinished draft without emitting changes. */
    discard(): void { if (!closed) { finishDraft(draft); closed = true } } }
}
