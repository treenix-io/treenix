import { AsyncLocalStorage } from 'node:async_hooks'
import { KernelError } from '#errors'
import type { ReadActionContext, WriteActionContext } from '#kernel/types'

interface ActionLifetime { readonly signal: AbortSignal; readonly chargeBytes: (bytes: number) => void }
interface ActionFrame { readonly context: ReadActionContext | WriteActionContext; readonly active: () => void; readonly lifetime?: ActionLifetime }
declare global {
  var __treenxNativeActionContext: AsyncLocalStorage<ActionFrame> | undefined
}
// Authored modules can import the built package while the server runs its source.
const scope = globalThis.__treenxNativeActionContext ??= new AsyncLocalStorage<ActionFrame>()

/** Expose the same native context through handler arguments and module accessors. */
export function runWithActionContext<T>(context: ActionFrame['context'], active: () => void, run: () => T, lifetime?: ActionLifetime): T {
  return scope.run({ context, active, lifetime }, run)
}

/** Bind a source interpreter to the actual executor frame, including its cancellation and byte allowance. */
export function getActionLifetime() {
  const frame = scope.getStore()
  if (frame?.lifetime === undefined) throw new KernelError('INVALID', 'No native action lifetime is bound')
  frame.active()
  return { ...frame.lifetime, assertActive: frame.active }
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
