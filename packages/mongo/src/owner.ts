import {
  createMongoBlobCarrier,
  writeBlobHolds,
  adoptNodeBlobHolds,
  adoptJournalBlobHolds,
  blobRetentionHooks,
  readBlobDocument,
  chargeBlobMetadata,
  type HoldDocument,
  type HoldCoverage,
  type MongoBlobCollections,
} from '#blob-holds';
import {
  writeBlobArchives,
  mongoArchiveCensus,
  readArchivedBlobHolds,
  type ArchiveOwnerDocument,
  type ArchivePageDocument,
  type MongoArchiveCollections,
} from '#blob-archives';
import { retentionAge } from '#retention-plan';
import {
  adoptRetention,
  promoteExpiredEntries,
  retireExpiredEntries,
  stripExpiredRoot,
  type RetentionControl,
} from '#journal-retention';
import { comparePositions } from '@treenx/core/kernel/position';
import { transferImageDigest } from '@treenx/core/kernel/transfer-image';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { KernelError } from '@treenx/core/errors';
import { assertStoreCommit } from '@treenx/core/kernel/store/commit';
import {
  DEFAULT_LIMITS,
  type Budget,
  type InstanceId,
  type MountStoreResources,
  type Position,
  type Store,
  type StoreCommitGroup,
  type StoreTransactionOwner,
} from '@treenx/core/kernel/types';
import { stableJson } from '@treenx/core/util/stable-json';
import { getSharedClient } from '#index';
import { claimNamespace, readNamespace } from '#namespace';
import {
  DEFAULT_JOURNAL_READ_BSON_BYTES,
  journalRemaining,
  journalCommandTimeout,
  type JournalChunk,
} from '#journal-units';
import { upgradeJournal } from '#journal-upgrade';
import {
  readInlineHead,
  readJournalPosition,
  writeJournalRecord,
  FRAGMENT_HEAD_PROJECTION,
  type FragmentJournalRoot,
  type InlineJournalRoot,
  type JournalCollections,
  type JournalEntryIndex,
} from '#journal-records';
import {
  databaseError,
  decode,
  encode,
  localPath,
  openMongoHandle,
  type JournalDocument,
  type MongoHandleOptions,
  type MongoStore,
  type MongoStoreOptions,
  type StoredDocument,
} from '#store';
import type { Collection } from 'mongodb';
import {
  createOwnedTransactions,
  transactionKey,
  type OwnedTransaction,
} from '#owner-transactions';
import {
  documentKeyProjection,
  insertedDocumentKey,
  locatorKey,
  readDocumentKey,
  writeLocators,
  readLocator,
  type LocatorCollections,
  type LocatorHead,
  type PhysicalLocator,
} from '#store-locator';
import { createWatchState, type TransactionMarker } from '#watch-state';
import type { BackfillDocument } from '#backfill';
import { journalIdentity } from '#journal-records';

export interface MongoOwnerOptions {
  readonly uri: string;
  readonly domain: StoreTransactionOwner['domain'];
  readonly instance: InstanceId;
  readonly journalDb: string;
  readonly journalCollection: string;
  readonly journalReadBsonBytes?: number;
  readonly journalUpgradeMs?: number;
}

export interface MongoTransactionOwner extends StoreTransactionOwner {
  readonly resources: MountStoreResources;
  openCollection(options: MongoHandleOptions): Promise<MongoStore>;
  ownsTransaction(transaction: OwnedTransaction, budget: Budget): Promise<boolean>;
  close(): Promise<void>;
}

export interface MongoOwnerControl extends RetentionControl {
  readonly _id: string;
  readonly writerEpoch: number;
  readonly instance?: InstanceId;
  readonly domain?: StoreTransactionOwner['domain'];
  readonly epoch?: string;
  readonly latest?: Position;
  readonly verifiedJournal?: boolean;
  readonly owner?: string;
  readonly journalIndexRevision?: number;
  readonly acceptedClock?: number;
  readonly retentionBefore?: number;
  readonly maintenancePending?: boolean;
}
interface Registration {
  readonly nodes: Collection<StoredDocument & { readonly _id: unknown }>;
  readonly backfill: Collection<BackfillDocument>;
  readonly blobCarrier: string;
  readonly coverage: { value: HoldCoverage };
  readonly options: MongoHandleOptions;
}
type OpenOptions = Omit<MongoOwnerOptions, 'instance'> & {
  readonly instance?: InstanceId;
  readonly acquire: boolean;
  readonly controlCollection?: string;
  beforeRecord?(): void | Promise<void>;
};

