import { KernelError } from '#errors'
import { assertDecisionAliases } from '#kernel/journal'
import { assertMaintenance } from '#kernel/maintenance'
import { acceptsWritePosition } from '#kernel/position'
import type { Position, StoreCommit } from '#kernel/types'

const equalPosition = (a: Position, b: Position) => a.instance === b.instance && a.epoch === b.epoch && a.seq === b.seq

/** Reject inconsistent addresses before any Store can publish data or a journal record. */
export function assertStoreCommit(commit: StoreCommit): void {
  assertMaintenance(commit)
  if (!equalPosition(commit.pos, commit.record.pos)) throw new KernelError('INVALID', 'Data and journal positions differ')
  const paths = new Set<string>()
  for (const write of commit.writes) {
    if (paths.has(write.path)) throw new KernelError('INVALID', 'Duplicate stored write')
    paths.add(write.path)
    if (write.node !== null && (write.node.$path !== write.path || !acceptsWritePosition(write.node.$pos, commit.pos, commit.record.kind)))
      throw new KernelError('INVALID', 'Stored node address or position differs from its commit')
  }
  if (commit.transferBefore !== undefined) {
    if (commit.record.kind !== 'transfer') throw new KernelError('INVALID', 'Transfer originals require a physical transfer')
    const originals = new Set<string>()
    for (const original of commit.transferBefore) {
      if (!paths.has(original.path) || originals.has(original.path))
        throw new KernelError('INVALID', 'Transfer original differs from its writes')
      originals.add(original.path)
    }
  }
  if (commit.transferAbsent !== undefined) {
    if (commit.record.kind !== 'transfer') throw new KernelError('INVALID', 'Transfer absence requires a physical transfer')
    const absent = new Set<string>()
    for (const path of commit.transferAbsent) {
      if (!paths.has(path) || absent.has(path) || commit.transferBefore?.some(original => original.path === path))
        throw new KernelError('INVALID', 'Transfer absence differs from its writes')
      absent.add(path)
    }
  }
  assertDecisionAliases(commit.record)
}
