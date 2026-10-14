import { KernelError } from '@treenx/core/errors';
import { compactJournal } from '@treenx/core/kernel/journal';
import type { JournalCommit, JournalEntry, Position } from '@treenx/core/kernel/types';

export interface JournalRetentionAge {
  readonly acceptedAt: number;
  readonly retainUntil: number;
}

/** Clock rollback and later policy changes cannot shorten an accepted record's declared lifetime. */
export function retentionAge(
  acceptedAt: number | undefined,
  acceptedClock: number,
  retentionMs: number,
): JournalRetentionAge {
  if (
    !Number.isFinite(acceptedClock) ||
    !Number.isFinite(retentionMs) ||
    retentionMs < 0 ||
    (acceptedAt !== undefined && !Number.isFinite(acceptedAt))
  )
    throw new KernelError('INVALID', 'Invalid journal retention clock');

  const time = Math.max(acceptedClock, acceptedAt ?? acceptedClock);
  const retainUntil = time + retentionMs;
  if (!Number.isFinite(retainUntil))
    throw new KernelError('INVALID', 'Journal retention lifetime exceeds clock range');

  return { acceptedAt: time, retainUntil };
}

/** Unknown legacy decision times remain protected until their expiry can be proved durably. */
export function decisionRetained(
  decision: boolean,
  time: number | undefined,
  durableBoundary: number,
): boolean {
  if (!Number.isFinite(durableBoundary) || durableBoundary < 0)
    throw new KernelError('INVALID', 'Invalid durable decision boundary');

  return decision && (time === undefined || time >= durableBoundary);
}

/** Promote one successor with the canonical compactor before its only earlier anchor can disappear. */
export function anchorSuccessor(
  previous: JournalEntry,
  next: JournalEntry,
  previousPos: Position,
  nextPos: Position,
): JournalEntry {
  if (previous.id !== next.id) throw new KernelError('INVALID', 'Journal anchor identity differs');

  const record = (pos: Position, entry: JournalEntry): JournalCommit => ({
    pos,
    kind: 'kernel',
    executor: 'kernel',
    caller: 'kernel',
    entries: [entry],
  });
  const retained = compactJournal([record(previousPos, previous), record(nextPos, next)], nextPos);
  return retained[0].entries[0];
}
