import { KernelError } from '#errors'
import { isDeepStrictEqual } from 'node:util'
import { comparePositions } from '#kernel/position'
import type { FieldDeltas, JournalAddress, JournalCommit, JournalEntry, NodeTransition, OpDecision, OpId, Position, Principal, StoredNode } from '#kernel/types'
import { applyDelta, computeDelta, getByPath } from '#kernel/update-ops'

export interface JournalImages {
  readonly before: StoredNode | null | 'unknown'
  readonly after: StoredNode | null
}

/** Select the queried key from a physical record while preserving each alias's original request hash. */
export function matchingDecision(record: JournalCommit, caller: Principal, opId: OpId): OpDecision {
  if (record.caller !== caller) throw new KernelError('INVALID', 'Decision lookup returned another caller')
  for (const decision of [record.decision, record.anchorDecision]) {
    if (decision !== undefined && decision.opId.epoch === opId.epoch
      && decision.opId.time === opId.time && decision.opId.nonce === opId.nonce) return decision
  }
  throw new KernelError('INVALID', 'Decision lookup returned another key')
}

/** A terminal alias is accepted only alongside the same physical final outcome for the continuing call. */
export function assertDecisionAliases(record: JournalCommit): void {
  const anchor = record.anchorDecision
  if (anchor === undefined) return
  const decision = record.decision
  if (decision === undefined || decision.outcome === undefined || anchor.outcome === undefined
    || decision.stream === undefined || anchor.stream === undefined
    || !isDeepStrictEqual(decision.stream, anchor.stream)
    || !isDeepStrictEqual(decision.outcome, anchor.outcome)
    || decision.outcome.pos === undefined || comparePositions(decision.outcome.pos, record.pos) !== 0
    || isDeepStrictEqual(decision.opId, anchor.opId))
    throw new KernelError('INVALID', 'Stream final decisions do not describe one accepted outcome')
}

export function computeFieldDeltas(before: Record<string, unknown>, after: Record<string, unknown>): FieldDeltas {
  const difference = computeDelta(before, after)
  const fields: Record<string, FieldDeltas[string]> = {}
  for (const field of [...Object.keys(difference.set ?? {}), ...difference.unset ?? []]) {
    const parts = field.split('.'), key = parts.pop()!
    const parent = parts.length === 0 ? before : getByPath(before, parts.join('.'))
    const present = field === '' || parent !== null && typeof parent === 'object' && Object.hasOwn(parent, key)
    fields[field] = {
      ...present ? { from: structuredClone(field === '' ? before : getByPath(before, field)) } : {},
      ...difference.set !== undefined && Object.hasOwn(difference.set, field) ? { to: difference.set[field] } : {},
    }
  }
  return fields
}

export function applyFieldDeltas<T extends Record<string, unknown>>(image: T, fields: FieldDeltas, side: 'from' | 'to'): T {
  const set: Record<string, unknown> = {}, unset: string[] = []
  for (const [field, change] of Object.entries(fields)) {
    if (Object.hasOwn(change, side)) set[field] = change[side]
    else unset.push(field)
  }
  return applyDelta(image, { set, unset })
}

export function encodeJournalEntry(before: StoredNode | null, after: StoredNode | null, changedBytes = 0, fullImage = false): {
  readonly entry: JournalEntry
  readonly changedBytes: number
} {
  if (after === null) {
    if (before === null) throw new KernelError('INVALID', 'Deletion requires a previous image')
    return { entry: { id: before.$id, path: before.$path, change: { t: 'delete', before: structuredClone(before) } }, changedBytes: 0 }
  }
  if (before === null) return {
    entry: { id: after.$id, path: after.$path, change: { t: 'create', after: structuredClone(after) } }, changedBytes: 0,
  }
  if (before.$id !== after.$id) throw new KernelError('INVALID', 'An update cannot change node identity')
  const delta = computeFieldDeltas(before, after)
  const bytes = changedBytes + Buffer.byteLength(JSON.stringify(delta))
  const full = fullImage || bytes > Buffer.byteLength(JSON.stringify(after))
  return {
    entry: { id: after.$id, path: after.$path, ...before.$path !== after.$path ? { from: before.$path } : {},
      change: { t: 'update', delta, ...full ? { after: structuredClone(after) } : {} } },
    changedBytes: full ? 0 : bytes,
  }
}

