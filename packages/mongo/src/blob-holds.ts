import type { ClientSession, Collection, Document, Filter } from 'mongodb';
import { KernelError } from '@treenx/core/errors';
import { blobIds, type BlobReferenceWork } from '@treenx/core/kernel/blob-references';
import type {
  BlobCarrier,
  BlobHoldRow,
  Budget,
  JournalEntry,
  Position,
  StoreCommit,
} from '@treenx/core/kernel/types';
import {
  journalIdentity,
  readInlineHead,
  readJournalPosition,
  JOURNAL_ENTRY_PROJECTION,
  type JournalCollections,
} from '#journal-records';
import {
  journalCommandTimeout,
  journalNumberProjection,
  serializeJournalBson,
} from '#journal-units';
import { readAnchoredJournalEntry, type MaintenanceLedger } from '#journal-retention';
import { decode, type StoredDocument } from '#store';

export interface HoldDocument {
  readonly _id: string;
  readonly carrier: string;
  readonly ids: readonly string[];
  readonly row: BlobHoldRow;
}

export interface HoldCoverage {
  readonly _id: string;
  readonly complete: boolean;
  readonly cursor?: string;
}

export interface MongoBlobCollections {
  readonly holds: Collection<HoldDocument>;
  readonly coverage: Collection<HoldCoverage>;
}

export interface MongoBlobLedger extends MaintenanceLedger {
  readonly referenceWork: BlobReferenceWork;
}

interface SelectedBlobDocument<Value> {
  readonly bytes: number;
  readonly image: Value | null;
}

/** A transaction and all its hold reads share one physical and logical allowance. */
export function chargeBlobMetadata(value: Document, ledger: MaintenanceLedger): void {
  ledger.nodes++;
  ledger.physicalBytes += serializeJournalBson(value).length;
  ledger.logicalBytes += Buffer.byteLength(JSON.stringify(value));

  if (
    ledger.nodes > ledger.budget.nodes ||
    ledger.physicalBytes > ledger.physicalLimit ||
    ledger.logicalBytes > ledger.budget.bytes
  )
    throw new KernelError('BUDGET', 'Mongo blob hold allowance exceeded');

  journalCommandTimeout(ledger.budget.deadline);
}

/** Bound the complete selected metadata document before it crosses the driver boundary. */
export async function readBlobDocument<Value extends Document>(
  collection: Collection<Value>,
  filter: Filter<Value>,
  ledger: MaintenanceLedger,
  session?: ClientSession,
): Promise<Value | null> {
  const remaining = Math.min(
    ledger.physicalLimit - ledger.physicalBytes,
    ledger.budget.bytes - ledger.logicalBytes,
  );

  const selected = await collection.findOne<SelectedBlobDocument<Value>>(filter, {
    projection: {
      _id: 0,
      bytes: { $bsonSize: '$$ROOT' },
      image: {
        $cond: [
          {
            $and: [
              { $lte: [{ $bsonSize: '$$ROOT' }, remaining] },
              ledger.nodes < ledger.budget.nodes,
            ],
          },
          '$$ROOT',
          null,
        ],
      },
    },
    sort: { _id: 1 },
    session,
    ...journalCommandTimeout(ledger.budget.deadline, session),
    collation: { locale: 'simple' },
  });

  if (selected === null) return null;
  if (selected.image === null)
    throw new KernelError('BUDGET', 'Mongo blob hold document exceeds its allowance');

  chargeBlobMetadata(selected.image, ledger);
  return selected.image;
}

