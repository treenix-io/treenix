import { createHash } from 'node:crypto';
import { BSON, Binary, type ClientSession, type Collection, type Document } from 'mongodb';
import { KernelError } from '@treenx/core/errors';
import type { Budget } from '@treenx/core/kernel/types';
import { stableJson } from '@treenx/core/util/stable-json';

const CHUNK_BYTES = 1024 * 1024;
export const DEFAULT_JOURNAL_READ_BSON_BYTES = 64 * 1024 * 1024;

export function journalRemaining(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new KernelError('BUDGET', 'Mongo journal deadline exceeded');
  return Math.ceil(remaining);
}

/** Managed transactions inherit one lifetime allowance; other operations retain explicit deadlines. */
export function journalCommandTimeout(deadline: number, session?: ClientSession): { readonly timeoutMS?: number } {
  const remaining = journalRemaining(deadline);
  return session?.inTransaction() === true && session.timeoutMS !== undefined ? {} : { timeoutMS: remaining };
}

export interface JournalUnit {
  readonly key: string;
  readonly identity: JournalUnitIdentity;
  readonly bsonBytes: number;
  readonly logicalBytes: number;
  readonly chunks: number;
  readonly hash: string;
}

export interface JournalUnitIdentity {
  readonly owner: string;
  readonly position: string;
  readonly unit: string;
}

export interface JournalChunk {
  readonly _id: string;
  readonly owner: string;
  readonly position: string;
  readonly unit: string;
  readonly ordinal: number;
  readonly payload: Binary;
}

/** Physical reconstruction and canonical JSON charges use independent cumulative ledgers. */
export interface JournalReadLedger {
  readonly budget: Budget;
  readonly physicalLimit: number;
  physicalBytes: number;
  logicalBytes: number;
}

const decodedUnits = new WeakMap<JournalReadLedger, Map<string, { readonly value: Document; readonly bsonBytes: number }>>();

/** Project fixed physical identity strings without allocating corrupt oversized metadata values. */
export function journalStringProjection(field: string, limit = 96): Document {
  return { $cond: [{ $eq: [{ $type: `$${field}` }, 'string'] },
    { $cond: [{ $lte: [{ $strLenBytes: `$${field}` }, limit] }, `$${field}`, null] }, null] };
}

/** Bound numeric metadata at the server before the driver materializes a manifest. */
export function journalNumberProjection(field: string): Document {
  return { $cond: [{ $isNumber: `$${field}` }, { $cond: [{ $and: [
    { $gte: [`$${field}`, 0] }, { $lte: [`$${field}`, Number.MAX_SAFE_INTEGER] },
    { $eq: [`$${field}`, { $trunc: `$${field}` }] },
  ] }, `$${field}`, null] }, null] };
}

/** Only the bounded fields of a unit manifest cross the physical metadata boundary. */
export function journalManifestProjection(prefix: string): Document {
  return { [prefix]: { $cond: [{ $eq: [{ $type: `$${prefix}` }, 'missing'] }, '$$REMOVE', {
    key: journalStringProjection(`${prefix}.key`), hash: journalStringProjection(`${prefix}.hash`),
    identity: { owner: journalStringProjection(`${prefix}.identity.owner`),
      position: journalStringProjection(`${prefix}.identity.position`), unit: journalStringProjection(`${prefix}.identity.unit`) },
    bsonBytes: journalNumberProjection(`${prefix}.bsonBytes`), logicalBytes: journalNumberProjection(`${prefix}.logicalBytes`),
    chunks: journalNumberProjection(`${prefix}.chunks`),
  }] } };
}

/** Compute actual BSON output; an undersized encoder buffer never becomes a value-size limit. */
export function serializeJournalBson(value: Document): Uint8Array {
  let capacity = 16 * 1024 * 1024;
  for (;;) {
    BSON.setInternalBufferSize(capacity);
    try { return BSON.serialize(value, { ignoreUndefined: false }); }
    catch (error) {
      if (!(error instanceof RangeError) || !('code' in error) || error.code !== 'ERR_OUT_OF_RANGE') throw error;
      capacity *= 2;
      if (!Number.isSafeInteger(capacity)) throw error;
    }
  }
}

/** Persist one complete logical object as bounded BSON chunks in the caller's transaction. */
export async function writeJournalUnit(collection: Collection<JournalChunk>, identity: JournalUnitIdentity,
  value: Document, session: ClientSession, deadline?: number): Promise<JournalUnit> {
  const bytes = serializeJournalBson(value);
  const chunks = Math.ceil(bytes.length / CHUNK_BYTES);
  const key = createHash('sha256').update(stableJson(identity)).digest('hex');
  const manifest: JournalUnit = { key, identity, bsonBytes: bytes.length,
    logicalBytes: Buffer.byteLength(JSON.stringify(BSON.deserialize(bytes))), chunks,
    hash: createHash('sha256').update(bytes).digest('hex') };
  for (let ordinal = 0; ordinal < chunks; ordinal++) {
    const payload = bytes.subarray(ordinal * CHUNK_BYTES, Math.min((ordinal + 1) * CHUNK_BYTES, bytes.length));
    await collection.insertOne({ _id: `${key}:${ordinal}`, ...identity, ordinal, payload: new Binary(payload) },
      deadline === undefined ? { session } : { session, ...journalCommandTimeout(deadline, session) });
  }
  return manifest;
}

