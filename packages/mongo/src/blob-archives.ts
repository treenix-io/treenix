import type { ClientSession, Collection } from 'mongodb';
import { KernelError } from '@treenx/core/errors';
import { archivedBlobRow } from '@treenx/core/kernel/blob-archives';
import { comparePositions } from '@treenx/core/kernel/position';
import type {
  BlobArchiveMutation,
  BlobHoldResult,
  Budget,
  Position,
  TransferOwnership,
} from '@treenx/core/kernel/types';
import { journalIdentity } from '#journal-records';
import { journalCommandTimeout } from '#journal-units';
import { chargeBlobMetadata, readBlobDocument, type MongoBlobLedger } from '#blob-holds';
import type { MaintenanceLedger } from '#journal-retention';

type ArchivePage = Extract<BlobArchiveMutation, { t: 'page' | 'copyPage' }>;
export interface ArchiveOwnerDocument {
  readonly _id: string;
  readonly owner: string;
  readonly generation: Position;
  readonly pages: number;
  readonly sealed: boolean;
  readonly transfer?: TransferOwnership;
  readonly copies?: number;
  readonly switched?: Position;
}
export interface ArchivePageDocument {
  readonly _id: string;
  readonly owner: string;
  readonly page: ArchivePage;
  readonly ids: readonly string[];
}
export interface MongoArchiveCollections {
  readonly owners: Collection<ArchiveOwnerDocument>;
  readonly pages: Collection<ArchivePageDocument>;
}