/** Sparse unit rows provide exact per-ID counts without a collection-sized in-memory census. */
export function createMongoBlobCarrier(
  collections: MongoBlobCollections,
  carrier: string,
  available: () => void,
  complete: () => boolean,
  clock: () => number | undefined,
  boundary: () => number | undefined,
  censusBudget: () => Budget,
): BlobCarrier {
  return {
    blobOwner: carrier,
    get journalRetentionClock() {
      return clock();
    },
    get journalRetentionBoundary() {
      return boundary();
    },

    async *blobCensus() {
      available();
      if (!complete())
        throw new KernelError('UNAVAILABLE', 'Mongo blob carrier adoption is incomplete');

      let cursor: string | undefined;
      for (;;) {
        const budget = censusBudget();
        const ledger: MaintenanceLedger = {
          budget,
          physicalLimit: budget.bytes,
          physicalBytes: 0,
          logicalBytes: 0,
          nodes: 0,
        };
        const selected = await readBlobDocument(
          collections.holds,
          { carrier, ...(cursor === undefined ? {} : { _id: { $gt: cursor } }) },
          ledger,
        );
        if (selected === null) return;

        cursor = selected._id;
        yield selected.row;
      }
    },

    async blobHolds(ids, budget) {
      available();
      if (!complete())
        throw new KernelError('UNAVAILABLE', 'Mongo blob carrier adoption is incomplete');

      const ledger: MaintenanceLedger = {
        budget,
        physicalLimit: budget.bytes,
        physicalBytes: 0,
        logicalBytes: 0,
        nodes: 0,
      };
      const counts = new Map(ids.map((id) => [id, { id, live: 0, history: 0, releasedAt: 0 }]));
      let cursor: string | undefined;

      for (;;) {
        const selected = await readBlobDocument(
          collections.holds,
          { carrier, ids: { $in: ids }, ...(cursor === undefined ? {} : { _id: { $gt: cursor } }) },
          ledger,
        );
        if (selected === null) break;

        cursor = selected._id;
        const row = selected.row;
        if (row.t === 'released') {
          const item = counts.get(row.id);
          if (item !== undefined) item.releasedAt = Math.max(item.releasedAt, row.at);
        } else
          for (const id of row.ids) {
            const item = counts.get(id);
            if (item !== undefined) item[row.t]++;
          }
      }

      return {
        items: [...counts.values()],
        cost: {
          nodes: ledger.nodes,
          bytes: Math.max(ledger.physicalBytes, ledger.logicalBytes),
          exprWork: 0,
        },
      };
    },
  };
}

/** Write only actual reference units and charge each metadata mutation before publication. */
export async function putBlobHold(
  collections: MongoBlobCollections,
  carrier: string,
  key: string,
  row: BlobHoldRow,
  ledger: MaintenanceLedger,
  session: ClientSession,
): Promise<void> {
  const document: HoldDocument = {
    _id: journalIdentity([carrier, key]),
    carrier,
    ids: row.t === 'released' ? [row.id] : row.ids,
    row,
  };
  chargeBlobMetadata(document, ledger);
  await collections.holds.replaceOne({ _id: document._id }, document, {
    upsert: true,
    session,
    ...journalCommandTimeout(ledger.budget.deadline, session),
    collation: { locale: 'simple' },
  });
}

