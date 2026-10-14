import { createHash, randomUUID } from 'node:crypto';
import {
  BSON,
  Binary,
  Int32,
  ObjectId,
  type ClientSession,
  type Collection,
  type Document,
} from 'mongodb';
import { KernelError } from '@treenx/core/errors';
import type { NodeId, Path } from '@treenx/core/kernel/types';
import {
  journalManifestProjection,
  journalRemaining,
  readJournalUnit,
  writeJournalUnit,
  type JournalChunk,
  type JournalReadLedger,
  type JournalUnit,
} from '#journal-units';

export interface PhysicalLocator {
  readonly key: string;
  readonly documentKey: Readonly<Record<string, unknown>>;
  readonly path: Path;
  readonly id: NodeId;
  readonly type: string;
}

export interface LocatorHead {
  readonly _id: string;
  readonly value: JournalUnit;
}

export interface LocatorCollections {
  readonly owner: string;
  readonly heads: Collection<LocatorHead>;
  readonly chunks: Collection<JournalChunk>;
}

export interface DocumentKeyLedger {
  readonly limit: number;
  bytes: number;
}

/** Bound actual find-and-modify identity replies before BSON client allocation. */
export function documentKeyProjection(ledger: DocumentKeyLedger): Document {
  const bytes = { $bsonSize: { _id: '$_id' } };
  return {
    _id: { $cond: [{ $lte: [bytes, ledger.limit - ledger.bytes] }, '$_id', null] },
    _keyBytes: bytes,
  };
}

/** Charge every returned key, including keys on deletes and repeated transaction writes. */
export function readDocumentKey(
  image: { readonly _id: unknown; readonly [field: string]: unknown },
  ledger: DocumentKeyLedger,
): Readonly<Record<string, unknown>> {
  const raw = image._keyBytes;
  const bytes = raw instanceof Int32 ? raw.value : raw;
  if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 5)
    throw new KernelError('INVALID', 'Malformed Mongo document-key size');
  if (bytes > ledger.limit - ledger.bytes)
    throw new KernelError('BUDGET', 'Mongo document-key allowance exceeded');
  ledger.bytes += bytes;
  return { _id: image._id };
}

/** An upsert without an authored Mongo identity uses the driver's actual generated ObjectId. */
export function insertedDocumentKey(
  identity: unknown,
  ledger: DocumentKeyLedger,
): Readonly<Record<string, unknown>> {
  if (!(identity instanceof ObjectId))
    throw new KernelError('INVALID', 'Mongo upsert lacks its generated document identity');
  const key = { _id: identity };
  const bytes = BSON.calculateObjectSize(key);
  if (bytes > ledger.limit - ledger.bytes)
    throw new KernelError('BUDGET', 'Mongo document-key allowance exceeded');
  ledger.bytes += bytes;
  return key;
}

/** Hash the actual BSON document key with its physical namespace, preserving ObjectId identity. */
export function locatorKey(
  database: string,
  collection: string,
  documentKey: Readonly<Record<string, unknown>>,
): string {
  return createHash('sha256')
    .update(BSON.serialize({ database, collection, documentKey }))
    .digest('hex');
}

/** Persist latest address metadata separately from retained canonical history. */
export async function writeLocators(
  collections: LocatorCollections,
  locators: readonly PhysicalLocator[],
  session: ClientSession,
): Promise<void> {
  if (locators.length === 0) return;

  const operations = [];
  for (const locator of locators) {
    const value = await writeJournalUnit(
      collections.chunks,
      { owner: collections.owner, position: randomUUID(), unit: locator.key },
      { locator: { ...locator, documentKey: new Binary(BSON.serialize(locator.documentKey)) } },
      session,
    );
    operations.push({
      replaceOne: {
        filter: { _id: locator.key },
        replacement: { _id: locator.key, value },
        upsert: true,
      },
    });
  }

  await collections.heads.bulkWrite(operations, { session, ordered: true });
}

/** Read one latest locator without depending on journal retention or node preimages. */
export async function readLocator(
  collections: LocatorCollections,
  key: string,
  ledger: JournalReadLedger,
): Promise<PhysicalLocator | null> {
  const indexed = await collections.heads.findOne(
    { _id: key },
    {
      projection: { _id: 0, ...journalManifestProjection('value') },
      timeoutMS: journalRemaining(ledger.budget.deadline),
      collation: { locale: 'simple' },
    },
  );
  if (indexed === null) return null;

  const unit = await readJournalUnit(
    collections.chunks,
    indexed.value,
    { owner: collections.owner, position: indexed.value.identity.position, unit: key },
    ledger,
    0,
  );
  const locator: unknown = unit.locator;
  if (
    typeof locator !== 'object' ||
    locator === null ||
    !('key' in locator) ||
    locator.key !== key ||
    !('path' in locator) ||
    typeof locator.path !== 'string' ||
    !locator.path.startsWith('/') ||
    !('id' in locator) ||
    typeof locator.id !== 'string' ||
    locator.id.length === 0 ||
    !('type' in locator) ||
    typeof locator.type !== 'string' ||
    locator.type.length === 0 ||
    !('documentKey' in locator) ||
    !(locator.documentKey instanceof Binary)
  )
    throw new KernelError('INVALID', 'Malformed Mongo accepted document locator');

  const documentKey = BSON.deserialize(locator.documentKey.value(), { promoteValues: false });
  return { key, path: locator.path, id: locator.id, type: locator.type, documentKey };
}