/** Stage every mutation against sequential candidate state before the transaction publishes any archive unit. */
export async function writeBlobArchives(
  collections: MongoArchiveCollections,
  changes: readonly BlobArchiveMutation[],
  ledger: MongoBlobLedger,
  session: ClientSession,
): Promise<void> {
  const owners = new Map<string, ArchiveOwnerDocument | null>();
  const pages = new Map<string, ArchivePageDocument | null>();

  for (const change of changes) {
    const ownerKey = journalIdentity(change.owner);
    let owner = owners.get(ownerKey);
    if (owner === undefined) {
      owner = await readBlobDocument(collections.owners, { _id: ownerKey }, ledger, session);
      owners.set(ownerKey, owner);
    }
    if (owner !== null && comparePositions(owner.generation, change.generation) !== 0)
      throw new KernelError('CONFLICT', 'Mongo archived carrier generation differs');

    if (change.t === 'page')
      for (const row of change.rows) {
        ledger.referenceWork.exprWork += 1 + (row.t === 'released' ? 1 : row.ids.length);
        if (
          ledger.referenceWork.exprWork > ledger.budget.exprWork ||
          Date.now() > ledger.budget.deadline
        )
          throw new KernelError('BUDGET', 'Mongo archive reference work exceeded its allowance');
      }
    if (change.t === 'copyPage') {
      ledger.referenceWork.exprWork += change.copies.length;
      if (
        ledger.referenceWork.exprWork > ledger.budget.exprWork ||
        change.copies.length > ledger.budget.nodes
      )
        throw new KernelError('BUDGET', 'Mongo transfer copy allowance exceeded');
    }
    chargeBlobMetadata(change, ledger);
    const initial: ArchiveOwnerDocument = {
      _id: ownerKey,
      owner: change.owner,
      generation: change.generation,
      pages: 0,
      sealed: false,
    };

    switch (change.t) {
      case 'begin':
        if (owner !== null)
          throw new KernelError('CONFLICT', 'Mongo archived carrier already exists');
        if (change.transfer !== undefined && change.transfer.destination !== change.owner)
          throw new KernelError('INVALID', 'Mongo transfer destination differs from its carrier');
        owners.set(ownerKey, {
          ...initial,
          ...(change.transfer === undefined ? {} : { transfer: change.transfer, copies: 0 }),
        });
        break;

      case 'reopen':
        if (owner === null || !owner.sealed)
          throw new KernelError('CONFLICT', 'Mongo archived carrier is not sealed');
        owners.set(ownerKey, { ...owner, sealed: false });
        break;

      case 'copyPage': {
        if (
          owner?.transfer === undefined ||
          owner.switched !== undefined ||
          change.page !== owner.transfer.firstPage + (owner.copies ?? 0)
        )
          throw new KernelError('CONFLICT', 'Mongo transfer copy pages are not contiguous');
        const document: ArchivePageDocument = {
          _id: journalIdentity([change.owner, 'copy', change.page]),
          owner: change.owner,
          page: change,
          ids: [],
        };
        chargeBlobMetadata(document, ledger);
        pages.set(document._id, document);
        owners.set(ownerKey, { ...owner, copies: (owner.copies ?? 0) + 1 });
        break;
      }
      case 'restartTransfer': {
        const prior = owner?.transfer;
        if (
          prior === undefined ||
          owner?.switched !== undefined ||
          change.transfer.node !== prior.node ||
          change.transfer.component !== prior.component ||
          change.transfer.base !== prior.base ||
          change.transfer.pattern !== prior.pattern ||
          change.transfer.source !== prior.source ||
          change.transfer.destination !== prior.destination ||
          change.transfer.firstPage !== prior.firstPage
        )
          throw new KernelError('CONFLICT', 'Mongo transfer retry differs from its physical owner');
        owners.set(ownerKey, { ...owner!, sealed: false, transfer: change.transfer });
        break;
      }

      case 'retireCopyPage': {
        if (
          owner?.transfer === undefined ||
          change.page !== owner.transfer.firstPage ||
          owner.copies === 0
        )
          throw new KernelError('CONFLICT', 'Mongo transfer copy retirement is not contiguous');
        const key = journalIdentity([change.owner, 'copy', change.page]);
        const page = pages.has(key)
          ? pages.get(key)
          : await readBlobDocument(collections.pages, { _id: key }, ledger, session);
        if (page === null || page === undefined || page.page.t !== 'copyPage')
          throw new KernelError('INVALID', 'Mongo transfer copy page is absent');
        pages.set(key, null);
        owners.set(ownerKey, {
          ...owner,
          copies: (owner.copies ?? 0) - 1,
          transfer: { ...owner.transfer, firstPage: change.page + 1 },
        });
        break;
      }

      case 'switchTransfer':
        if (owner?.transfer === undefined || owner.switched !== undefined)
          throw new KernelError('CONFLICT', 'Mongo transfer switch has no pending owner');
        owners.set(ownerKey, { ...owner, switched: change.pos });
        break;

      case 'completeTransfer': {
        if (owner?.transfer === undefined || owner.copies !== 0)
          throw new KernelError('CONFLICT', 'Mongo transfer still owns source copies');
        const { transfer, copies, switched, ...completed } = owner;
        owners.set(ownerKey, owner.pages === 0 && owner.sealed ? null : completed);
        break;
      }

      case 'page': {
        if (
          !Number.isFinite(change.clock) ||
          (change.boundary !== undefined && !Number.isFinite(change.boundary))
        )
          throw new KernelError('INVALID', 'Mongo archive retention provenance is invalid');
        if (
          !Number.isSafeInteger(change.page) ||
          change.page < 0 ||
          change.rows.length > ledger.budget.nodes
        )
          throw new KernelError('BUDGET', 'Mongo archive page allowance exceeded');
        if (owner?.sealed || change.page !== (owner?.pages ?? 0))
          throw new KernelError('CONFLICT', 'Mongo archive pages are not contiguous');

        const ids = new Set<string>();
        for (const row of change.rows)
          for (const id of row.t === 'released' ? [row.id] : row.ids) ids.add(id);
        const document: ArchivePageDocument = {
          _id: journalIdentity([change.owner, change.page]),
          owner: change.owner,
          page: change,
          ids: [...ids],
        };
        chargeBlobMetadata(document, ledger);
        pages.set(document._id, document);
        owners.set(ownerKey, { ...(owner ?? initial), pages: change.page + 1 });
        break;
      }

      case 'retirePage':
      case 'removePage': {
        const key = journalIdentity([change.owner, change.page]);
        let page = pages.get(key);
        if (page === undefined)
          page = await readBlobDocument(collections.pages, { _id: key }, ledger, session);
        if (owner === null || page === null)
          throw new KernelError('CONFLICT', 'Mongo archived page is absent');

        if (change.t === 'retirePage') {
          if (
            page.page.t !== 'page' ||
            owner.sealed ||
            !Number.isFinite(change.at) ||
            change.at < page.page.clock
          )
            throw new KernelError('CONFLICT', 'Mongo archived release is not pending');
          const retired = { ...page, page: { ...page.page, retiredAt: change.at } };
          chargeBlobMetadata(retired, ledger);
          pages.set(key, retired);
        } else {
          if (change.page !== owner.pages - 1)
            throw new KernelError('CONFLICT', 'Mongo archived removal is not contiguous');
          pages.set(key, null);
          owners.set(ownerKey, { ...owner, pages: owner.pages - 1, sealed: false });
        }
        break;
      }

      case 'seal':
        if (
          !Number.isSafeInteger(change.pages) ||
          change.pages < 0 ||
          change.pages !== (owner?.pages ?? 0) ||
          owner?.sealed
        )
          throw new KernelError('CONFLICT', 'Mongo archive seal does not cover its pages');
        owners.set(ownerKey, { ...(owner ?? initial), sealed: true });
        break;

      case 'remove':
        if (owner === null || owner.pages !== 0)
          throw new KernelError('CONFLICT', 'Mongo archived carrier still has pages');
        owners.set(ownerKey, owner.transfer === undefined ? null : { ...owner, sealed: true });
        break;
    }
  }

  const command = { session, ...journalCommandTimeout(ledger.budget.deadline, session) };
  for (const [key, page] of pages) {
    if (page === null) await collections.pages.deleteOne({ _id: key }, command);
    else await collections.pages.replaceOne({ _id: key }, page, { ...command, upsert: true });
  }
  for (const [key, owner] of owners) {
    if (owner === null) await collections.owners.deleteOne({ _id: key }, command);
    else await collections.owners.replaceOne({ _id: key }, owner, { ...command, upsert: true });
  }
}