/** Complete final writes and raw inverse fields contain unchanged, new, and removed identities. */
export async function writeBlobHolds(
  collections: MongoBlobCollections,
  journalCarrier: string,
  nodeCarriers: ReadonlyMap<string, { readonly carrier: string; readonly key: string }>,
  commit: StoreCommit,
  acceptedAt: number,
  retainUntil: number | undefined,
  ledger: MongoBlobLedger,
  session: ClientSession,
): Promise<void> {
  const after = new Map(
    commit.writes.map((write) => [
      write.path,
      write.node === null ? [] : blobIds(write.node, ledger.budget, ledger.referenceWork),
    ]),
  );
  const affected = new Map<string, Set<string>>();

  for (const entry of commit.record.entries) {
    const ids = new Set(blobIds(entry.change, ledger.budget, ledger.referenceWork));
    for (const id of after.get(entry.path) ?? []) ids.add(id);
    for (const path of entry.from === undefined ? [entry.path] : [entry.path, entry.from]) {
      const selected = affected.get(path) ?? new Set<string>();
      for (const id of ids) selected.add(id);
      affected.set(path, selected);
    }

    if (ids.size !== 0)
      await putBlobHold(
        collections,
        journalCarrier,
        journalIdentity([commit.pos, entry.id]),
        {
          t: 'history',
          address: { pos: commit.pos, id: entry.id },
          acceptedAt,
          ...(retainUntil === undefined ? {} : { retainUntil }),
          ids: [...ids],
        },
        ledger,
        session,
      );
  }

  for (const write of commit.writes) {
    const binding = nodeCarriers.get(write.path);
    if (binding === undefined)
      throw new KernelError('INVALID', 'Mongo blob write lacks its physical carrier');
    const { carrier, key } = binding;
    const ids = after.get(write.path)!;
    const relevant = affected.get(write.path) ?? new Set(ids);
    const unknown =
      !affected.has(write.path) ||
      commit.record.entries.some(
        (entry) =>
          entry.path === write.path &&
          entry.change.t === 'reconcile' &&
          entry.change.before === undefined,
      );

    if (unknown) {
      const previous = await readBlobDocument(
        collections.holds,
        { _id: journalIdentity([carrier, key]) },
        ledger,
        session,
      );
      if (previous !== null) for (const id of previous.ids) relevant.add(id);
    }

    if (relevant.size === 0) continue;
    if (ids.length !== 0)
      await putBlobHold(collections, carrier, key, { t: 'live', key, ids }, ledger, session);
    else {
      chargeBlobMetadata({ carrier, key }, ledger);
      await collections.holds.deleteOne(
        { _id: journalIdentity([carrier, key]) },
        {
          session,
          ...journalCommandTimeout(ledger.budget.deadline, session),
        },
      );
    }

    const retained = new Set(ids);
    for (const id of relevant)
      if (!retained.has(id))
        await putBlobHold(
          collections,
          carrier,
          `released:${id}`,
          { t: 'released', id, at: acceptedAt },
          ledger,
          session,
        );
  }
}

/** Promotion preserves full original ID sets and provenance; retirement releases that exact address. */
export function blobRetentionHooks(
  collections: MongoBlobCollections,
  journal: JournalCollections,
  carrier: string,
  ledger: MongoBlobLedger,
  acceptedAt: number,
) {
  return {
    async retainedEntry(position: Position, entry: JournalEntry, session: ClientSession) {
      const key = journalIdentity([position, entry.id]);
      const previous = await readBlobDocument(
        collections.holds,
        { _id: journalIdentity([carrier, key]) },
        ledger,
        session,
      );
      const ids = new Set(previous?.ids);
      for (const id of blobIds(entry.change, ledger.budget, ledger.referenceWork)) ids.add(id);

      if (ids.size === 0) return;
      const prior = previous?.row;
      if (prior !== undefined && prior.t !== 'history')
        throw new KernelError('INVALID', 'Mongo historical hold has a different unit kind');

      let provenance = prior;
      if (provenance === undefined) {
        const root = await readInlineHead(
          journal,
          { _position: journalIdentity(position) },
          ledger,
          undefined,
          session,
        );
        const metadata =
          root ??
          (await journal.headers.findOne<{
            readonly _acceptedAt?: number | null;
            readonly _retainUntil?: number | null;
          }>(
            {
              _position: journalIdentity(position),
            },
            {
              projection: {
                _id: 0,
                _acceptedAt: journalNumberProjection('_acceptedAt'),
                _retainUntil: journalNumberProjection('_retainUntil'),
              },
              session,
              ...journalCommandTimeout(ledger.budget.deadline, session),
            },
          ));
        if (metadata === null || metadata._acceptedAt === null || metadata._retainUntil === null)
          throw new KernelError('INVALID', 'Mongo promoted hold provenance is absent');
        chargeBlobMetadata(metadata, ledger);
        await putBlobHold(
          collections,
          carrier,
          key,
          {
            t: 'history',
            address: { pos: position, id: entry.id },
            acceptedAt: metadata._acceptedAt,
            retainUntil: metadata._retainUntil,
            ids: [...ids],
          },
          ledger,
          session,
        );
        return;
      }

      await putBlobHold(
        collections,
        carrier,
        key,
        {
          t: 'history',
          address: { pos: position, id: entry.id },
          acceptedAt: provenance.acceptedAt,
          retainUntil: provenance.retainUntil,
          ids: [...ids],
        },
        ledger,
        session,
      );
    },

    async retiredEntry(position: Position, id: string, session: ClientSession) {
      const key = journalIdentity([carrier, journalIdentity([position, id])]);
      const previous = await readBlobDocument(collections.holds, { _id: key }, ledger, session);
      if (previous === null) return;

      for (const blob of previous.ids)
        await putBlobHold(
          collections,
          carrier,
          `released:${blob}`,
          { t: 'released', id: blob, at: acceptedAt },
          ledger,
          session,
        );

      await collections.holds.deleteOne(
        { _id: key },
        { session, ...journalCommandTimeout(ledger.budget.deadline, session) },
      );
    },
  };
}

