import { MongoError, MongoOperationTimeoutError, type ClientSession, type MongoClient } from 'mongodb';
import { KernelError } from '@treenx/core/errors';
import { readJournalImages } from '@treenx/core/kernel/journal';
import type { JournalCommit, Position, StoredWrite } from '@treenx/core/kernel/types';
import { JOURNAL_HEADER_FIELDS, readInlineHead, writeJournalRecord, type JournalCollections } from '#journal-records';
import { journalRemaining, type JournalReadLedger } from '#journal-units';

interface UpgradeImage { readonly bytes: number; readonly canonical: JournalCommit | null; readonly _id: string }
interface UpgradeSelection extends Omit<UpgradeImage, '_id'> { readonly _id: string | null; readonly identityBytes: number }
type UpgradeFence = (session: ClientSession, deadline: number) => Promise<void>;

async function upgradeRecord(collections: JournalCollections, session: ClientSession,
  fence: UpgradeFence, deadline: number, ledger: JournalReadLedger): Promise<boolean> {
  await fence(session, deadline);
  const loaded = new Map<string, UpgradeImage>();
  const load = async (filter: object): Promise<UpgradeImage | null> => {
    const identity = { _id: '$_id' };
    const image = await collections.roots.findOne<UpgradeSelection>(filter, { session, timeoutMS: journalRemaining(deadline),
      sort: { 'pos.epoch': -1, 'pos.seq': -1 }, collation: { locale: 'simple' },
      projection: { _id: { $cond: [{ $lte: [{ $bsonSize: identity }, ledger.physicalLimit - ledger.physicalBytes] }, '$_id', null] },
        identityBytes: { $bsonSize: identity }, bytes: { $bsonSize: '$$ROOT' }, canonical: { $cond: [
              { $and: [{ $lte: [{ $bsonSize: '$$ROOT' }, ledger.physicalLimit - ledger.physicalBytes] },
          { $not: [{ $in: ['$_id', [...loaded.keys()]] }] }] },
        Object.fromEntries([...JOURNAL_HEADER_FIELDS, 'entries'].map(name => [name, `$${name}`])), null,
      ] } } });
    if (image !== null) {
      if (image._id === null) throw new KernelError('BUDGET', 'Mongo legacy journal identity allowance exceeded');
      const prior = loaded.get(image._id);
      if (prior !== undefined) {
        ledger.physicalBytes += image.identityBytes;
        return prior;
      }
      if (image.canonical === null) throw new KernelError('BUDGET', 'Mongo legacy journal reconstruction allowance exceeded');
      ledger.physicalBytes += image.bytes;
      const selected = { ...image, _id: image._id };
      loaded.set(image._id, selected);
      return selected;
    }
    return null;
  };
  const first = await readInlineHead(collections, { _position: { $exists: false } }, ledger,
    { 'pos.epoch': 1, 'pos.seq': 1 }, session);
  if (first === null) return false;
  const image = await load({ _id: first._id });
  if (image === null || image.canonical === null) throw new KernelError('INVALID', 'Mongo legacy journal disappeared during upgrade');
  const record = image.canonical;
  const writes: StoredWrite[] = [];
  for (const entry of record.entries) {
    if (entry.change.t !== 'update' || entry.change.after !== undefined) continue;
    const history: JournalCommit[] = [record];
    let before: Position = record.pos;
    for (;;) {
      const prior = await load({ 'entries.id': entry.id, $or: [
        { 'pos.epoch': { $lt: before.epoch } }, { 'pos.epoch': before.epoch, 'pos.seq': { $lt: before.seq } },
      ] });
      if (prior === null || prior.canonical === null) throw new KernelError('INVALID', 'Mongo legacy compact journal has no anchor');
      history.unshift(prior.canonical);
      const change = prior.canonical.entries.find(candidate => candidate.id === entry.id);
      if (change === undefined) throw new KernelError('INVALID', 'Mongo legacy anchor has no matching entry');
      if (change.change.t !== 'update' || change.change.after !== undefined) break;
      before = prior.canonical.pos;
    }
    const images = readJournalImages(history, { pos: record.pos, id: entry.id });
    if (images.after === null) throw new KernelError('INVALID', 'Mongo legacy update has no resulting image');
    writes.push({ path: entry.path, node: images.after });
  }
  await writeJournalRecord(collections, record, writes, session, image._id, deadline, ledger);
  await fence(session, deadline);
  return true;
}

/** The work and cleanup phases share one per-record host allowance; dataset initialization is separate. */
export async function upgradeJournal(collections: JournalCollections, client: MongoClient,
  fence: UpgradeFence, allowance: number): Promise<void> {
  for (;;) {
    const totalDeadline = Date.now() + allowance;
    const deadline = totalDeadline - Math.min(1000, Math.floor(allowance / 5));
    const ledger: JournalReadLedger = { budget: { nodes: Number.MAX_SAFE_INTEGER, bytes: Number.MAX_SAFE_INTEGER,
      exprWork: Number.MAX_SAFE_INTEGER, deadline }, physicalLimit: collections.physicalLimit, physicalBytes: 0, logicalBytes: 0 };
    const pending = await readInlineHead(collections, { _position: { $exists: false } }, ledger);
    if (pending === null) return;
    for (;;) {
      journalRemaining(deadline);
      const session = client.startSession();
      try {
        session.startTransaction({ readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
        try {
          const found = await upgradeRecord(collections, session, fence, deadline, ledger);
          for (;;) {
            try { await session.commitTransaction({ timeoutMS: journalRemaining(deadline) }); break; }
            catch (error) {
              if (!(error instanceof MongoError) || !error.hasErrorLabel('UnknownTransactionCommitResult')) throw error;
              journalRemaining(deadline);
            }
          }
          if (!found) return;
          break;
        } catch (error) {
          if (!session.hasEnded) {
            try { await session.endSession({ timeoutMS: Math.max(1, totalDeadline - Date.now()) }); }
            catch (cleanup) {
              const cause = new AggregateError([error, cleanup], 'Mongo journal upgrade and cleanup failed');
              if (!(cleanup instanceof MongoOperationTimeoutError)) throw cause;
              const failure = new KernelError('BUDGET', 'Mongo journal upgrade cleanup allowance exceeded');
              failure.cause = cause;
              throw failure;
            }
          }
          if (!(error instanceof MongoError) || !error.hasErrorLabel('TransientTransactionError')) throw error;
          journalRemaining(deadline);
        }
      } finally {
        if (!session.hasEnded) await session.endSession({ timeoutMS: Math.max(1, totalDeadline - Date.now()) });
      }
    }
  }
}
