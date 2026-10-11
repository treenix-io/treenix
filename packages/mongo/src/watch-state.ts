import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { KernelError } from '@treenx/core/errors';
import type { Budget, Position } from '@treenx/core/kernel/types';
import { BSON, Binary, type Collection, type Document, type MongoClient } from 'mongodb';
import { transactionKey, type OwnedTransaction } from '#owner-transactions';
import type { LocatorCollections } from '#store-locator';
import { journalManifestProjection, journalRemaining, readJournalUnit, writeJournalUnit } from '#journal-units';

export interface TransactionMarker {
  readonly _id: string;
  readonly transaction: OwnedTransaction;
  readonly position: Position;
  readonly events: Readonly<Record<string, number>>;
}

/** Checkpoints and transaction watermarks share one atomic metadata publication. */
export function createWatchState(client: MongoClient, collections: LocatorCollections,
  markers: Collection<TransactionMarker>, namespace: string, physicalLimit: number) {
  const key = `watch:${namespace}`;

  /** Load a generated resume token through the same bounded fragment boundary as locators. */
  async function checkpoint(budget: Budget): Promise<Document | undefined> {
    const head = await collections.heads.findOne({ _id: key }, {
      projection: { _id: 0, ...journalManifestProjection('value') }, timeoutMS: journalRemaining(budget.deadline),
      collation: { locale: 'simple' },
    });
    if (head === null) return undefined;
    const unit = await readJournalUnit(collections.chunks, head.value,
      { owner: collections.owner, position: head.value.identity.position, unit: key },
      { budget, physicalLimit, physicalBytes: 0, logicalBytes: 0 }, 0);
    const token: unknown = unit.token;
    if (!(token instanceof Binary))
      throw new KernelError('INVALID', 'Malformed Mongo stream checkpoint');
    return BSON.deserialize(token.value(), { promoteValues: false });
  }

  /** Advance only after accepted delivery; retire ownership only after all counted collection events. */
  async function acknowledge(token: Document, transaction?: OwnedTransaction): Promise<void> {
    const budget = { nodes: 1, bytes: Number.MAX_SAFE_INTEGER, exprWork: Number.MAX_SAFE_INTEGER,
      deadline: Date.now() + 5000 };
    if (isDeepStrictEqual(await checkpoint(budget), token)) return;
    const session = client.startSession();
    try {
      await session.withTransaction(async () => {
        if (transaction !== undefined) {
          const marker = await markers.findOne({ _id: transactionKey(transaction) }, { session,
            projection: { _id: 0, events: { $cond: [
              { $lte: [{ $bsonSize: { events: '$events' } }, physicalLimit] }, '$events', null,
            ] } }, collation: { locale: 'simple' } });
          if (marker === null || marker.events === null)
            throw new KernelError('INVALID', 'Mongo own event lacks its durable transaction watermark');
          const events: Record<string, number> = {};
          for (const [binding, count] of Object.entries(marker.events)) {
            if (!/^[a-f0-9]{64}$/.test(binding) || !Number.isSafeInteger(count) || count < 1)
              throw new KernelError('INVALID', 'Malformed Mongo transaction event watermark');
            events[binding] = count;
          }
          const count = events[namespace];
          if (count === undefined) throw new KernelError('INVALID', 'Mongo own event differs from its collection watermark');
          if (count === 1) delete events[namespace];
          else events[namespace] = count - 1;
          if (Object.keys(events).length === 0) await markers.deleteOne({ _id: transactionKey(transaction) }, { session });
          else await markers.updateOne({ _id: transactionKey(transaction) }, { $set: { events } }, { session });
        }
        const value = await writeJournalUnit(collections.chunks,
          { owner: collections.owner, position: randomUUID(), unit: key },
          { token: new Binary(BSON.serialize(token)) }, session);
        await collections.heads.replaceOne({ _id: key }, { value },
          { session, upsert: true, collation: { locale: 'simple' } });
      }, { timeoutMS: journalRemaining(budget.deadline), readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
    } finally { await session.endSession(); }
  }

  /** Discard an unusable observation checkpoint without changing canonical domain continuity. */
  async function forget(): Promise<void> {
    await collections.heads.deleteOne({ _id: key }, { timeoutMS: 5000 });
  }

  return { checkpoint, acknowledge, forget };
}
