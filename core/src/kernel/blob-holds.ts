import { KernelError } from '#errors';
import { isRecord } from '#util/is-record';
import { blobIds, type BlobReferenceWork } from '#kernel/blob-references';
import type {
  BlobHold,
  BlobHoldRow,
  Budget,
  JournalAddress,
  JournalEntry,
  Position,
  StoreCommit,
} from '#kernel/types';

interface HistoryHold {
  readonly pos: Position;
  readonly id: string;
  readonly acceptedAt?: number;
  readonly retainUntil?: number;
  readonly ids: readonly string[];
}

export interface BlobHoldSnapshot {
  readonly nodes: readonly { readonly path: string; readonly ids: readonly string[] }[];
  readonly history: readonly HistoryHold[];
  readonly released: readonly { readonly id: string; readonly at: number }[];
  readonly acceptedAt: number;
}

/** Stages bounded reference metadata alongside the owning Store's canonical publication. */
export function createBlobHolds(snapshot?: BlobHoldSnapshot) {
  let nodes = new Map(snapshot?.nodes.map((item) => [item.path, item.ids]));
  let history = new Map(snapshot?.history.map((item) => [entryKey(item.pos, item.id), item]));
  let released = new Map(snapshot?.released.map((item) => [item.id, item.at]));
  let acceptedAt = snapshot?.acceptedAt ?? 0;
  let counts = count(nodes, history);

  /** Serializes actual accepted reference metadata without copying node or journal payloads. */
  function save(): BlobHoldSnapshot {
    return {
      nodes: [...nodes].map(([path, ids]) => ({ path, ids })),
      history: [...history.values()],
      released: [...released].map(([id, at]) => ({ id, at })),
      acceptedAt,
    };
  }

  /** Returns aggregate holds for requested identities, including their last accepted release. */
  function get(ids: readonly string[]): readonly BlobHold[] {
    return ids.map((id) => ({
      id,
      live: counts.get(id)?.live ?? 0,
      history: counts.get(id)?.history ?? 0,
      releasedAt: released.get(id) ?? 0,
    }));
  }

  /** Streams existing sparse metadata without collecting another owner-sized snapshot. */
  function* census(): Iterable<BlobHoldRow> {
    for (const [key, ids] of nodes) yield { t: 'live', key, ids };
    for (const entry of history.values())
      yield {
        t: 'history',
        address: { pos: entry.pos, id: entry.id },
        acceptedAt: entry.acceptedAt,
        ...(entry.retainUntil === undefined ? {} : { retainUntil: entry.retainUntil }),
        ids: entry.ids,
      };
    for (const [id, at] of released) yield { t: 'released', id, at };
  }

  /** Builds a fallible candidate; the returned publisher has no I/O or validation. */
  function stage(
    commit: StoreCommit,
    budget?: Budget,
    retained?: readonly StoreCommit[],
    maintenance?: {
      readonly retained: readonly {
        readonly pos: Position;
        readonly entry: JournalEntry;
        readonly acceptedAt?: number;
        readonly retainUntil?: number;
      }[];
      readonly retired: readonly JournalAddress[];
    },
    work: BlobReferenceWork = { exprWork: 0 },
  ) {
    const time = commit.acceptedAt;
    if (time === undefined || !Number.isFinite(time) || time < acceptedAt)
      throw new KernelError('INVALID', 'Blob holds require an ordered accepted timestamp');
    const retention = commit.journalRetentionMs;
    if (
      retention !== undefined &&
      (!Number.isFinite(retention) || retention < 0 || !Number.isFinite(time + retention))
    )
      throw new KernelError('INVALID', 'Blob history retention is invalid');
    const writes = commit.writes.map((write) => ({
      path: write.path,
      ids: write.node === null ? null : blobIds(write.node, budget, work),
    }));
    const after = new Map(writes.map((write) => [write.path, write.ids]));
    const entries: HistoryHold[] = [];
    for (const entry of commit.record.entries) {
      const ids = new Set(blobIds(entry.change, budget, work));
      if (entry.change.t !== 'reconcile' || entry.change.before !== undefined)
        for (const id of nodes.get(entry.from ?? entry.path) ?? []) ids.add(id);
      for (const id of after.get(entry.path) ?? []) ids.add(id);
      if (ids.size > 0)
        entries.push({
          pos: commit.pos,
          id: entry.id,
          acceptedAt: time,
          ...(retention === undefined ? {} : { retainUntil: time + retention }),
          ids: [...ids],
        });
    }
    for (const entry of entries)
      if (retained === undefined && history.has(entryKey(entry.pos, entry.id)))
        throw new KernelError('CONFLICT', 'Blob history address already exists');
    const nextHistory = retained === undefined ? undefined : new Map<string, HistoryHold>();
    if (retained !== undefined)
      for (const accepted of retained)
        for (const entry of accepted.record.entries) {
          const previous = history.get(entryKey(accepted.pos, entry.id));
          const ids = new Set(previous?.ids);
          for (const id of blobIds(entry.change, budget, work)) ids.add(id);
          if (ids.size > 0)
            nextHistory!.set(entryKey(accepted.pos, entry.id), {
              pos: accepted.pos,
              id: entry.id,
              acceptedAt: accepted.acceptedAt,
              ...(previous?.retainUntil === undefined ? {} : { retainUntil: previous.retainUntil }),
              ids: [...ids],
            });
        }
    const changed = new Map<string, { live: number; history: number }>();
    const promoted: HistoryHold[] = [];
    for (const unit of maintenance?.retained ?? []) {
      const previous = history.get(entryKey(unit.pos, unit.entry.id));
      const ids = new Set(previous?.ids);
      for (const id of blobIds(unit.entry.change, budget, work)) ids.add(id);
      if (ids.size > 0)
        promoted.push({
          pos: unit.pos,
          id: unit.entry.id,
          acceptedAt: previous?.acceptedAt ?? unit.acceptedAt,
          retainUntil: previous?.retainUntil ?? unit.retainUntil,
          ids: [...ids],
        });
    }

    /** Changes only identities touched by this commit or retired journal records. */
    function adjust(ids: readonly string[], field: 'live' | 'history', delta: number): void {
      for (const id of ids) {
        const item = changed.get(id) ?? { ...(counts.get(id) ?? { live: 0, history: 0 }) };
        item[field] += delta;
        if (item[field] < 0) throw new KernelError('INVALID', 'Blob hold count is negative');
        changed.set(id, item);
      }
    }

    for (const write of writes) {
      adjust(nodes.get(write.path) ?? [], 'live', -1);
      if (write.ids !== null) adjust(write.ids, 'live', 1);
    }
    if (nextHistory === undefined) for (const entry of entries) adjust(entry.ids, 'history', 1);
    else {
      for (const record of history.values()) adjust(record.ids, 'history', -1);
      for (const record of nextHistory.values()) adjust(record.ids, 'history', 1);
    }
    for (const entry of promoted) {
      adjust(history.get(entryKey(entry.pos, entry.id))?.ids ?? [], 'history', -1);
      adjust(entry.ids, 'history', 1);
    }
    const promotions = new Map(promoted.map((entry) => [entryKey(entry.pos, entry.id), entry]));
    for (const address of maintenance?.retired ?? []) {
      const key = entryKey(address.pos, address.id);
      adjust((promotions.get(key) ?? history.get(key))?.ids ?? [], 'history', -1);
    }

    return () => {
      for (const write of writes) {
        if (write.ids === null || write.ids.length === 0) nodes.delete(write.path);
        else nodes.set(write.path, write.ids);
      }
      if (nextHistory === undefined)
        for (const entry of entries) history.set(entryKey(entry.pos, entry.id), entry);
      else history = nextHistory;
      for (const entry of promoted) history.set(entryKey(entry.pos, entry.id), entry);
      for (const address of maintenance?.retired ?? [])
        history.delete(entryKey(address.pos, address.id));
      for (const [id, item] of changed) {
        if (item.live + item.history === 0) {
          counts.delete(id);
          released.set(id, time);
        } else counts.set(id, item);
      }
      acceptedAt = time;
    };
  }

  return { save, get, stage, census };
}