/** Cold history adoption uses the same indexed reconstruction as canonical retention. */
export async function adoptJournalBlobHolds(
  collections: MongoBlobCollections,
  journal: JournalCollections,
  carrier: string,
  cursor: string | undefined,
  ledger: MongoBlobLedger,
  session: ClientSession,
): Promise<string | null> {
  const selected = await journal.entries.findOne(
    { owner: journal.owner, ...(cursor === undefined ? {} : { _id: { $gt: cursor } }) },
    {
      projection: JOURNAL_ENTRY_PROJECTION,
      sort: { _id: 1 },
      session,
      ...journalCommandTimeout(ledger.budget.deadline, session),
      collation: { locale: 'simple' },
    },
  );
  if (selected === null) return null;

  const loaded = await readAnchoredJournalEntry(journal, selected, ledger, session);
  const ids = blobIds(loaded.value.change, ledger.budget, ledger.referenceWork);
  const position = await readJournalPosition(journal, loaded.root, ledger, session);
  if (ids.length !== 0)
    await putBlobHold(
      collections,
      carrier,
      journalIdentity([position, loaded.value.id]),
      {
        t: 'history',
        address: { pos: position, id: loaded.value.id },
        acceptedAt: loaded.root._acceptedAt,
        ...(loaded.root._retainUntil === undefined
          ? {}
          : { retainUntil: loaded.root._retainUntil }),
        ids,
      },
      ledger,
      session,
    );

  return selected._id;
}

/** Adopt one physical current image while excluding the unrelated legacy primary key. */
export async function adoptNodeBlobHolds(
  collections: MongoBlobCollections,
  nodes: Collection<StoredDocument & { readonly _id: unknown }>,
  carrier: string,
  cursor: string | undefined,
  ledger: MongoBlobLedger,
  session: ClientSession,
): Promise<string | null> {
  const body = { $unsetField: { field: '_id', input: '$$ROOT' } };
  const remaining = Math.min(
    ledger.physicalLimit - ledger.physicalBytes,
    ledger.budget.bytes - ledger.logicalBytes,
  );
  const selected = await nodes.findOne<{ readonly image: StoredDocument | null }>(
    {
      _path: cursor === undefined ? { $exists: true } : { $gt: cursor },
    },
    {
      projection: {
        _id: 0,
        image: {
          $cond: [
            {
              $and: [
                { $lte: [{ $bsonSize: body }, remaining] },
                ledger.nodes < ledger.budget.nodes,
              ],
            },
            body,
            null,
          ],
        },
      },
      sort: { _path: 1 },
      session,
      ...journalCommandTimeout(ledger.budget.deadline, session),
      collation: { locale: 'simple' },
    },
  );

  if (selected === null) return null;
  if (selected.image === null)
    throw new KernelError('BUDGET', 'Mongo blob adoption image exceeds its allowance');

  chargeBlobMetadata(selected.image, ledger);
  const ids = blobIds(decode(selected.image), ledger.budget, ledger.referenceWork);
  if (ids.length !== 0)
    await putBlobHold(
      collections,
      carrier,
      selected.image._path,
      { t: 'live', key: selected.image._path, ids },
      ledger,
      session,
    );

  return selected.image._path;
}
