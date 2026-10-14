import type { MongoOwnerControl } from '#owner';
import { isDeepStrictEqual } from 'node:util';
import type { ClientSession, Collection, Document } from 'mongodb';
import { KernelError } from '@treenx/core/errors';
import { applyJournalChange } from '@treenx/core/kernel/journal';
import type { Budget, JournalEntry, Position, StoredNode } from '@treenx/core/kernel/types';
import { anchorSuccessor, retentionAge } from '#retention-plan';
import {
  chargeJournal,
  FRAGMENT_HEAD_PROJECTION,
  JOURNAL_ENTRY_PROJECTION,
  JOURNAL_HEADER_FIELDS,
  journalTimeout,
  readInlineHead,
  readJournalEntry,
  readJournalPosition,
  readJournalVisibility,
  type JournalCollections,
  type JournalEntryIndex,
  type JournalHead,
} from '#journal-records';
import {
  journalCommandTimeout,
  serializeJournalBson,
  writeJournalUnit,
  type JournalReadLedger,
} from '#journal-units';

export interface RetentionControl {
  readonly _id: string;
  readonly acceptedClock?: number;
  readonly journalFloor?: Position;
  readonly decisionFloor?: number;
  readonly retentionCursor?: RetentionCursor;
}

export interface RetentionCursor {
  readonly position: string;
  readonly ordinal: number;
  readonly logicalBytes: number;
  readonly entries: number;
  readonly payloadBytes: number;
  readonly stripped?: boolean;
}

export interface MaintenanceLedger extends JournalReadLedger {
  nodes: number;
}

interface Promotion {
  readonly index: JournalEntryIndex;
  readonly root: JournalHead;
  readonly before: JournalEntry;
  readonly after: JournalEntry;
  readonly position: Position;
}

export interface RetentionHooks {
  retainedEntry(position: Position, entry: JournalEntry, session: ClientSession): Promise<void>;
  retiredEntry(position: Position, id: string, session: ClientSession): Promise<void>;
}

/** Keep position ordering in Mongo's fixed native index fields. */
function later(index: JournalEntryIndex): Document {
  return {
    $or: [{ epoch: { $gt: index.epoch } }, { epoch: index.epoch, seq: { $gt: index.seq } }],
  };
}

/** Load a bounded root identity, never the record's complete entry array. */
async function head(
  collections: JournalCollections,
  position: string,
  ledger: JournalReadLedger,
  session: ClientSession,
): Promise<JournalHead> {
  const inline = await readInlineHead(
    collections,
    { _position: position },
    ledger,
    undefined,
    session,
  );
  if (inline !== null) return inline;
  const fragmented = await collections.headers.findOne(
    { _position: position },
    {
      projection: FRAGMENT_HEAD_PROJECTION,
      session,
      ...journalCommandTimeout(ledger.budget.deadline, session),
      collation: { locale: 'simple' },
    },
  );
  if (fragmented === null) throw new KernelError('INVALID', 'Journal entry root is absent');
  chargeJournal(fragmented, ledger);
  return fragmented;
}

/** Every selected image and its metadata consume the current maintenance allowance. */
async function entry(
  collections: JournalCollections,
  index: JournalEntryIndex,
  ledger: MaintenanceLedger,
  session: ClientSession,
): Promise<{ readonly root: JournalHead; readonly value: JournalEntry }> {
  if (ledger.nodes >= ledger.budget.nodes)
    throw new KernelError('BUDGET', 'Journal maintenance node allowance exceeded');
  ledger.nodes++;
  chargeJournal(index, ledger);
  const root = await head(collections, index.position, ledger, session);
  const visibility = await readJournalVisibility(collections, index, ledger, session);
  chargeJournal(visibility, ledger);
  const value = await readJournalEntry(collections, root, index, ledger, visibility, session);
  chargeJournal(value, ledger);
  return { root, value };
}

