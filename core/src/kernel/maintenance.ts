import { KernelError } from '#errors';
import type { JournalCommit, Position, StoreCommit } from '#kernel/types';

/** Retention uses the root's already published expiry floor for decision removal. */
export function maintenanceRecord(
  pos: Position,
  journalBefore: number,
  decisionBefore: number,
): JournalCommit {
  return {
    pos,
    kind: 'kernel',
    executor: 'kernel',
    caller: 'kernel',
    entries: [],
    maintenance: { journalBefore, decisionBefore },
  };
}

/** Maintenance changes journal storage, never authored node data. */
export function assertMaintenance(commit: StoreCommit): void {
  const record = commit.record,
    intent = record.maintenance;
  if (intent === undefined) return;

  if (
    record.kind !== 'kernel' ||
    record.executor !== 'kernel' ||
    record.caller !== 'kernel' ||
    record.entries.length !== 0 ||
    commit.writes.length !== 0 ||
    record.quarantine !== undefined ||
    record.decision !== undefined ||
    record.anchorDecision !== undefined ||
    !Number.isFinite(intent.journalBefore) ||
    !Number.isFinite(intent.decisionBefore) ||
    intent.decisionBefore < 0
  )
    throw new KernelError('INVALID', 'Invalid journal maintenance intent');
}
