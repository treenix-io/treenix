import { KernelError } from '#errors'
import type { Actor, Gate, Operation } from '#kernel/types'

export interface GateContext { readonly signal: AbortSignal; readonly deadline: number }

async function judge(gates: readonly Gate[], operation: Operation, actor: Actor, check: () => void): Promise<void> {
  for (const gate of gates) {
    check()
    let result: Awaited<ReturnType<Gate>>
    try { result = await gate(operation, actor) }
    catch (error) {
      console.error(error)
      if (error instanceof KernelError && (error.code === 'REFUSED' || error.code === 'BUDGET')) throw error
      throw new KernelError('REFUSED', 'Operation gate failed')
    }
    check()
    if (result !== 'pass') throw new KernelError(result.refuse, 'Operation was refused')
  }
}

export async function judgeGates(gates: readonly Gate[], operation: Operation, actor: Actor, context: GateContext): Promise<void> {
  const cancellation = () => context.signal.reason instanceof KernelError ? context.signal.reason : new KernelError('CANCELLED', 'Request ended')
  function active(): void { if (context.signal.aborted) throw cancellation() }
  active()
  if (gates.length === 0) return
  let timer: ReturnType<typeof setTimeout> | undefined
  let expired = false
  let aborted: () => void = () => {}
  const ended = new Promise<never>((_resolve, reject) => {
    aborted = () => reject(cancellation())
    context.signal.addEventListener('abort', aborted, { once: true })
    timer = setTimeout(() => { expired = true; reject(new KernelError('BUDGET', 'Gate deadline exceeded')) }, Math.max(0, context.deadline - Date.now()))
    timer.unref()
  })
  const check = () => {
    active()
    if (expired || Date.now() > context.deadline) throw new KernelError('BUDGET', 'Gate deadline exceeded')
  }
  try { await Promise.race([judge(gates, operation, actor, check), ended]) }
  finally {
    if (timer !== undefined) clearTimeout(timer)
    context.signal.removeEventListener('abort', aborted)
  }
}