/** One durable fencing capability controls all of its registered collection handles. */
async function openOwner(options: OpenOptions): Promise<MongoTransactionOwner> {
  const pool = getSharedClient(options.uri, true);
  const transactions = createOwnedTransactions(pool.client);
  const registrations = new Map<Store, Registration>();
  const bindings = new Map<string, { readonly base: string; count: number }>();
  let retiring = false,
    released = false,
    active = 0;
  let closing: Promise<void> | undefined;
  let observation = Promise.resolve();
  const committing = new Set<Promise<void>>();
  const release = async () => {
    if (closing !== undefined) return closing;
    if (retiring && registrations.size === 0 && active === 0 && !released) {
      released = true;
      transactions.close();
      closing = pool.release();
      await closing;
    }
  };
  try {
    const client = await pool.ready;
    const db = client.db(options.journalDb);
    const journal = db.collection<InlineJournalRoot>(options.journalCollection);
    const controlName = options.controlCollection ?? `${options.journalCollection}.__control`;
    const coordinator = stableJson([options.journalDb, options.journalCollection, controlName]);
    const priorClaim = await readNamespace(db, controlName);
    if (
      priorClaim !== null &&
      (priorClaim.role !== 'control' || priorClaim.coordinator !== coordinator)
    )
      throw new KernelError(
        'CONFLICT',
        'Mongo control collection belongs to a different native namespace',
      );
    const ownerId = priorClaim === null ? randomUUID() : priorClaim.owner;
    await claimNamespace(db, {
      collection: controlName,
      role: 'control',
      owner: ownerId,
      coordinator,
    });
    await claimNamespace(db, {
      collection: options.journalCollection,
      role: 'journal',
      owner: ownerId,
      coordinator,
    });
    const headerName = `${options.journalCollection}.__headers`;
    const chunkName = `${options.journalCollection}.__fragments`;
    const entryName = `${options.journalCollection}.__entries`;
    const locatorName = `${options.journalCollection}.__locators`;
    const locatorChunkName = `${options.journalCollection}.__locator_fragments`;
    const transactionName = `${options.journalCollection}.__transactions`;
    for (const [collection, role] of [
      [headerName, 'headers'],
      [chunkName, 'fragments'],
      [entryName, 'entries'],
    ] as const)
      await claimNamespace(db, { collection, role, owner: ownerId, coordinator });
    for (const [collection, role] of [
      [locatorName, 'locators'],
      [locatorChunkName, 'locator-fragments'],
    ] as const)
      await claimNamespace(db, { collection, role, owner: ownerId, coordinator });
    await claimNamespace(db, {
      collection: transactionName,
      role: 'transactions',
      owner: ownerId,
      coordinator,
    });
    const markers = db.collection<TransactionMarker>(transactionName);
    const locators: LocatorCollections = {
      owner: ownerId,
      heads: db.collection<LocatorHead>(locatorName),
      chunks: db.collection<JournalChunk>(locatorChunkName),
    };
    const physicalLimit = options.journalReadBsonBytes ?? DEFAULT_JOURNAL_READ_BSON_BYTES;
    if (!Number.isSafeInteger(physicalLimit) || physicalLimit < 1)
      throw new KernelError(
        'INVALID',
        'Mongo journal BSON allowance must be a positive safe integer',
      );
    const journals: JournalCollections = {
      owner: ownerId,
      roots: journal,
      headers: db.collection<FragmentJournalRoot>(headerName),
      chunks: db.collection<JournalChunk>(chunkName),
      entries: db.collection<JournalEntryIndex>(entryName),
      physicalLimit,
    };
    await journals.headers.createIndex(
      { _epoch: 1, _seq: 1 },
      { unique: true, collation: { locale: 'simple' } },
    );
    for (const collection of [journals.roots, journals.headers])
      await collection.createIndex(
        { '_transaction.session': 1, '_transaction.number': 1 },
        { collation: { locale: 'simple' } },
      );
    await journals.entries.createIndex(
      { owner: 1, epoch: 1, seq: 1, ordinal: 1 },
      { unique: true, collation: { locale: 'simple' } },
    );
    await journals.entries.createIndex(
      { owner: 1, idIdentity: 1, epoch: -1, seq: -1, ordinal: -1 },
      { collation: { locale: 'simple' } },
    );
    const control = db.collection<MongoOwnerControl>(controlName);
    await journal.createIndex(
      { 'pos.instance': 1, 'pos.epoch': 1, 'pos.seq': 1 },
      { unique: true, collation: { locale: 'simple' } },
    );
    await control.updateOne(
      { _id: 'writer' },
      {
        $setOnInsert: {
          writerEpoch: 0,
          epoch: randomUUID(),
          verifiedJournal: true,
          owner: ownerId,
          domain: options.domain,
          ...(options.instance === undefined ? {} : { instance: options.instance }),
        },
      },
      { upsert: true, collation: { locale: 'simple' } },
    );
    let persisted = await control.findOne({ _id: 'writer' }, { collation: { locale: 'simple' } });
    if (persisted === null) throw new KernelError('INVALID', 'Mongo owner control is absent');
    if (persisted.owner !== undefined && persisted.owner !== ownerId)
      throw new KernelError('INVALID', 'Mongo owner control differs from its physical namespace');
    if (persisted.epoch === undefined) {
      await control.updateOne(
        { _id: 'writer', epoch: { $exists: false } },
        { $set: { epoch: randomUUID() } },
        { collation: { locale: 'simple' } },
      );
      persisted = await control.findOne({ _id: 'writer' }, { collation: { locale: 'simple' } });
      if (persisted === null) throw new KernelError('INVALID', 'Mongo owner control disappeared');
    }
    const startupLedger = {
      budget: {
        nodes: 1,
        bytes: Number.MAX_SAFE_INTEGER,
        exprWork: Number.MAX_SAFE_INTEGER,
        deadline: Date.now() + 5000,
      },
      physicalLimit,
      physicalBytes: 0,
      logicalBytes: 0,
    };
    const inlineLatest = await readInlineHead(journals, {}, startupLedger, {
      'pos.instance': -1,
      'pos.epoch': -1,
      'pos.seq': -1,
    });
    const fragmentLatest = await journals.headers.findOne(
      {},
      {
        projection: FRAGMENT_HEAD_PROJECTION,
        sort: { _epoch: -1, _seq: -1 },
        collation: { locale: 'simple' },
      },
    );
    const fragmentPos =
      fragmentLatest === null
        ? undefined
        : await readJournalPosition(journals, fragmentLatest, startupLedger);
    const latest =
      fragmentPos !== undefined &&
      (inlineLatest === null ||
        fragmentPos.epoch > inlineLatest.pos.epoch ||
        (fragmentPos.epoch === inlineLatest.pos.epoch && fragmentPos.seq > inlineLatest.pos.seq))
        ? { pos: fragmentPos }
        : inlineLatest;
    if (persisted.instance === undefined && latest !== null) {
      await control.updateOne(
        { _id: 'writer', instance: { $exists: false } },
        { $set: { instance: latest.pos.instance } },
        { collation: { locale: 'simple' } },
      );
      persisted = await control.findOne({ _id: 'writer' }, { collation: { locale: 'simple' } });
      if (persisted === null) throw new KernelError('INVALID', 'Mongo owner control disappeared');
    }
    if (persisted.domain !== undefined && persisted.domain !== options.domain)
      throw new KernelError('INVALID', 'Mongo owner domain differs from its durable identity');
    if (
      options.instance !== undefined &&
      persisted.instance !== undefined &&
      persisted.instance !== options.instance
    )
      throw new KernelError('INVALID', 'Mongo owner instance differs from its durable identity');
    const confirmed =
      persisted.verifiedJournal === true &&
      (latest === null
        ? persisted.latest === undefined
        : isDeepStrictEqual(latest.pos, persisted.latest));
    if (options.acquire) {
      persisted = await control.findOneAndUpdate(
        { _id: 'writer', writerEpoch: persisted.writerEpoch },
        {
          $inc: { writerEpoch: 1 },
          $set: {
            instance: options.instance,
            domain: options.domain,
            ...(confirmed ? {} : { epoch: randomUUID(), verifiedJournal: false }),
          },
        },
        { returnDocument: 'after', collation: { locale: 'simple' } },
      );
      if (persisted === null)
        throw new KernelError('CONFLICT', 'Mongo owner changed during writer acquisition');
    }
    const writerEpoch = persisted.writerEpoch;
    const upgradeMs = options.journalUpgradeMs ?? 5000;
    if (!Number.isSafeInteger(upgradeMs) || upgradeMs < 2)
      throw new KernelError(
        'INVALID',
        'Mongo journal upgrade allowance must be a safe integer of at least two milliseconds',
      );
    await upgradeJournal(
      journals,
      client,
      async (session, deadline) => {
        const guarded = await control.updateOne(
          { _id: 'writer', writerEpoch },
          { $set: { owner: ownerId }, $inc: { journalIndexRevision: 1 } },
          { session, timeoutMS: journalRemaining(deadline), collation: { locale: 'simple' } },
        );
        if (guarded.matchedCount !== 1)
          throw new KernelError('CONFLICT', 'Mongo writer changed during journal upgrade');
      },
      upgradeMs,
    );
    const holdsName = `${options.journalCollection}.__blob_holds`;
    const coverageName = `${options.journalCollection}.__blob_coverage`;
    const archiveName = `${options.journalCollection}.__blob_archives`;
    const archiveOwnerName = `${options.journalCollection}.__blob_archive_owners`;
    for (const [collection, role] of [
      [holdsName, 'blob-holds'],
      [coverageName, 'blob-coverage'],
      [archiveName, 'blob-archives'],
      [archiveOwnerName, 'blob-archive-owners'],
    ] as const)
      await claimNamespace(db, { collection, role, owner: ownerId, coordinator });
    const blobCollections: MongoBlobCollections = {
      holds: db.collection<HoldDocument>(holdsName),
      coverage: db.collection<HoldCoverage>(coverageName),
    };
    const blobArchives: MongoArchiveCollections = {
      owners: db.collection<ArchiveOwnerDocument>(archiveOwnerName),
      pages: db.collection<ArchivePageDocument>(archiveName),
    };
    await blobCollections.holds.createIndex({ carrier: 1, ids: 1, _id: 1 });
    await blobArchives.pages.createIndex({ ids: 1, _id: 1 });
    await blobArchives.owners.createIndex({ sealed: 1 });
    await blobArchives.owners.createIndex({ switched: 1 }, { sparse: true });
    const censusBudget = (): Budget => ({
      nodes: DEFAULT_LIMITS.readNodes,
      bytes: physicalLimit,
      exprWork: DEFAULT_LIMITS.exprWork,
      deadline: Date.now() + upgradeMs,
    });
    const coverageStates = new Map<string, { value: HoldCoverage }>();

    /** Absence is complete only when the actual physical carrier is empty. */
    async function coverage(carrier: string, populated: () => Promise<boolean>) {
      let state = coverageStates.get(carrier);
      if (state !== undefined) return state;
      const budget = censusBudget();
      const stored = await readBlobDocument(
        blobCollections.coverage,
        { _id: carrier },
        {
          budget,
          physicalLimit,
          physicalBytes: 0,
          logicalBytes: 0,
          nodes: 0,
        },
      );
      const value = stored ?? { _id: carrier, complete: !(await populated()) };
      if (stored === null)
        await blobCollections.coverage.insertOne(value, {
          timeoutMS: journalRemaining(budget.deadline),
        });
      state = { value };
      coverageStates.set(carrier, state);
      return state;
    }

    const journalCarrier = `${ownerId}:journal:${journalIdentity([options.journalDb, options.journalCollection])}`;
    const journalCoverage = await coverage(
      journalCarrier,
      async () =>
        (await journals.entries.findOne(
          {},
          {
            projection: { _id: 0, present: { $literal: true } },
            timeoutMS: journalRemaining(censusBudget().deadline),
          },
        )) !== null,
    );
    const epoch = persisted.epoch;
    if (epoch === undefined) throw new KernelError('INVALID', 'Mongo owner continuity is absent');
    let maintenancePending =
      persisted.maintenancePending ?? persisted.retentionCursor !== undefined;
    let retentionBefore = persisted.retentionBefore;
    let retentionClock = persisted.acceptedClock;
    let journalFloor = persisted.journalFloor;

    function available(): void {
      if (released) throw new KernelError('UNAVAILABLE', 'Mongo transaction owner is closed');
    }

    const sharedBlobJournal = createMongoBlobCarrier(
      blobCollections,
      journalCarrier,
      available,
      () => journalCoverage.value.complete,
      () => retentionClock,
      () => retentionBefore,
      censusBudget,
    );
    const archiveAccess = {
      blobArchiveCensus: (owner?: string) => mongoArchiveCensus(blobArchives, censusBudget, owner),
      archivedBlobHolds: (ids: readonly string[], clock: number, budget: Budget) =>
        readArchivedBlobHolds(blobArchives, ids, clock, budget),
    };

    const owner: MongoTransactionOwner = {
      domain: options.domain,
      resources: {
        epoch,
        writerEpoch,
        persistent: true,
        decisionHistory: !confirmed ? 'unconfirmed' : latest === null ? 'fresh' : 'retained',
      },
      async ownsTransaction(transaction, budget) {
        available();
        if (transactions.pending(transaction)) return true;
        const marker = await markers.findOne(
          { _id: transactionKey(transaction) },
          {
            projection: { _id: 1 },
            timeoutMS: journalRemaining(budget.deadline),
            collation: { locale: 'simple' },
          },
        );
        if (marker !== null) return true;
        const filter = {
          '_transaction.session': transaction.session,
          '_transaction.number': transaction.number,
          _owner: ownerId,
        };
        for (const collection of [journals.roots, journals.headers]) {
          const found = await collection.findOne(filter, {
            projection: { _id: 0, _owned: { $literal: true } },
            timeoutMS: journalRemaining(budget.deadline),
            collation: { locale: 'simple' },
          });
          if (found !== null) return true;
        }
        return false;
      },
      async openCollection(handleOptions) {
        available();
        if (retiring) throw new KernelError('UNAVAILABLE', 'Mongo transaction owner is retiring');
        const key = stableJson([handleOptions.db, handleOptions.collection]);
        const prior = bindings.get(key);
        if (prior !== undefined && prior.base !== handleOptions.logicalBase)
          throw new KernelError(
            'CONFLICT',
            'Mongo collection has a live incompatible logical base',
          );
        const binding = prior ?? { base: handleOptions.logicalBase, count: 0 };
        bindings.set(key, binding);
        binding.count++;
        let opened: MongoStore | undefined;
        const unbind = () => {
          binding.count--;
          if (binding.count === 0) bindings.delete(key);
        };
        active++;
        try {
          await claimNamespace(client.db(handleOptions.db), {
            collection: handleOptions.collection,
            role: 'data',
            owner: ownerId,
            coordinator,
          });
          const backfillName = `${handleOptions.collection}.__backfill`;
          await claimNamespace(client.db(handleOptions.db), {
            collection: backfillName,
            role: 'backfill',
            owner: ownerId,
            coordinator,
          });
          const backfill = client.db(handleOptions.db).collection<BackfillDocument>(backfillName);
          const nodes = client
            .db(handleOptions.db)
            .collection<StoredDocument & { readonly _id: unknown }>(handleOptions.collection);
          const blobCarrier = `${ownerId}:node:${locatorKey(handleOptions.db, handleOptions.collection, {})}`;
          const nodeCoverage = await coverage(
            blobCarrier,
            async () =>
              (await nodes.findOne(
                {},
                {
                  projection: { _id: 0, present: { $literal: true } },
                  timeoutMS: journalRemaining(censusBudget().deadline),
                },
              )) !== null,
          );
          const carrier = createMongoBlobCarrier(
            blobCollections,
            blobCarrier,
            available,
            () => nodeCoverage.value.complete,
            () => retentionClock,
            () => retentionBefore,
            censusBudget,
          );
          opened = await openMongoHandle(handleOptions, {
            client,
            owner,
            journal: journals,
            backfill,
            available,
            blobCarrier: carrier,
            blobJournal: sharedBlobJournal,
            blobArchives: archiveAccess,
            maintenancePending: () =>
              maintenancePending || !nodeCoverage.value.complete || !journalCoverage.value.complete,
            retentionBoundary: () => retentionBefore,
            retentionClock: () => retentionClock,
            journalFloor: () => journalFloor,
            watch: {
              client,
              database: handleOptions.db,
              collection: handleOptions.collection,
              logicalBase: handleOptions.logicalBase,
              epoch,
              physicalLimit,
              owns: (transaction, budget) => owner.ownsTransaction(transaction, budget),
              locator: (key, ledger) => readLocator(locators, key, ledger),
              /** Cover only durable seed markers before a fresh observation boundary, with native commits excluded. */
              async start(resuming) {
                const prior = observation,
                  pending = [...committing];
                let finish: () => void = () => {};
                observation = new Promise<void>((resolve) => {
                  finish = resolve;
                });
                try {
                  await Promise.all([prior, ...pending]);
                  const deadline = Date.now() + 5000;
                  const baseline = resuming
                    ? null
                    : await control.findOne<{ readonly latest?: Position | null }>(
                        { _id: 'writer' },
                        {
                          projection: {
                            _id: 0,
                            latest: {
                              $cond: [
                                { $lte: [{ $bsonSize: { latest: '$latest' } }, physicalLimit] },
                                '$latest',
                                null,
                              ],
                            },
                          },
                          timeoutMS: journalRemaining(deadline),
                          collation: { locale: 'simple' },
                        },
                      );
                  if (!resuming && baseline === null)
                    throw new KernelError('INVALID', 'Mongo observation writer is absent');
                  const latest = baseline?.latest;
                  if (latest === null)
                    throw new KernelError(
                      'BUDGET',
                      'Mongo observation baseline allowance exceeded',
                    );
                  return async (established) => {
                    try {
                      if (established && latest !== undefined) {
                        const field = `events.${locatorKey(handleOptions.db, handleOptions.collection, {})}`;
                        await markers.updateMany(
                          {
                            [field]: { $exists: true },
                            'position.instance': latest.instance,
                            $or: [
                              { 'position.epoch': { $lt: latest.epoch } },
                              {
                                'position.epoch': latest.epoch,
                                'position.seq': { $lte: latest.seq },
                              },
                            ],
                          },
                          { $unset: { [field]: '' } },
                          {
                            timeoutMS: journalRemaining(deadline),
                            collation: { locale: 'simple' },
                          },
                        );
                        await markers.deleteMany(
                          { events: {} },
                          { timeoutMS: journalRemaining(deadline) },
                        );
                      }
                    } finally {
                      finish();
                    }
                  };
                } catch (error) {
                  finish();
                  throw error;
                }
              },
              ...createWatchState(
                client,
                locators,
                markers,
                locatorKey(handleOptions.db, handleOptions.collection, {}),
                physicalLimit,
              ),
              pin() {
                available();
                active++;
                return async () => {
                  active--;
                  await release();
                };
              },
            },
            pin() {
              available();
              active++;
              return async () => {
                active--;
                await release();
              };
            },
            async close(store) {
              registrations.delete(store);
              unbind();
              await release();
            },
          });
          if (retiring)
            throw new KernelError(
              'UNAVAILABLE',
              'Mongo transaction owner retired during collection opening',
            );
          registrations.set(opened, {
            nodes: client
              .db(handleOptions.db)
              .collection<StoredDocument & { readonly _id: unknown }>(handleOptions.collection),
            backfill,
            blobCarrier,
            coverage: nodeCoverage,
            options: handleOptions,
          });
          return opened;
        } catch (error) {
          if (opened === undefined) unbind();
          else await opened.close();
          throw error;
        } finally {
          active--;
          await release();
        }
      },
      async close() {
        retiring = true;
        await release();
      },
      async commit(input, groups) {
        const admitted = observation;
        let finishCommit: () => void = () => {};
        const done = new Promise<void>((resolve) => {
          finishCommit = resolve;
        });
        committing.add(done);
        try {
          await admitted;
          available();
          assertStoreCommit(input);
          const commit = structuredClone(input);
          const remaining = new Map(commit.writes.map((write) => [write.path, write]));
          const destinations = new Map<string, Registration>();
          const seen = new Set<Store>();
          const staged: {
            readonly registration: Registration;
            readonly group: StoreCommitGroup;
          }[] = [];
          for (const group of groups) {
            const registration = registrations.get(group.store);
            if (registration === undefined || seen.has(group.store))
              throw new KernelError(
                'INVALID',
                'Mongo commit group is not a distinct registered handle',
              );
            seen.add(group.store);
            const writes = group.writes.map((write) => {
              const expected = remaining.get(write.path);
              if (expected === undefined || !isDeepStrictEqual(expected, write))
                throw new KernelError(
                  'INVALID',
                  'Mongo commit groups differ from the canonical writes',
                );
              localPath(registration.options.logicalBase, write.path);
              remaining.delete(write.path);
              destinations.set(write.path, registration);
              return expected;
            });
            staged.push({ registration, group: { store: group.store, writes } });
          }
          if (remaining.size !== 0 || groups.length === 0)
            throw new KernelError(
              'INVALID',
              'Mongo commit groups omit canonical writes or a decision target',
            );
          const movedSources = new Map<string, Registration>();
          for (const entry of commit.record.entries)
            if (entry.from !== undefined && entry.from !== entry.path) {
              const registration = destinations.get(entry.from);
              if (registration === undefined)
                throw new KernelError(
                  'INVALID',
                  'Mongo moved source is absent from the canonical write partition',
                );
              movedSources.set(entry.from, registration);
            }
          const session = client.startSession();
          const observed = transactions.register(session);
          if (commit.maintenanceLimits !== undefined)
            session.timeoutMS = journalRemaining(commit.maintenanceLimits.budget.deadline);
          let nextMaintenancePending = maintenancePending;
          let nextRetentionBefore = retentionBefore;
          let nextRetentionClock = retentionClock;
          let nextJournalFloor = journalFloor;
          const nextCoverage = new Map<{ value: HoldCoverage }, HoldCoverage>();
          active++;
          try {
            await session.withTransaction(
              async () => {
                nextCoverage.clear();
                const keys = { limit: physicalLimit, bytes: 0 };
                const acceptedLocators: PhysicalLocator[] = [];
                const originals =
                  commit.transferBefore === undefined
                    ? undefined
                    : new Map(commit.transferBefore.map((copy) => [copy.path, copy]));
                const absent =
                  commit.transferAbsent === undefined ? undefined : new Set(commit.transferAbsent);
                const events: Record<string, number> = {};

                /** Count actual data changes so markers outlive every affected collection checkpoint. */
                function changed(registration: Registration): void {
                  const binding = locatorKey(
                    registration.options.db,
                    registration.options.collection,
                    {},
                  );
                  events[binding] = (events[binding] ?? 0) + 1;
                }

                /** Validate complete transfer images inside the same owning transaction as their writes. */
                async function validateTransfer(
                  registration: Registration,
                  path: string,
                ): Promise<void> {
                  const original = originals?.get(path);
                  if (original !== undefined || absent?.has(path)) {
                    const current = await readBlobDocument(
                      registration.nodes,
                      { _path: localPath(registration.options.logicalBase, path) },
                      holdLedger,
                      session,
                    );
                    if (current !== null) {
                      if (original === undefined)
                        throw new KernelError(
                          'CONFLICT',
                          'Transfer destination appeared before copy',
                        );
                      for (const key in current)
                        if (Object.hasOwn(current, key)) {
                          holdLedger.referenceWork.exprWork++;
                          if (holdLedger.referenceWork.exprWork > holdLedger.budget.exprWork)
                            throw new KernelError(
                              'BUDGET',
                              'Transfer source validation exceeded its allowance',
                            );
                        }
                      const canonical = { ...decode(current), $path: path };
                      if (
                        canonical.$id !== original.sourceId ||
                        comparePositions(canonical.$pos, original.pos) !== 0 ||
                        transferImageDigest(
                          canonical,
                          holdLedger.budget,
                          holdLedger.referenceWork,
                        ) !== original.digest
                      )
                        throw new KernelError(
                          'CONFLICT',
                          'Transfer source original changed before cleanup',
                        );
                    }
                  }
                }

                /** Preserve the physical delete key until a stream checkpoint acknowledges its event. */
                async function remove(registration: Registration, path: string): Promise<void> {
                  if (originals !== undefined || absent !== undefined)
                    await validateTransfer(registration, path);
                  const original = originals?.get(path);
                  const image = await registration.nodes.findOneAndDelete(
                    {
                      _path: localPath(registration.options.logicalBase, path),
                      ...(original === undefined
                        ? {}
                        : { _tid: original.sourceId, _pos: original.pos }),
                    },
                    {
                      session,
                      projection: documentKeyProjection(keys),
                      promoteValues: false,
                      collation: { locale: 'simple' },
                    },
                  );
                  if (original !== undefined && image === null) {
                    chargeBlobMetadata({ present: true }, holdLedger);
                    const remaining = await registration.nodes.findOne(
                      { _path: localPath(registration.options.logicalBase, path) },
                      {
                        session,
                        projection: { _id: 0, present: { $literal: true } },
                        ...journalCommandTimeout(holdLedger.budget.deadline, session),
                        collation: { locale: 'simple' },
                      },
                    );
                    if (remaining !== null)
                      throw new KernelError(
                        'CONFLICT',
                        'Transfer source original changed before cleanup',
                      );
                  }
                  if (image !== null) {
                    readDocumentKey(image, keys);
                    changed(registration);
                  }
                }

                available();
                const current = await control.findOne(
                  { _id: 'writer' },
                  {
                    session,
                    ...(commit.maintenanceLimits === undefined
                      ? {}
                      : journalCommandTimeout(commit.maintenanceLimits.budget.deadline, session)),
                    collation: { locale: 'simple' },
                  },
                );
                if (current === null)
                  throw new KernelError('INVALID', 'Mongo writer fence is absent');
                if (current.instance !== undefined && current.instance !== commit.pos.instance)
                  throw new KernelError(
                    'INVALID',
                    'Mongo commit instance differs from its durable identity',
                  );
                if (current.domain !== undefined && current.domain !== options.domain)
                  throw new KernelError(
                    'INVALID',
                    'Mongo commit domain differs from its durable identity',
                  );
                if (
                  commit.writerEpoch < current.writerEpoch ||
                  (options.acquire &&
                    (commit.writerEpoch !== writerEpoch || current.writerEpoch !== writerEpoch))
                )
                  throw new KernelError('CONFLICT', 'Mongo writer epoch is stale');
                let retentionMs = commit.journalRetentionMs;
                for (const registration of registrations.values())
                  if (registration.options.journalRetentionMs !== undefined)
                    retentionMs = Math.max(
                      retentionMs ?? 0,
                      registration.options.journalRetentionMs,
                    );
                const age = retentionAge(
                  commit.acceptedAt ?? Date.now(),
                  current.acceptedClock ?? 0,
                  retentionMs ?? 0,
                );
                nextRetentionClock = age.acceptedAt;
                const retention = {
                  _acceptedAt: age.acceptedAt,
                  ...(retentionMs === undefined ? {} : { _retainUntil: age.retainUntil }),
                  ...(commit.record.decision === undefined
                    ? {}
                    : { _decisionTime: commit.record.decision.opId.time }),
                  ...(commit.record.anchorDecision === undefined
                    ? {}
                    : { _anchorTime: commit.record.anchorDecision.opId.time }),
                };

                const holdBudget = commit.maintenanceLimits?.budget ?? censusBudget();
                const holdLedger = {
                  budget: holdBudget,
                  referenceWork: { exprWork: 0 },
                  physicalLimit: Math.min(physicalLimit, holdBudget.bytes),
                  physicalBytes: 0,
                  logicalBytes: 0,
                  nodes: 0,
                };
                let adopting = false;
                if (commit.record.maintenance !== undefined) {
                  const selected = staged.find(
                    (item) => !item.registration.coverage.value.complete,
                  )?.registration;
                  const state = selected?.coverage ?? journalCoverage;
                  if (!state.value.complete) {
                    adopting = true;
                    const cursor =
                      selected === undefined
                        ? await adoptJournalBlobHolds(
                            blobCollections,
                            journals,
                            journalCarrier,
                            state.value.cursor,
                            holdLedger,
                            session,
                          )
                        : await adoptNodeBlobHolds(
                            blobCollections,
                            selected.nodes,
                            selected.blobCarrier,
                            state.value.cursor,
                            holdLedger,
                            session,
                          );
                    const value: HoldCoverage = {
                      _id: state.value._id,
                      complete: cursor === null,
                      ...(cursor === null ? {} : { cursor }),
                    };
                    chargeBlobMetadata(value, holdLedger);
                    await blobCollections.coverage.replaceOne({ _id: value._id }, value, {
                      session,
                      ...journalCommandTimeout(holdBudget.deadline, session),
                    });
                    nextCoverage.set(state, value);
                  }
                }

                if (commit.record.maintenance !== undefined && !adopting) {
                  const limits = commit.maintenanceLimits;
                  if (limits === undefined || commit.journalRetentionMs === undefined)
                    throw new KernelError(
                      'INVALID',
                      'Mongo maintenance execution policy is absent',
                    );
                  const ledger = holdLedger;
                  const holds = blobRetentionHooks(
                    blobCollections,
                    journals,
                    journalCarrier,
                    ledger,
                    age.acceptedAt,
                  );
                  nextMaintenancePending = await adoptRetention(
                    journals,
                    age.acceptedAt,
                    commit.journalRetentionMs,
                    ledger,
                    limits.changeSet,
                    session,
                  );
                  if (ledger.nodes === 0) {
                    const cursor = current.retentionCursor;
                    const filter =
                      cursor === undefined
                        ? { _retired: { $ne: true }, 'entries.0': { $exists: true } }
                        : { _position: cursor.position };
                    const inline = await readInlineHead(
                      journals,
                      filter,
                      ledger,
                      { _epoch: 1, _seq: 1 },
                      session,
                    );
                    const fragment = await journals.headers.findOne(
                      cursor === undefined
                        ? { _retired: { $ne: true }, entryCount: { $gt: 0 } }
                        : { _position: cursor.position },
                      {
                        projection: FRAGMENT_HEAD_PROJECTION,
                        sort: { _epoch: 1, _seq: 1 },
                        session,
                        ...journalCommandTimeout(limits.budget.deadline, session),
                        collation: { locale: 'simple' },
                      },
                    );
                    const root =
                      inline === null
                        ? fragment
                        : fragment === null ||
                            comparePositions(
                              inline.pos,
                              await readJournalPosition(journals, fragment, ledger, session),
                            ) <= 0
                          ? inline
                          : fragment;
                    if (
                      root !== null &&
                      (cursor !== undefined ||
                        (root._acceptedAt !== undefined &&
                          root._retainUntil !== undefined &&
                          root._acceptedAt < commit.record.maintenance.journalBefore &&
                          root._retainUntil <= age.acceptedAt))
                    ) {
                      if (cursor?.stripped === true) {
                        await retireExpiredEntries(
                          journals,
                          control,
                          root,
                          cursor,
                          ledger,
                          limits.changeSet,
                          session,
                          holds,
                        );
                        nextMaintenancePending = true;
                      } else {
                        nextMaintenancePending = await promoteExpiredEntries(
                          journals,
                          control,
                          current,
                          root,
                          ledger,
                          limits.changeSet,
                          session,
                          holds,
                        );
                        if (!nextMaintenancePending) {
                          const progress = await control.findOne(
                            { _id: 'writer' },
                            {
                              session,
                              ...journalCommandTimeout(limits.budget.deadline, session),
                              collation: { locale: 'simple' },
                            },
                          );
                          if (progress?.retentionCursor === undefined)
                            throw new KernelError(
                              'INVALID',
                              'Journal retention progress is absent',
                            );
                          await stripExpiredRoot(
                            journals,
                            control,
                            root,
                            progress.retentionCursor,
                            ledger,
                            session,
                          );
                          nextMaintenancePending = true;
                          nextJournalFloor = await readJournalPosition(
                            journals,
                            root,
                            ledger,
                            session,
                          );
                        }
                      }
                    }
                  }
                  nextRetentionBefore = Math.max(
                    current.retentionBefore ?? 0,
                    commit.record.maintenance.journalBefore,
                  );
                  await control.updateOne(
                    { _id: 'writer' },
                    {
                      $set: {
                        retentionBefore: nextRetentionBefore,
                        maintenancePending: nextMaintenancePending,
                        decisionFloor: Math.max(
                          current.decisionFloor ?? 0,
                          commit.record.maintenance.decisionBefore,
                        ),
                      },
                    },
                    {
                      session,
                      ...journalCommandTimeout(limits.budget.deadline, session),
                      collation: { locale: 'simple' },
                    },
                  );
                }

                await control.updateOne(
                  { _id: 'writer' },
                  {
                    $set: {
                      acceptedClock: age.acceptedAt,
                      writerEpoch: commit.writerEpoch,
                      instance: commit.pos.instance,
                      domain: options.domain,
                      latest: commit.pos,
                    },
                  },
                  { session, collation: { locale: 'simple' } },
                );
                // All source removals precede puts, including transfers between registered collections.
                for (const { registration, group } of staged)
                  for (const write of group.writes)
                    if (write.node === null && !movedSources.has(write.path))
                      await remove(registration, write.path);
                for (const [path, registration] of movedSources) await remove(registration, path);
                for (const { registration, group } of staged)
                  for (const write of group.writes)
                    if (write.node !== null) {
                      if (originals !== undefined || absent !== undefined)
                        await validateTransfer(registration, write.path);
                      const result = await registration.nodes.findOneAndReplace(
                        { _path: localPath(registration.options.logicalBase, write.path) },
                        encode({
                          ...write.node,
                          $path: localPath(registration.options.logicalBase, write.node.$path),
                        }),
                        {
                          session,
                          upsert: true,
                          returnDocument: 'before',
                          includeResultMetadata: true,
                          projection: documentKeyProjection(keys),
                          promoteValues: false,
                          collation: { locale: 'simple' },
                        },
                      );
                      const documentKey =
                        result.value === null
                          ? insertedDocumentKey(result.lastErrorObject?.upserted, keys)
                          : readDocumentKey(result.value, keys);
                      acceptedLocators.push({
                        key: locatorKey(
                          registration.options.db,
                          registration.options.collection,
                          documentKey,
                        ),
                        documentKey,
                        path: write.path,
                        id: write.node.$id,
                        type: write.node.$type,
                      });
                      changed(registration);
                    }
                await writeLocators(locators, acceptedLocators, session);
                if (Object.keys(events).length !== 0) {
                  const transaction = observed.current();
                  await markers.insertOne(
                    { _id: transactionKey(transaction), transaction, position: commit.pos, events },
                    { session },
                  );
                }
                const nodeCarriers = new Map<
                  string,
                  { readonly carrier: string; readonly key: string }
                >();
                for (const { registration, group } of staged)
                  for (const write of group.writes)
                    nodeCarriers.set(write.path, {
                      carrier: registration.blobCarrier,
                      key: localPath(registration.options.logicalBase, write.path),
                    });
                await writeBlobHolds(
                  blobCollections,
                  journalCarrier,
                  nodeCarriers,
                  commit,
                  age.acceptedAt,
                  retention._retainUntil,
                  holdLedger,
                  session,
                );
                if (commit.blobArchive !== undefined)
                  await writeBlobArchives(blobArchives, commit.blobArchive, holdLedger, session);
                await options.beforeRecord?.();
                if (commit.record.backfill !== undefined) {
                  if (
                    staged.length !== 1 ||
                    commit.record.kind !== 'kernel' ||
                    commit.record.executor !== 'kernel'
                  )
                    throw new KernelError(
                      'INVALID',
                      'Backfill progress requires one kernel Store transaction',
                    );
                  const limits = commit.maintenanceLimits;
                  if (limits === undefined)
                    throw new KernelError('INVALID', 'Backfill execution allowance is absent');
                  const registration = staged[0].registration;
                  await registration.backfill.replaceOne(
                    {
                      _id: journalIdentity({
                        type: commit.record.backfill.type,
                        base: registration.options.logicalBase,
                      }),
                    },
                    {
                      ...commit.record.backfill,
                    },
                    {
                      session,
                      upsert: true,
                      ...journalCommandTimeout(limits.budget.deadline, session),
                      collation: { locale: 'simple' },
                    },
                  );
                }
                available();
                for (const { group } of staged)
                  if (!registrations.has(group.store))
                    throw new KernelError(
                      'UNAVAILABLE',
                      'Mongo collection retired during its commit',
                    );
                await writeJournalRecord(
                  journals,
                  commit.record,
                  commit.writes,
                  session,
                  undefined,
                  commit.maintenanceLimits?.budget.deadline,
                  undefined,
                  observed.current(),
                  retention,
                );
              },
              {
                readConcern: { level: 'snapshot' },
                writeConcern: { w: 'majority' },
                ...(commit.maintenanceLimits === undefined
                  ? {}
                  : {
                      timeoutMS: journalRemaining(commit.maintenanceLimits.budget.deadline),
                    }),
              },
            );
            for (const [state, value] of nextCoverage) state.value = value;
            maintenancePending = nextMaintenancePending;
            retentionBefore = nextRetentionBefore;
            retentionClock = nextRetentionClock;
            journalFloor = nextJournalFloor;
          } catch (error) {
            databaseError(error);
          } finally {
            observed.close();
            await session.endSession();
            active--;
            await release();
          }
        } finally {
          committing.delete(done);
          finishCommit();
        }
      },
    };
    return owner;
  } catch (error) {
    retiring = true;
    await release();
    databaseError(error);
  }
}

/** Acquire one real cluster writer capability; collection names never imply shared ownership. */
export function openMongoTransactionOwner(
  options: MongoOwnerOptions,
): Promise<MongoTransactionOwner> {
  return openOwner({ ...options, acquire: true });
}

/** Preserve the standalone Store contract while sharing the same transactional implementation. */
export async function openStandaloneMongoStore(options: MongoStoreOptions): Promise<MongoStore> {
  const owner = await openOwner({
    uri: options.uri,
    domain: options.domain,
    journalDb: options.db,
    journalCollection: `${options.collection}.__journal`,
    controlCollection: `${options.collection}.__control`,
    acquire: false,
    beforeRecord: options.beforeRecord,
    journalReadBsonBytes: options.journalReadBsonBytes,
    journalUpgradeMs: options.journalUpgradeMs,
  });
  try {
    const store = await owner.openCollection({
      db: options.db,
      collection: options.collection,
      logicalBase: '/',
      indexes: options.indexes,
      journalRetentionMs: options.journalRetentionMs,
    });
    const close = store.close;
    store.close = async () => {
      await close();
      await owner.close();
    };
    return store;
  } catch (error) {
    await owner.close();
    throw error;
  }
}