/** Stream exact physical owners and bounded pages without collecting an owner-sized archive. */
export async function* mongoArchiveCensus(
  collections: MongoArchiveCollections,
  budget: () => Budget,
  ownerKey?: string,
): AsyncIterable<BlobArchiveMutation> {
  let cursor: string | undefined;
  for (;;) {
    const limits = budget();
    const ledger: MaintenanceLedger = {
      budget: limits,
      physicalLimit: limits.bytes,
      physicalBytes: 0,
      logicalBytes: 0,
      nodes: 0,
    };
    const owner = await readBlobDocument(
      collections.owners,
      ownerKey === undefined
        ? { ...(cursor === undefined ? {} : { _id: { $gt: cursor } }) }
        : { _id: journalIdentity(ownerKey) },
      ledger,
    );
    if (owner === null) return;

    yield {
      t: 'begin',
      owner: owner.owner,
      generation: owner.generation,
      ...(owner.transfer === undefined ? {} : { transfer: owner.transfer }),
    };
    if (owner.transfer !== undefined)
      for (let index = 0; index < (owner.copies ?? 0); index++) {
        const current = budget();
        const page = await readBlobDocument(
          collections.pages,
          { _id: journalIdentity([owner.owner, 'copy', owner.transfer.firstPage + index]) },
          {
            budget: current,
            physicalLimit: current.bytes,
            physicalBytes: 0,
            logicalBytes: 0,
            nodes: 0,
          },
        );
        if (page === null || page.page.t !== 'copyPage')
          throw new KernelError('INVALID', 'Mongo transfer copy page is absent');
        yield page.page;
      }
    for (let index = 0; index < owner.pages; index++) {
      const current = budget();
      const page = await readBlobDocument(
        collections.pages,
        { _id: journalIdentity([owner.owner, index]) },
        {
          budget: current,
          physicalLimit: current.bytes,
          physicalBytes: 0,
          logicalBytes: 0,
          nodes: 0,
        },
      );
      if (page === null) throw new KernelError('INVALID', 'Mongo archived page is absent');
      yield page.page;
    }
    if (owner.sealed)
      yield { t: 'seal', owner: owner.owner, generation: owner.generation, pages: owner.pages };
    if (owner.switched !== undefined)
      yield {
        t: 'switchTransfer',
        owner: owner.owner,
        generation: owner.generation,
        pos: owner.switched,
      };
    if (ownerKey !== undefined) return;
    cursor = owner._id;
  }
}

/** Incomplete owner censuses deny GC; only indexed pages naming requested IDs are transferred. */
export async function readArchivedBlobHolds(
  collections: MongoArchiveCollections,
  ids: readonly string[],
  clock: number,
  budget: Budget,
): Promise<BlobHoldResult> {
  if (!Number.isFinite(clock)) throw new KernelError('INVALID', 'Mongo archive clock is invalid');
  if (ids.length > budget.nodes)
    throw new KernelError('BUDGET', 'Mongo archive identity allowance exceeded');
  const ledger: MaintenanceLedger = {
    budget,
    physicalLimit: budget.bytes,
    physicalBytes: 0,
    logicalBytes: 0,
    nodes: 0,
  };
  const pending = await readBlobDocument(
    collections.owners,
    { $or: [{ sealed: false }, { switched: { $exists: true } }] },
    ledger,
  );
  if (pending !== null)
    throw new KernelError('UNAVAILABLE', 'Mongo archived carrier census is incomplete');

  const items = new Map(ids.map((id) => [id, { id, live: 0, history: 0, releasedAt: 0 }]));
  let exprWork = 0;
  let cursor: string | undefined;
  for (;;) {
    const page = await readBlobDocument(
      collections.pages,
      { ids: { $in: ids }, ...(cursor === undefined ? {} : { _id: { $gt: cursor } }) },
      ledger,
    );
    if (page === null) break;

    cursor = page._id;
    if (page.page.t !== 'page')
      throw new KernelError('INVALID', 'Mongo blob identity index selected a transfer copy page');
    for (const row of page.page.rows) {
      exprWork++;
      if (exprWork > budget.exprWork || Date.now() > budget.deadline)
        throw new KernelError('BUDGET', 'Mongo archive reference work exceeded its allowance');
      for (const id of row.t === 'released' ? [row.id] : row.ids) {
        exprWork++;
        if (exprWork > budget.exprWork || Date.now() > budget.deadline)
          throw new KernelError('BUDGET', 'Mongo archive reference work exceeded its allowance');
        const item = items.get(id);
        if (item === undefined) continue;
        const hold = archivedBlobRow(row, page.page, clock);
        item.live += hold.live;
        item.history += hold.history;
        item.releasedAt = Math.max(item.releasedAt, hold.releasedAt);
      }
    }
  }

  return {
    items: [...items.values()],
    cost: {
      nodes: ledger.nodes,
      bytes: Math.max(ledger.physicalBytes, ledger.logicalBytes),
      exprWork,
    },
  };
}
