import { createDraft, current, finishDraft, type Draft } from 'immer'
import { KernelError } from '#errors'
import type { ChangeBuilder, Component, Node, NodeInput, UpdateOps } from '#kernel/types'
import { computeDelta } from '#kernel/update-ops'

/** Collect component-local Immer edits into the caller's native change builder. */
export function createActionDraft(component: Component, node: Node, name: string) {
  const draft: Draft<Component> = createDraft(component)
  let baseline = component,
    image = node
  let closed = false
  /** Preserve literal fields with a whole-node write when update paths cannot address them. */
  function emit(after: Component, change: ChangeBuilder): void {
    for (const field of ['$id', '$rev', '$pos', '$path'])
      if (Object.hasOwn(after, field))
        throw new KernelError('INVALID', 'A component draft cannot change node identity')

    const delta = computeDelta(baseline, after)
    if (Object.keys(delta).length === 0) return
    if (name.includes('.') || (delta.set !== undefined && Object.hasOwn(delta.set, ''))) {
      const { $id, $rev, ...body } = image
      const input: NodeInput = body
      if (name !== '') Reflect.set(input, name, after)
      else {
        for (const key of Object.keys(baseline)) Reflect.deleteProperty(input, key)
        for (const [key, value] of Object.entries(after)) Reflect.set(input, key, value)
      }
      change.put(input)
      return
    }

    const field = (key: string) => (name === '' ? key : `${name}.${key}`)
    const ops: UpdateOps = {
      ...(delta.set === undefined
        ? {}
        : {
            $set: Object.fromEntries(
              Object.entries(delta.set).map(([key, value]) => [field(key), value]),
            ),
          }),
      ...(delta.unset === undefined
        ? {}
        : { $unset: Object.fromEntries(delta.unset.map((key) => [field(key), true as const])) }),
    }
    if (Object.keys(ops).length !== 0) change.patch(image.$path, ops)
  }
  return {
    draft,
    /** A checkpoint keeps the original Immer proxies live across generator resumptions. */
    checkpoint(change: ChangeBuilder): void {
      emit(current(draft), change)
    },
    /** Rebase only the projected component of this action's exact accepted own image. */
    rebase(component: Component, node: Node): void {
      rebaseValue(draft, component)
      baseline = component
      image = node
    },
    /** Finalize once after the last frame, then revoke the retained draft. */
    finish(change: ChangeBuilder): void {
      const after = finishDraft(draft)
      closed = true
      emit(after, change)
    },
    /** Revoke an unfinished draft without emitting changes. */
    discard(): void {
      if (!closed) {
        finishDraft(draft)
        closed = true
      }
    },
  }
}

/** Preserve reachable nested draft references while applying the accepted component's shape. */
function rebaseValue(target: unknown, image: unknown): unknown {
  if (
    target !== null &&
    image !== null &&
    typeof target === 'object' &&
    typeof image === 'object' &&
    Array.isArray(target) === Array.isArray(image)
  ) {
    for (const key of Object.keys(target))
      if (!Object.hasOwn(image, key)) Reflect.deleteProperty(target, key)
    for (const key of Object.keys(image))
      Reflect.set(target, key, rebaseValue(Reflect.get(target, key), Reflect.get(image, key)))
    if (Array.isArray(target) && Array.isArray(image)) target.length = image.length
    return target
  }
  return structuredClone(image)
}