/** Refuse unsafe persisted size claims before fetching any payload or allocating a combined buffer. */
function reserve(manifest: JournalUnit, ledger: JournalReadLedger, logicalCharge: number, physicalCharge = manifest.bsonBytes): void {
  if (!Number.isSafeInteger(manifest.bsonBytes) || manifest.bsonBytes < 5 ||
    !Number.isSafeInteger(manifest.logicalBytes) || manifest.logicalBytes < 2 ||
    !Number.isSafeInteger(manifest.chunks) || manifest.chunks !== Math.ceil(manifest.bsonBytes / CHUNK_BYTES) ||
    !/^[a-f0-9]{64}$/.test(manifest.hash) || !Number.isSafeInteger(logicalCharge) || logicalCharge < 0)
    throw new KernelError('INVALID', 'Malformed Mongo journal unit manifest');
  if (Date.now() >= ledger.budget.deadline || physicalCharge > ledger.physicalLimit - ledger.physicalBytes ||
    logicalCharge > ledger.budget.bytes - ledger.logicalBytes)
    throw new KernelError('BUDGET', 'Mongo journal reconstruction allowance exceeded');
  ledger.physicalBytes += physicalCharge;
  ledger.logicalBytes += logicalCharge;
}

/** Fetch one bounded chunk per command, validate its manifest, then decode existing BSON semantics. */
export async function readJournalUnit(collection: Collection<JournalChunk>, manifest: JournalUnit,
  identity: JournalUnitIdentity, ledger: JournalReadLedger, logicalCharge = manifest.logicalBytes,
  session?: ClientSession): Promise<Document> {
  const key = createHash('sha256').update(stableJson(identity)).digest('hex');
  if (manifest.key !== key || stableJson(manifest.identity) !== stableJson(identity))
    throw new KernelError('INVALID', 'Mongo journal unit belongs to a different owner or position');
  let loaded = decodedUnits.get(ledger);
  if (loaded === undefined) { loaded = new Map(); decodedUnits.set(ledger, loaded); }
  const cacheKey = `${key}:${manifest.hash}`;
  const cached = loaded.get(cacheKey);
  if (cached !== undefined) {
    if (cached.bsonBytes !== manifest.bsonBytes || Buffer.byteLength(JSON.stringify(cached.value)) !== manifest.logicalBytes)
      throw new KernelError('INVALID', 'Mongo journal manifest differs from its loaded unit');
    reserve(manifest, ledger, logicalCharge, 0);
    return cached.value;
  }
  reserve(manifest, ledger, logicalCharge);
  const bytes = Buffer.allocUnsafe(manifest.bsonBytes);
  const digest = createHash('sha256');
  for (let ordinal = 0; ordinal < manifest.chunks; ordinal++) {
    const remaining = ledger.budget.deadline - Date.now();
    if (remaining <= 0) throw new KernelError('BUDGET', 'Mongo journal reconstruction deadline exceeded');
    const expected = Math.min(CHUNK_BYTES, manifest.bsonBytes - ordinal * CHUNK_BYTES);
    // The server checks wire payload size before the driver can allocate a corrupt oversized chunk.
    const chunk = await collection.findOne({ _id: `${key}:${ordinal}`, ...identity, ordinal,
      $expr: { $eq: [{ $cond: [{ $eq: [{ $type: '$payload' }, 'binData'] }, { $binarySize: '$payload' }, -1] }, expected] } },
    { session, projection: { _id: 0, payload: 1 }, ...journalCommandTimeout(ledger.budget.deadline, session), collation: { locale: 'simple' } });
    if (chunk === null || chunk.payload.length() !== expected)
      throw new KernelError('INVALID', 'Mongo journal chunk is missing or inconsistent');
    const part = chunk.payload.value();
    bytes.set(part, ordinal * CHUNK_BYTES);
    digest.update(part);
  }
  if (digest.digest('hex') !== manifest.hash)
    throw new KernelError('INVALID', 'Mongo journal unit checksum differs');
  if (bytes.readInt32LE(0) !== bytes.length || bytes[bytes.length - 1] !== 0)
    throw new KernelError('INVALID', 'Mongo journal BSON root length or terminator differs');
  let value: Document;
  try { value = BSON.deserialize(bytes); }
  catch (error) {
    throw new KernelError('INVALID', `Malformed Mongo journal BSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (Buffer.byteLength(JSON.stringify(value)) !== manifest.logicalBytes)
    throw new KernelError('INVALID', 'Mongo journal logical size differs');
  if (Date.now() >= ledger.budget.deadline)
    throw new KernelError('BUDGET', 'Mongo journal reconstruction deadline exceeded');
  loaded.set(cacheKey, { value, bsonBytes: manifest.bsonBytes });
  return value;
}