export function encodeReconciliation(id: string, path: string, after: StoredNode | null): JournalEntry {
  return { id, path, change: { t: 'reconcile', after: structuredClone(after) } }
}

export function applyJournalChange(change: NodeTransition, previous: JournalImages['before']): JournalImages {
  switch (change.t) {
    case 'create': return { before: null, after: change.after }
    case 'delete': return { before: change.before, after: null }
    case 'reconcile': return { before: change.before === undefined ? previous : change.before, after: change.after }
    case 'update': {
      if (change.after !== undefined) return { before: applyFieldDeltas(change.after, change.delta, 'from'), after: change.after }
      if (previous === null || previous === 'unknown') throw new KernelError('INVALID', 'Journal update has no full image')
      return { before: previous, after: applyFieldDeltas(previous, change.delta, 'to') }
    }
  }
}

function fullAfter(change: NodeTransition): StoredNode | null | undefined {
  return change.t === 'delete' ? null : change.after
}

export function readJournalImages(records: readonly JournalCommit[], address: JournalAddress): JournalImages {
  const index = records.findIndex(record => comparePositions(record.pos, address.pos) === 0)
  const target = index < 0 ? undefined : records[index].entries.find(entry => entry.id === address.id)
  if (target === undefined) throw new KernelError('NOT_FOUND', 'Journal address is absent')
  const change = target.change
  if (change.t !== 'reconcile' && fullAfter(change) !== undefined || change.t === 'reconcile' && change.before !== undefined) {
    return structuredClone(applyJournalChange(change, 'unknown'))
  }
  const pending: NodeTransition[] = [change]
  let previous: JournalImages['before'] = 'unknown'
  for (let i = index - 1; i >= 0; i--) {
    const entry = records[i].entries.find(item => item.id === address.id)
    if (entry === undefined) continue
    const full = fullAfter(entry.change)
    if (full !== undefined) { previous = full; break }
    pending.push(entry.change)
  }
  let result: JournalImages = { before: 'unknown', after: null }
  for (const transition of pending.reverse()) {
    result = applyJournalChange(transition, previous)
    previous = result.after
  }
  return structuredClone(result)
}

/** The first kept record must carry its own anchor, including a known reconciliation before-image. */
export function compactJournal(
  records: readonly JournalCommit[],
  keepFrom: Position,
  expiryBoundary = 0,
): readonly JournalCommit[] {
  const current = new Map<string, StoredNode | null>();
  const anchored = new Set<string>();
  const kept: JournalCommit[] = [];
  let intake: JournalCommit | undefined;
  for (const record of records) if (record.intake !== undefined) intake = record;
  for (const record of records) {
    const retain = comparePositions(record.pos, keepFrom) >= 0;
    const entries: JournalEntry[] = [];
    for (const entry of record.entries) {
      const prior = current.get(entry.id);
      const state = applyJournalChange(entry.change, prior === undefined ? 'unknown' : prior);
      current.set(entry.id, state.after);
      if (!retain) continue;
      let change = entry.change;
      if (!anchored.has(entry.id)) {
        anchored.add(entry.id);
        if (change.t === 'update') {
          if (state.after === null)
            throw new KernelError('INVALID', 'Journal update has no after-image');
          change = { ...change, after: state.after };
        } else if (change.t === 'reconcile' && state.before !== 'unknown')
          change = { ...change, before: state.before };
      }
      entries.push({ ...entry, change });
    }
    if (
      retain ||
      record === intake ||
      (record.decision !== undefined && record.decision.opId.time >= expiryBoundary) ||
      (record.anchorDecision !== undefined && record.anchorDecision.opId.time >= expiryBoundary)
    ) {
      kept.push(structuredClone({ ...record, entries }));
    }
  }
  return kept;
}