/** Encodes a position without relying on object property order. */
function entryKey(position: Position, id: string): string {
  return JSON.stringify([position.instance, position.epoch, position.seq, id]);
}

/** Counts per-node and per-record identity sets, preserving shared references. */
function count(
  nodes: ReadonlyMap<string, readonly string[]>,
  history: ReadonlyMap<string, HistoryHold>,
) {
  const result = new Map<string, { live: number; history: number }>();
  for (const ids of nodes.values())
    for (const id of ids) {
      const item = result.get(id) ?? { live: 0, history: 0 };
      item.live++;
      result.set(id, item);
    }
  for (const record of history.values())
    for (const id of record.ids) {
      const item = result.get(id) ?? { live: 0, history: 0 };
      item.history++;
      result.set(id, item);
    }
  return result;
}

/** Validates reference metadata when an Fs snapshot crosses its persisted format boundary. */
export function isBlobHoldSnapshot(value: unknown): value is BlobHoldSnapshot {
  if (
    !isRecord(value) ||
    typeof value.acceptedAt !== 'number' ||
    !Number.isFinite(value.acceptedAt) ||
    !Array.isArray(value.nodes) ||
    !Array.isArray(value.history) ||
    !Array.isArray(value.released)
  )
    return false;
  return (
    value.nodes.every(
      (item) =>
        isRecord(item) &&
        typeof item.path === 'string' &&
        Array.isArray(item.ids) &&
        item.ids.every((id) => typeof id === 'string'),
    ) &&
    value.history.every(
      (item) =>
        isRecord(item) &&
        typeof item.id === 'string' &&
        isRecord(item.pos) &&
        (item.acceptedAt === undefined ||
          (typeof item.acceptedAt === 'number' && Number.isFinite(item.acceptedAt))) &&
        (item.retainUntil === undefined ||
          (typeof item.retainUntil === 'number' && Number.isFinite(item.retainUntil))) &&
        typeof item.pos.instance === 'string' &&
        Number.isSafeInteger(item.pos.epoch) &&
        Number.isSafeInteger(item.pos.seq) &&
        Array.isArray(item.ids) &&
        item.ids.every((id) => typeof id === 'string'),
    ) &&
    value.released.every(
      (item) =>
        isRecord(item) &&
        typeof item.id === 'string' &&
        typeof item.at === 'number' &&
        Number.isFinite(item.at),
    )
  );
}
