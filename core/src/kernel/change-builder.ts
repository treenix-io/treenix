import { KernelError } from '#errors'
import { serializeRequest } from '#kernel/request'
import type { ChangeBuilder, ChangeMember, JournalAddress, Limits, NodeInput, Path, UpdateOps } from '#kernel/types'
import { freeze } from '#util/freeze'

/** Accumulate owned changes; a budget refusal remains fatal even if a handler catches it. */
export function createChangeBuilder(active: () => void, limits: Limits) {
  const changes: ChangeMember[] = []
  let closed = false
  let bytes = 0
  let failure: KernelError | undefined

  /** Preserve a latched budget refusal through finalization. */
  function check(): void { active(); if (failure !== undefined) throw failure }

  /** Own and charge a member before adding it to the atomic change set. */
  function add(input: ChangeMember): void {
    check()
    if (closed) throw new KernelError('INVALID', 'Action changes are closed')
    const owned = structuredClone(input)
    bytes += Buffer.byteLength(serializeRequest(owned))
    if (changes.length >= limits.changeSet || bytes > limits.requestBytes) {
      failure = new KernelError('BUDGET', 'Action changes exceed their budget')
      throw failure
    }
    changes.push(freeze(owned))
  }

  const change: ChangeBuilder = Object.freeze({
    put: (node: NodeInput) => add({ op: 'put', node }),
    patch: (path: Path, ops: UpdateOps) => add({ op: 'patch', path, ops }),
    remove: (path: Path) => add({ op: 'remove', path }),
    move: (from: Path, to: Path) => add({ op: 'move', from, to }),
    restore: (record: JournalAddress) => add({ op: 'restore', record }),
  })
  return { change,
    /** Seal the complete owned change set for the native writer. */
    finish(): readonly ChangeMember[] { check(); closed = true; return Object.freeze([...changes]) },
    /** Release staged members after completion or refusal. */
    discard(): void { closed = true; changes.length = 0 } }
}
