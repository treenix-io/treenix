import { AsyncLocalStorage } from 'node:async_hooks'
import { KernelError } from '#errors'
import type { ReadActionContext, WriteActionContext } from '#kernel/types'

interface ActionFrame { readonly context: ReadActionContext | WriteActionContext; readonly active: () => void }
declare global {
  var __treenxNativeActionContext: AsyncLocalStorage<ActionFrame> | undefined
}
// Authored modules can import the built package while the server runs its source.
const scope = globalThis.__treenxNativeActionContext ??= new AsyncLocalStorage<ActionFrame>()

/** Expose the same native context through handler arguments and module accessors. */
export function runWithActionContext<T>(context: ActionFrame['context'], active: () => void, run: () => T): T {
  return scope.run({ context, active }, run)
}

/** Require an active handler context and reject writing access from a read action. */
export function getActionContext(kind: 'write'): WriteActionContext
export function getActionContext(kind?: 'read'): ReadActionContext
export function getActionContext(kind?: 'read' | 'write'): ReadActionContext | WriteActionContext {
  const frame = scope.getStore()
  if (frame === undefined) throw new KernelError('INVALID', 'No native action is running')

  frame.active()
  if (kind === 'write' && !('change' in frame.context)) throw new KernelError('FORBIDDEN', 'The action has no writing context')

  return frame.context
}