/** Reconstruct a real predecessor anchor through only this identity's indexed chain. */
export async function readAnchoredJournalEntry(
  collections: JournalCollections,
  selected: JournalEntryIndex,
  ledger: MaintenanceLedger,
  session: ClientSession,
): Promise<{ readonly root: JournalHead; readonly value: JournalEntry }> {
  const chain: JournalEntry[] = [];
  let index: JournalEntryIndex | null = selected;
  let selectedRoot: JournalHead | undefined;
  while (index !== null) {
    const loaded = await entry(collections, index, ledger, session);
    selectedRoot ??= loaded.root;
    chain.push(loaded.value);
    if (loaded.value.change.t !== 'update' || loaded.value.change.after !== undefined) break;
    index = await collections.entries.findOne(
      {
        owner: collections.owner,
        idIdentity: selected.idIdentity,
        $or: [{ epoch: { $lt: index.epoch } }, { epoch: index.epoch, seq: { $lt: index.seq } }],
      },
      {
        projection: JOURNAL_ENTRY_PROJECTION,
        sort: { epoch: -1, seq: -1, ordinal: -1 },
        session,
        ...journalCommandTimeout(ledger.budget.deadline, session),
        collation: { locale: 'simple' },
      },
    );
  }
  let image: StoredNode | null | 'unknown' = 'unknown';
  for (const value of chain.reverse()) image = applyJournalChange(value.change, image).after;
  const value = chain[chain.length - 1];
  if (selectedRoot === undefined)
    throw new KernelError('INVALID', 'Journal retention root is absent');
  if (value.change.t !== 'update') return { root: selectedRoot, value };
  if (image === null || image === 'unknown')
    throw new KernelError('INVALID', 'Journal retention anchor is absent');
  return { root: selectedRoot, value: { ...value, change: { ...value.change, after: image } } };
}

/** Replace one promoted image and its exact size manifests inside the owning transaction. */
async function promote(
  collections: JournalCollections,
  index: JournalEntryIndex,
  root: JournalHead,
  before: JournalEntry,
  after: JournalEntry,
  ledger: JournalReadLedger,
  session: ClientSession,
): Promise<void> {
  if (isDeepStrictEqual(before, after)) return;
  const logical =
    Buffer.byteLength(JSON.stringify(after)) - Buffer.byteLength(JSON.stringify(before));
  const physical =
    serializeJournalBson({ value: after }).length - serializeJournalBson({ value: before }).length;
  const command = {
    session,
    ...journalCommandTimeout(ledger.budget.deadline, session),
    collation: { locale: 'simple' },
  };
  if ('_format' in root && index.entry === undefined)
    throw new KernelError('INVALID', 'Promoted journal unit is absent');
  const identity = {
    owner: collections.owner,
    position: index.position,
    unit: `entry:${index.ordinal}`,
  };
  if (index.entry !== undefined) await collections.chunks.deleteMany(index.entry.identity, command);
  const unit = await writeJournalUnit(
    collections.chunks,
    identity,
    { value: after },
    session,
    ledger.budget.deadline,
  );
  const indexed = await collections.entries.updateOne(
    { _id: index._id },
    { $set: { entry: unit } },
    command,
  );
  if (indexed.matchedCount !== 1)
    throw new KernelError('INVALID', 'Promoted journal entry disappeared');

  if (!('_format' in root)) {
    const changed = await collections.roots.updateOne(
      { _id: root._id },
      {
        $set: { _entryOverrides: true },
        $inc: { _logicalBytes: logical, _bsonBytes: physical },
      },
      command,
    );
    if (changed.matchedCount !== 1)
      throw new KernelError('INVALID', 'Promoted journal root disappeared');
    return;
  }
  if (index.entry === undefined)
    throw new KernelError('INVALID', 'Promoted journal unit is absent');
  await collections.headers.updateOne(
    { _id: root._id },
    {
      $inc: { logicalBytes: logical, payloadBsonBytes: unit.bsonBytes - index.entry.bsonBytes },
    },
    command,
  );
}

/** Adopt untimed legacy roots once; absence never becomes an immediate expiry claim. */
export async function adoptRetention(
  collections: JournalCollections,
  acceptedClock: number,
  retentionMs: number,
  ledger: MaintenanceLedger,
  changeSet: number,
  session: ClientSession,
): Promise<boolean> {
  const budget = ledger.budget;
  const age = retentionAge(undefined, acceptedClock, retentionMs);
  let remaining = Math.min(changeSet, budget.nodes - ledger.nodes, 100);
  if (!Number.isSafeInteger(remaining) || remaining < 1)
    throw new KernelError('BUDGET', 'Journal maintenance node allowance is empty');
  for (const collection of [collections.roots, collections.headers]) {
    while (remaining-- > 0) {
      const selected = await collection.findOne(
        { _retainUntil: { $exists: false } },
        {
          projection: { _id: 1, _acceptedAt: 1 },
          session,
          ...journalCommandTimeout(budget.deadline, session),
          collation: { locale: 'simple' },
        },
      );
      if (selected === null) break;
      try {
        chargeJournal(selected, ledger);
      } catch (error) {
        if (
          !(error instanceof KernelError) ||
          error.code !== 'BUDGET' ||
          ledger.nodes === 0 ||
          Date.now() >= budget.deadline
        )
          throw error;
        return true;
      }
      ledger.nodes++;
      await collection.updateOne(
        { _id: selected._id },
        {
          $set: {
            _acceptedAt: selected._acceptedAt ?? age.acceptedAt,
            _retainUntil: age.retainUntil,
          },
        },
        {
          session,
          ...journalCommandTimeout(budget.deadline, session),
          collation: { locale: 'simple' },
        },
      );
    }
  }
  if (ledger.nodes !== 0) return true;
  return (
    (await collections.roots.countDocuments(
      { _retainUntil: { $exists: false } },
      { limit: 1, session, ...journalCommandTimeout(budget.deadline, session) },
    )) !== 0 ||
    (await collections.headers.countDocuments(
      { _retainUntil: { $exists: false } },
      { limit: 1, session, ...journalCommandTimeout(budget.deadline, session) },
    )) !== 0
  );
}

