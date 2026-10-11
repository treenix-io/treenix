import { KernelError } from '#errors'
import type { JournalCommit, Position, Rev } from '#kernel/types'

/** Physical transfer preserves native revisions; authored writes use their accepted commit position. */
export function acceptsWritePosition(node: Position, commit: Position, kind: JournalCommit['kind']): boolean {
  if (node.instance !== commit.instance) return false

  return kind === 'transfer' ? comparePositions(node, commit) <= 0 : comparePositions(node, commit) === 0
}

export function comparePositions(a: Position, b: Position): number {
  if (a.instance !== b.instance) throw new KernelError('INVALID', 'Positions belong to different instances')
  if (a.epoch !== b.epoch) return a.epoch < b.epoch ? -1 : 1
  return a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0
}

export const positionToRev = (pos: Position): Rev => JSON.stringify([pos.instance, pos.epoch, pos.seq])

export function revToPosition(rev: Rev): Position {
  let raw: unknown
  try { raw = JSON.parse(rev) } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    console.error(error)
    throw new KernelError('INVALID', 'Malformed node revision')
  }
  if (!Array.isArray(raw) || raw.length !== 3 || typeof raw[0] !== 'string' || raw[0].length === 0
    || !Number.isSafeInteger(raw[1]) || raw[1] < 0 || !Number.isSafeInteger(raw[2]) || raw[2] < 0) {
    throw new KernelError('INVALID', 'Malformed node revision')
  }
  return { instance: raw[0], epoch: raw[1], seq: raw[2] }
}