/** Durable entry progress lets cold maintenance resume without retaining payloads between batches. */
export async function promoteExpiredEntries(
  collections: JournalCollections,
  control: Collection<MongoOwnerControl>,
  state: RetentionControl,
  root: JournalHead,
  ledger: MaintenanceLedger,
  changeSet: number,
  session: ClientSession,
  hooks?: RetentionHooks,
): Promise<boolean> {
  if (root._position === undefined)
    throw new KernelError('INVALID', 'Journal retention root has no native identity');
  const physicalPosition = root._position;
  const budget = ledger.budget;
  const position = await readJournalPosition(collections, root, ledger, session);
  const cursor = state.retentionCursor;
  let ordinal = cursor !== undefined && cursor.position === physicalPosition ? cursor.ordinal : 0;
  let removed =
    cursor !== undefined && cursor.position === physicalPosition
      ? cursor
      : { position: physicalPosition, ordinal: 0, logicalBytes: 0, entries: 0, payloadBytes: 0 };
  const cap = Math.min(changeSet, budget.nodes - ledger.nodes, 100);
  if (!Number.isSafeInteger(cap) || cap < 1)
    throw new KernelError('BUDGET', 'Journal maintenance node allowance is empty');
  for (let count = 0; count < cap; count++) {
    const old = await collections.entries.findOne(
      { owner: collections.owner, position: root._position, ordinal: { $gte: ordinal } },
      {
        projection: JOURNAL_ENTRY_PROJECTION,
        sort: { ordinal: 1 },
        session,
        ...journalCommandTimeout(budget.deadline, session),
        collation: { locale: 'simple' },
      },
    );
    if (old === null) return false;
    let oldEntry: JournalEntry;
    let promotion: Promotion | undefined;
    try {
      oldEntry = (await entry(collections, old, ledger, session)).value;
      const next = await collections.entries.findOne(
        { owner: collections.owner, idIdentity: old.idIdentity, ...later(old) },
        {
          projection: JOURNAL_ENTRY_PROJECTION,
          sort: { epoch: 1, seq: 1, ordinal: 1 },
          session,
          ...journalCommandTimeout(budget.deadline, session),
          collation: { locale: 'simple' },
        },
      );
      if (next !== null) {
        const loaded = await entry(collections, next, ledger, session);
        if (
          (loaded.value.change.t === 'update' && loaded.value.change.after === undefined) ||
          (loaded.value.change.t === 'reconcile' && loaded.value.change.before === undefined)
        ) {
          const source = (await readAnchoredJournalEntry(collections, old, ledger, session)).value;
          const nextPos = await readJournalPosition(collections, loaded.root, ledger, session);
          const replacement = anchorSuccessor(source, loaded.value, position, nextPos);
          chargeJournal(replacement, ledger);
          promotion = {
            index: next,
            root: loaded.root,
            before: loaded.value,
            after: replacement,
            position: nextPos,
          };
        }
      }
    } catch (error) {
      // Only pre-mutation reservations can finish a productive batch.
      if (
        !(error instanceof KernelError) ||
        error.code !== 'BUDGET' ||
        count === 0 ||
        Date.now() >= budget.deadline
      )
        throw error;
      return true;
    }
    if (promotion !== undefined) {
      await promote(
        collections,
        promotion.index,
        promotion.root,
        promotion.before,
        promotion.after,
        ledger,
        session,
      );
      await hooks?.retainedEntry(promotion.position, promotion.after, session);
    }
    ordinal = old.ordinal + 1;
    removed = {
      position: physicalPosition,
      ordinal,
      logicalBytes: removed.logicalBytes + Buffer.byteLength(JSON.stringify(oldEntry)),
      entries: removed.entries + 1,
      payloadBytes: removed.payloadBytes + (old.entry?.bsonBytes ?? 0),
    };
    await control.updateOne(
      { _id: 'writer' },
      { $set: { retentionCursor: removed } },
      {
        session,
        ...journalCommandTimeout(budget.deadline, session),
        collation: { locale: 'simple' },
      },
    );
  }
  return true;
}

/** Strip obsolete payloads once every retained successor has its reconstructable anchor. */
export async function stripExpiredRoot(
  collections: JournalCollections,
  control: Collection<MongoOwnerControl>,
  root: JournalHead,
  cursor: RetentionCursor,
  ledger: MaintenanceLedger,
  session: ClientSession,
): Promise<void> {
  const budget = ledger.budget;
  const command = {
    session,
    ...journalCommandTimeout(budget.deadline, session),
    collation: { locale: 'simple' },
  };
  const position = await readJournalPosition(collections, root, ledger, session);
  const removedBytes = cursor.logicalBytes + Math.max(0, cursor.entries - 1);
  if ('_format' in root) {
    await collections.headers.updateOne(
      { _id: root._id },
      {
        $set: { entryCount: 0, _retired: true },
        $inc: { logicalBytes: -removedBytes, payloadBsonBytes: -cursor.payloadBytes },
      },
      command,
    );
  } else {
    const canonical = Object.fromEntries(
      [...JOURNAL_HEADER_FIELDS, 'entries'].map((name) => [name, `$${name}`]),
    );
    await collections.roots.updateOne(
      { _id: root._id },
      [
        {
          $set: {
            entries: [],
            _retired: true,
            _logicalBytes: { $subtract: ['$_logicalBytes', removedBytes] },
          },
        },
        { $set: { _bsonBytes: { $bsonSize: canonical } } },
      ],
      command,
    );
  }
  await control.updateOne(
    { _id: 'writer' },
    {
      $set: {
        journalFloor: position,
        retentionCursor: { ...cursor, ordinal: 0, stripped: true },
      },
    },
    command,
  );
}

/** Exact entry rows retain provenance until their blob holds and physical units retire atomically. */
export async function retireExpiredEntries(
  collections: JournalCollections,
  control: Collection<MongoOwnerControl>,
  root: JournalHead,
  cursor: RetentionCursor,
  ledger: MaintenanceLedger,
  changeSet: number,
  session: ClientSession,
  hooks?: RetentionHooks,
): Promise<boolean> {
  const budget = ledger.budget;
  const position = await readJournalPosition(collections, root, ledger, session);
  const cap = Math.min(changeSet, budget.nodes - ledger.nodes, 100);
  if (!Number.isSafeInteger(cap) || cap < 1)
    throw new KernelError('BUDGET', 'Journal retirement allowance is empty');
  for (let count = 0; count < cap; count++) {
    const selected = await collections.entries.findOne(
      { owner: collections.owner, position: cursor.position },
      {
        projection: JOURNAL_ENTRY_PROJECTION,
        sort: { ordinal: 1 },
        session,
        ...journalCommandTimeout(budget.deadline, session),
        collation: { locale: 'simple' },
      },
    );
    if (selected === null) {
      await control.updateOne(
        { _id: 'writer' },
        { $unset: { retentionCursor: '' } },
        {
          session,
          ...journalCommandTimeout(budget.deadline, session),
          collation: { locale: 'simple' },
        },
      );
      return false;
    }
    let id: string;
    try {
      chargeJournal(selected, ledger);
      ledger.nodes++;
      const visibility = await readJournalVisibility(collections, selected, ledger, session);
      chargeJournal(visibility, ledger);
      id = visibility.address.id;
    } catch (error) {
      if (
        !(error instanceof KernelError) ||
        error.code !== 'BUDGET' ||
        count === 0 ||
        Date.now() >= budget.deadline
      )
        throw error;
      return true;
    }
    await hooks?.retiredEntry(position, id, session);
    const command = {
      session,
      ...journalCommandTimeout(budget.deadline, session),
      collation: { locale: 'simple' },
    };
    await collections.chunks.deleteMany(selected.visibility.identity, command);
    if (selected.entry !== undefined)
      await collections.chunks.deleteMany(selected.entry.identity, command);
    await collections.entries.deleteOne({ _id: selected._id }, command);
  }
  return true;
}
