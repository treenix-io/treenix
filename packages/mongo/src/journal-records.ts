import { createHash } from 'node:crypto';
import { BSON, type ClientSession, type Collection, type Document, type Sort } from 'mongodb';
import { KernelError } from '@treenx/core/errors';
import { readJournalImages } from '@treenx/core/kernel/journal';
import { journalVisibility } from '@treenx/core/kernel/store/journal-index';
import type {
  Budget,
  DecisionMetadata,
  JournalCommit,
  JournalEntry,
  JournalIntakeHead,
  JournalPositionHead,
  JournalVisibility,
  Position,
  StoredWrite,
} from '@treenx/core/kernel/types';
import { stableJson } from '@treenx/core/util/stable-json';
import type { OwnedTransaction } from '#owner-transactions';
import {
  readJournalUnit,
  serializeJournalBson,
  writeJournalUnit,
  type JournalChunk,
  journalManifestProjection,
  journalNumberProjection,
  journalStringProjection,
  journalRemaining,
  journalCommandTimeout,
  type JournalReadLedger,
  type JournalUnit,
} from '#journal-units';

export interface JournalRetentionMetadata {
  readonly _acceptedAt?: number;
  readonly _retainUntil?: number;
  readonly _decisionTime?: number;
  readonly _anchorTime?: number;
}

type Header = Omit<JournalCommit, 'entries'>;
type HeaderUnits = { readonly [Field in keyof Header]: JournalUnit };

interface IndexedRoot extends JournalRetentionMetadata {
  readonly _id: string;
  readonly _owner: string;
  readonly _position: string;
  readonly _epoch: number;
  readonly _seq: number;
}

export type InlineJournalRoot = JournalCommit &
  Partial<IndexedRoot> & {
    readonly _id: string;
    readonly _logicalBytes?: number;
    readonly _bsonBytes?: number;
    readonly _entryOverrides?: boolean;
    readonly _transaction?: OwnedTransaction;
  };
export interface FragmentJournalRoot extends IndexedRoot {
  readonly _transaction?: OwnedTransaction;
  readonly _format: 'bson-fragments';
  readonly header: HeaderUnits;
  readonly entryCount: number;
  readonly logicalBytes: number;
  readonly payloadBsonBytes: number;
  readonly callerIdentity: string;
  readonly decisionIdentity?: string;
  readonly anchorIdentity?: string;
  readonly hasIntake: boolean;
}
export type JournalRoot = InlineJournalRoot | FragmentJournalRoot;
export type JournalHead = Omit<InlineJournalRoot, 'entries'> | FragmentJournalRoot;

export interface JournalEntryIndex {
  readonly _id: string;
  readonly owner: string;
  readonly position: string;
  readonly epoch: number;
  readonly seq: number;
  readonly ordinal: number;
  readonly idIdentity: string;
  readonly visibility: JournalUnit;
  readonly entry?: JournalUnit;
}

export interface JournalCollections {
  readonly owner: string;
  readonly roots: Collection<InlineJournalRoot>;
  readonly headers: Collection<FragmentJournalRoot>;
  readonly chunks: Collection<JournalChunk>;
  readonly entries: Collection<JournalEntryIndex>;
  readonly physicalLimit: number;
}

export const JOURNAL_HEADER_FIELDS = [
  'pos',
  'kind',
  'executor',
  'caller',
  'decision',
  'anchorDecision',
  'intake',
  'maintenance',
  'backfill',
  'quarantine',
] as const;
const INLINE_HEAD_FIELDS = [
  '_id',
  '_owner',
  '_position',
  '_epoch',
  '_seq',
  '_logicalBytes',
  '_bsonBytes',
  '_entryOverrides',
  '_acceptedAt',
  '_retainUntil',
  '_decisionTime',
  '_anchorTime',
  'pos',
] as const;
export type InlineJournalHead = Omit<InlineJournalRoot, 'entries'>;

/** Legacy identities and complete positions share the caller's physical reconstruction allowance. */
export async function readInlineHead(
  collections: JournalCollections,
  filter: Document,
  ledger: JournalReadLedger,
  sort?: Sort,
  session?: ClientSession,
): Promise<InlineJournalHead | null> {
  const selected = Object.fromEntries(INLINE_HEAD_FIELDS.map((name) => [name, `$${name}`]));
  const loaded = await collections.roots.findOne<{
    readonly head: InlineJournalHead | null;
    readonly bytes: number;
  }>(filter, {
    projection: {
      _id: 0,
      bytes: { $bsonSize: selected },
      head: {
        $cond: [
          { $lte: [{ $bsonSize: selected }, ledger.physicalLimit - ledger.physicalBytes] },
          selected,
          null,
        ],
      },
    },
    sort,
    session,
    ...journalCommandTimeout(ledger.budget.deadline, session),
    collation: { locale: 'simple' },
  });
  if (loaded === null) return null;
  if (loaded.head === null)
    throw new KernelError('BUDGET', 'Mongo inline head reconstruction allowance exceeded');
  if (loaded.head._entryOverrides !== undefined && typeof loaded.head._entryOverrides !== 'boolean')
    throw new KernelError('INVALID', 'Malformed inline journal override marker');
  ledger.physicalBytes += loaded.bytes;
  return loaded.head;
}
export const JOURNAL_ENTRY_PROJECTION = {
  _id: journalStringProjection('_id'),
  owner: journalStringProjection('owner'),
  position: journalStringProjection('position'),
  epoch: journalNumberProjection('epoch'),
  seq: journalNumberProjection('seq'),
  ordinal: journalNumberProjection('ordinal'),
  idIdentity: journalStringProjection('idIdentity'),
  ...journalManifestProjection('visibility'),
  ...journalManifestProjection('entry'),
};
export const FRAGMENT_HEAD_PROJECTION = {
  _id: journalStringProjection('_id'),
  _owner: journalStringProjection('_owner'),
  _position: journalStringProjection('_position'),
  _epoch: journalNumberProjection('_epoch'),
  _seq: journalNumberProjection('_seq'),
  _acceptedAt: {
    $cond: [
      { $eq: [{ $type: '$_acceptedAt' }, 'missing'] },
      '$$REMOVE',
      journalNumberProjection('_acceptedAt'),
    ],
  },
  _retainUntil: {
    $cond: [
      { $eq: [{ $type: '$_retainUntil' }, 'missing'] },
      '$$REMOVE',
      journalNumberProjection('_retainUntil'),
    ],
  },
  _decisionTime: {
    $cond: [
      { $eq: [{ $type: '$_decisionTime' }, 'missing'] },
      '$$REMOVE',
      journalNumberProjection('_decisionTime'),
    ],
  },
  _anchorTime: {
    $cond: [
      { $eq: [{ $type: '$_anchorTime' }, 'missing'] },
      '$$REMOVE',
      journalNumberProjection('_anchorTime'),
    ],
  },
  _format: journalStringProjection('_format'),
  entryCount: journalNumberProjection('entryCount'),
  logicalBytes: journalNumberProjection('logicalBytes'),
  payloadBsonBytes: journalNumberProjection('payloadBsonBytes'),
  callerIdentity: journalStringProjection('callerIdentity'),
  decisionIdentity: journalStringProjection('decisionIdentity'),
  anchorIdentity: journalStringProjection('anchorIdentity'),
  hasIntake: { $cond: [{ $eq: [{ $type: '$hasIntake' }, 'bool'] }, '$hasIntake', null] },
  ...Object.fromEntries(
    JOURNAL_HEADER_FIELDS.flatMap((name) =>
      Object.entries(journalManifestProjection(`header.${name}`)),
    ),
  ),
};

/** Fixed hashes identify physical units without embedding unbounded canonical strings in index keys. */
export function journalIdentity(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

/** Keep all metadata and unit reads under the same absolute caller deadline. */
export function journalTimeout(budget: Budget): number {
  return journalRemaining(budget.deadline);
}

/** Count exact selected canonical JSON once, independently of BSON wrapper and physical bytes. */
export function chargeJournal(value: object, ledger: JournalReadLedger): void {
  journalTimeout(ledger.budget);
  const bytes = Buffer.byteLength(JSON.stringify(value));
  if (bytes > ledger.budget.bytes - ledger.logicalBytes)
    throw new KernelError('BUDGET', 'Mongo canonical journal budget exceeded');
  ledger.logicalBytes += bytes;
}

/** Load an earlier transition only when a legacy inline record has no visibility index yet. */
async function legacyVisibility(
  collections: JournalCollections,
  id: string,
  budget: Budget,
  session: ClientSession,
  position: Position,
): Promise<JournalVisibility['after'] | undefined> {
  const records: InlineJournalRoot[] = [];
  let before: Position | undefined = position;
  for (;;) {
    const record: InlineJournalRoot | null = await collections.roots.findOne(
      {
        'entries.id': id,
        ...(before === undefined
          ? {}
          : {
              $or: [
                { 'pos.epoch': { $lt: before.epoch } },
                { 'pos.epoch': before.epoch, 'pos.seq': { $lt: before.seq } },
              ],
            }),
      },
      {
        session,
        projection: { pos: 1, kind: 1, entries: { $elemMatch: { id } } },
        sort: { 'pos.epoch': -1, 'pos.seq': -1 },
        ...journalCommandTimeout(budget.deadline, session),
        collation: { locale: 'simple' },
      },
    );
    if (record === null) break;
    records.push(record);
    const change = record.entries[0].change;
    if (change.t !== 'update' || change.after !== undefined) break;
    before = record.pos;
  }
  if (records.length === 0) return undefined;
  const latest = records[0];
  const images = readJournalImages([...records].reverse(), { pos: latest.pos, id });
  const entry = latest.entries[0];
  return journalVisibility(
    latest,
    {
      ...entry,
      change: {
        t: 'reconcile',
        after: images.after,
        before: images.before === 'unknown' ? undefined : images.before,
      },
    },
    undefined,
  ).after;
}

/** Publish one complete canonical record and its visibility in the caller's actual transaction. */
export async function writeJournalRecord(
  collections: JournalCollections,
  record: JournalCommit,
  writes: readonly StoredWrite[],
  session: ClientSession,
  existingId?: string,
  deadline?: number,
  readLedger?: JournalReadLedger,
  transaction?: OwnedTransaction,
  retention?: JournalRetentionMetadata,
): Promise<void> {
  const command = () =>
    deadline === undefined ? { session } : { session, ...journalCommandTimeout(deadline, session) };
  const position = journalIdentity(record.pos);
  const base = {
    ...retention,
    _id: position,
    _owner: collections.owner,
    _position: position,
    _epoch: record.pos.epoch,
    _seq: record.pos.seq,
    ...(transaction === undefined ? {} : { _transaction: transaction }),
  };
  const actual = serializeJournalBson(record);
  const fragmented = actual.length > 8 * 1024 * 1024;
  const accepted = new Map(
    writes.flatMap((write) => (write.node === null ? [] : [[write.node.$id, write.node] as const])),
  );
  const indexes: JournalEntryIndex[] = [];
  const budget = {
    nodes: Number.MAX_SAFE_INTEGER,
    bytes: Number.MAX_SAFE_INTEGER,
    exprWork: Number.MAX_SAFE_INTEGER,
    deadline: deadline ?? Date.now() + 5000,
  };
  for (let ordinal = 0; ordinal < record.entries.length; ordinal++) {
    const entry = record.entries[ordinal];
    let prior: JournalVisibility['after'] | undefined;
    if (
      (entry.change.t === 'reconcile' && entry.change.before === undefined) ||
      (entry.change.t === 'update' && entry.change.after === undefined)
    ) {
      const previous = await collections.entries.findOne(
        {
          owner: collections.owner,
          idIdentity: journalIdentity(entry.id),
          $or: [
            { epoch: { $lt: record.pos.epoch } },
            { epoch: record.pos.epoch, seq: { $lt: record.pos.seq } },
          ],
        },
        {
          ...command(),
          projection: JOURNAL_ENTRY_PROJECTION,
          sort: { epoch: -1, seq: -1, ordinal: -1 },
          collation: { locale: 'simple' },
        },
      );
      prior =
        previous === null
          ? await legacyVisibility(collections, entry.id, budget, session, record.pos)
          : (
              await readJournalVisibility(
                collections,
                previous,
                readLedger ?? {
                  budget,
                  physicalLimit: collections.physicalLimit,
                  physicalBytes: 0,
                  logicalBytes: 0,
                },
                session,
              )
            ).after;
    }
    const visible = journalVisibility(record, entry, prior, accepted.get(entry.id));
    const visibility = await writeJournalUnit(
      collections.chunks,
      { owner: collections.owner, position, unit: `visibility:${ordinal}` },
      { value: visible },
      session,
      deadline,
    );
    const unit = fragmented
      ? await writeJournalUnit(
          collections.chunks,
          { owner: collections.owner, position, unit: `entry:${ordinal}` },
          { value: entry },
          session,
          deadline,
        )
      : undefined;
    indexes.push({
      _id: `${position}:${ordinal}`,
      owner: collections.owner,
      position,
      epoch: record.pos.epoch,
      seq: record.pos.seq,
      ordinal,
      idIdentity: journalIdentity(entry.id),
      visibility,
      ...(unit === undefined ? {} : { entry: unit }),
    });
  }
  if (indexes.length !== 0) await collections.entries.insertMany(indexes, command());
  if (!fragmented) {
    const metadata = {
      ...base,
      _logicalBytes: Buffer.byteLength(JSON.stringify(BSON.deserialize(actual))),
      _bsonBytes: actual.length,
    };
    if (existingId === undefined)
      await collections.roots.insertOne({ ...record, ...metadata }, command());
    else
      await collections.roots.updateOne(
        { _id: existingId, _position: { $exists: false } },
        {
          $set: {
            _owner: metadata._owner,
            _position: position,
            _epoch: metadata._epoch,
            _seq: metadata._seq,
            _logicalBytes: metadata._logicalBytes,
            _bsonBytes: metadata._bsonBytes,
            ...retention,
          },
        },
        { ...command(), collation: { locale: 'simple' } },
      );
    return;
  }
  const unit = (name: keyof Header) =>
    writeJournalUnit(
      collections.chunks,
      { owner: collections.owner, position, unit: `header:${name}` },
      { value: record[name] },
      session,
      deadline,
    );
  const header: HeaderUnits = {
    pos: await unit('pos'),
    kind: await unit('kind'),
    executor: await unit('executor'),
    caller: await unit('caller'),
    ...(record.decision === undefined ? {} : { decision: await unit('decision') }),
    ...(record.anchorDecision === undefined
      ? {}
      : { anchorDecision: await unit('anchorDecision') }),
    ...(record.intake === undefined ? {} : { intake: await unit('intake') }),
    ...(record.maintenance === undefined ? {} : { maintenance: await unit('maintenance') }),
    ...(record.quarantine === undefined ? {} : { quarantine: await unit('quarantine') }),
  };
  await collections.headers.insertOne(
    {
      ...base,
      _format: 'bson-fragments',
      header,
      entryCount: record.entries.length,
      logicalBytes: Buffer.byteLength(JSON.stringify(BSON.deserialize(actual))),
      payloadBsonBytes:
        Object.values(header).reduce((total, manifest) => total + manifest.bsonBytes, 0) +
        indexes.reduce(
          (total, index) => total + (index.entry === undefined ? 0 : index.entry.bsonBytes),
          0,
        ),
      callerIdentity: journalIdentity(record.caller),
      hasIntake: record.intake !== undefined,
      ...(record.decision === undefined
        ? {}
        : { decisionIdentity: journalIdentity(record.decision.opId) }),
      ...(record.anchorDecision === undefined
        ? {}
        : { anchorIdentity: journalIdentity(record.anchorDecision.opId) }),
    },
    command(),
  );
  if (existingId !== undefined)
    await collections.roots.deleteOne(
      { _id: existingId },
      { ...command(), collation: { locale: 'simple' } },
    );
}

/** Decode one header field through the existing BSON boundary, without charging its physical wrapper. */
async function field(
  collections: JournalCollections,
  root: FragmentJournalRoot,
  name: keyof Header,
  ledger: JournalReadLedger,
  session?: ClientSession,
): Promise<Document | undefined> {
  const manifest = root.header[name];
  if (manifest === undefined) return undefined;
  return readJournalUnit(
    collections.chunks,
    manifest,
    { owner: collections.owner, position: root._position, unit: `header:${name}` },
    ledger,
    0,
    session,
  );
}

/** Include field names, separators and object punctuation in the selected canonical byte reservation. */
function headerBytes(
  root: FragmentJournalRoot,
  mode: 'full' | 'position' | 'intake' | 'decision',
): number {
  const names: readonly (keyof Header)[] =
    mode === 'position'
      ? ['pos']
      : mode === 'intake'
        ? ['pos', 'intake']
        : mode === 'decision'
          ? ['pos', 'caller', 'decision', 'anchorDecision']
          : [
              'pos',
              'kind',
              'executor',
              'caller',
              'decision',
              'anchorDecision',
              'intake',
              'maintenance',
              'backfill',
              'quarantine',
            ];
  let bytes = 2,
    count = 0;
  for (const name of names) {
    const manifest = root.header[name];
    if (manifest === undefined) continue;
    if (!Number.isSafeInteger(manifest.logicalBytes) || manifest.logicalBytes < 10)
      throw new KernelError('INVALID', 'Malformed journal header logical byte count');
    bytes += JSON.stringify(name).length + 1 + manifest.logicalBytes - 10 + (count++ === 0 ? 0 : 1);
  }
  return bytes;
}

/** Required canonical header fields never become implicit undefined fallback values. */
async function requiredField(
  collections: JournalCollections,
  root: FragmentJournalRoot,
  name: keyof Header,
  ledger: JournalReadLedger,
  session?: ClientSession,
): Promise<Document> {
  const decoded = await field(collections, root, name, ledger, session);
  if (decoded === undefined)
    throw new KernelError('INVALID', 'Required fragment journal header field is absent');
  return decoded;
}

/** Read a real position head without loading decision outcomes or node images. */
export async function readJournalPosition(
  collections: JournalCollections,
  root: JournalHead,
  ledger: JournalReadLedger,
  session?: ClientSession,
): Promise<Position> {
  if (!('_format' in root)) return root.pos;
  if (typeof root.hasIntake !== 'boolean')
    throw new KernelError('INVALID', 'Malformed fragment journal intake marker');
  const decoded = await requiredField(collections, root, 'pos', ledger, session);
  const pos: Position = decoded.value;
  if (journalIdentity(pos) !== root._position || pos.epoch !== root._epoch || pos.seq !== root._seq)
    throw new KernelError('INVALID', 'Fragment journal position differs from its indexed identity');
  return pos;
}

/** Hydrate the canonical header; optional metadata ranges select only their required logical fields. */
export function readJournalHeader(
  collections: JournalCollections,
  root: JournalHead,
  ledger: JournalReadLedger,
  mode?: 'full',
  session?: ClientSession,
): Promise<Header>;
export function readJournalHeader(
  collections: JournalCollections,
  root: JournalHead,
  ledger: JournalReadLedger,
  mode: 'position' | 'intake' | 'decision',
  session?: ClientSession,
): Promise<JournalPositionHead | JournalIntakeHead | DecisionMetadata>;
export async function readJournalHeader(
  collections: JournalCollections,
  root: JournalHead,
  ledger: JournalReadLedger,
  mode: 'full' | 'position' | 'intake' | 'decision' = 'full',
  session?: ClientSession,
) {
  if (!('_format' in root)) {
    if (mode === 'position') return { pos: root.pos };
    const names =
      mode === 'intake'
        ? ['pos', 'intake']
        : mode === 'decision'
          ? ['pos', 'caller', 'decision', 'anchorDecision']
          : JOURNAL_HEADER_FIELDS;
    const selected = Object.fromEntries(names.map((name) => [name, `$${name}`]));
    const loaded = await collections.roots.findOne<{ readonly header: Header | null }>(
      { _id: root._id },
      {
        projection: {
          _id: 0,
          header: {
            $cond: [
              { $lte: [{ $bsonSize: selected }, ledger.physicalLimit - ledger.physicalBytes] },
              selected,
              null,
            ],
          },
        },
        session,
        collation: { locale: 'simple' },
        ...journalCommandTimeout(ledger.budget.deadline, session),
      },
    );
    if (loaded === null) throw new KernelError('INVALID', 'Inline journal header disappeared');
    if (loaded.header === null)
      throw new KernelError('BUDGET', 'Mongo inline header reconstruction allowance exceeded');
    const header = loaded.header;
    ledger.physicalBytes += serializeJournalBson(header).length;
    if (mode === 'intake') return { pos: header.pos, intake: header.intake };
    if (mode === 'decision')
      return {
        pos: header.pos,
        caller: header.caller,
        ...(header.decision === undefined ? {} : { decision: header.decision }),
        ...(header.anchorDecision === undefined ? {} : { anchorDecision: header.anchorDecision }),
      };
    return header;
  }
  if (root._owner !== collections.owner)
    throw new KernelError('INVALID', 'Fragment journal has a different physical owner');
  if (headerBytes(root, mode) > ledger.budget.bytes - ledger.logicalBytes)
    throw new KernelError('BUDGET', 'Mongo canonical journal metadata budget exceeded');
  const pos = await readJournalPosition(collections, root, ledger, session);
  if (mode === 'position') return { pos };
  if (mode === 'intake')
    return {
      pos,
      intake: (await requiredField(collections, root, 'intake', ledger, session)).value,
    };
  const caller = (await requiredField(collections, root, 'caller', ledger, session)).value;
  const decision = await field(collections, root, 'decision', ledger, session);
  const anchorDecision = await field(collections, root, 'anchorDecision', ledger, session);
  const selected = {
    pos,
    caller,
    ...(decision === undefined ? {} : { decision: decision.value }),
    ...(anchorDecision === undefined ? {} : { anchorDecision: anchorDecision.value }),
  };
  if (mode === 'decision') return selected;
  const intake = await field(collections, root, 'intake', ledger, session);
  const maintenance = await field(collections, root, 'maintenance', ledger, session);
  const backfill = await field(collections, root, 'backfill', ledger, session);
  const quarantine = await field(collections, root, 'quarantine', ledger, session);
  return {
    ...selected,
    kind: (await requiredField(collections, root, 'kind', ledger, session)).value,
    executor: (await requiredField(collections, root, 'executor', ledger, session)).value,
    ...(intake === undefined ? {} : { intake: intake.value }),
    ...(maintenance === undefined ? {} : { maintenance: maintenance.value }),
    ...(backfill === undefined ? {} : { backfill: backfill.value }),
    ...(quarantine === undefined ? {} : { quarantine: quarantine.value }),
  };
}

/** Hydrate only a selected entry; history predicates run on its separate visibility index first. */
export async function readJournalEntry(
  collections: JournalCollections,
  root: JournalHead,
  indexed: JournalEntryIndex,
  ledger: JournalReadLedger,
  visibility: JournalVisibility,
  session?: ClientSession,
): Promise<JournalEntry> {
  if (indexed.owner !== collections.owner || indexed.position !== root._position)
    throw new KernelError('INVALID', 'Journal entry index belongs to a different physical record');
  if (!('_format' in root) && indexed.entry === undefined) {
    const payload = { value: { $arrayElemAt: ['$entries', indexed.ordinal] } };
    const selected = await collections.roots.findOne<{
      readonly payload: { readonly value: JournalEntry } | null;
    }>(
      { _id: root._id },
      {
        projection: {
          _id: 0,
          payload: {
            $cond: [
              { $lte: [{ $bsonSize: payload }, ledger.physicalLimit - ledger.physicalBytes] },
              payload,
              null,
            ],
          },
        },
        ...journalCommandTimeout(ledger.budget.deadline, session),
        session,
        collation: { locale: 'simple' },
      },
    );
    if (selected === null) throw new KernelError('INVALID', 'Inline journal entry disappeared');
    if (selected.payload === null)
      throw new KernelError('BUDGET', 'Mongo journal BSON reconstruction allowance exceeded');
    const entry = selected.payload.value;
    if (entry === undefined || entry.id !== visibility.address.id)
      throw new KernelError('INVALID', 'Inline journal entry differs from its index');
    const physical = serializeJournalBson({ value: entry }).length;
    if (physical > ledger.physicalLimit - ledger.physicalBytes)
      throw new KernelError('BUDGET', 'Mongo journal BSON reconstruction allowance exceeded');
    ledger.physicalBytes += physical;
    return entry;
  }
  if (indexed.entry === undefined)
    throw new KernelError('INVALID', 'Fragment journal entry unit is absent');
  if (!('_format' in root) && root._entryOverrides !== true)
    throw new KernelError('INVALID', 'Inline journal entry override marker is absent');
  const decoded = await readJournalUnit(
    collections.chunks,
    indexed.entry,
    { owner: collections.owner, position: root._position, unit: `entry:${indexed.ordinal}` },
    ledger,
    0,
    session,
  );
  const entry: JournalEntry = decoded.value;
  if (journalIdentity(entry.id) !== indexed.idIdentity || entry.path !== visibility.path)
    throw new KernelError('INVALID', 'Journal entry differs from its indexed visibility');
  return entry;
}

/** Variable visibility is a bounded BSON unit, independent of fixed entry references and node images. */
export async function readJournalVisibility(
  collections: JournalCollections,
  indexed: JournalEntryIndex,
  ledger: JournalReadLedger,
  session?: ClientSession,
): Promise<JournalVisibility> {
  if (
    indexed.owner !== collections.owner ||
    indexed._id !== `${indexed.position}:${indexed.ordinal}`
  )
    throw new KernelError('INVALID', 'Journal visibility has an inconsistent physical identity');
  const decoded = await readJournalUnit(
    collections.chunks,
    indexed.visibility,
    { owner: collections.owner, position: indexed.position, unit: `visibility:${indexed.ordinal}` },
    ledger,
    0,
    session,
  );
  const visibility: JournalVisibility = decoded.value;
  if (
    journalIdentity(visibility.address.id) !== indexed.idIdentity ||
    journalIdentity(visibility.address.pos) !== indexed.position ||
    visibility.address.pos.epoch !== indexed.epoch ||
    visibility.address.pos.seq !== indexed.seq
  )
    throw new KernelError('INVALID', 'Journal visibility differs from its fixed index identity');
  return visibility;
}

/** Reconstruct exactly one complete record, including every canonical entry and header field. */
export async function readJournalRecord(
  collections: JournalCollections,
  root: JournalHead,
  ledger: JournalReadLedger,
): Promise<JournalCommit> {
  if (!('_format' in root)) {
    if (
      (root._logicalBytes !== undefined &&
        root._logicalBytes > ledger.budget.bytes - ledger.logicalBytes) ||
      (root._bsonBytes !== undefined &&
        root._bsonBytes > ledger.physicalLimit - ledger.physicalBytes)
    )
      throw new KernelError('BUDGET', 'Mongo inline journal allowance exceeded');
    const payload = Object.fromEntries(
      [...JOURNAL_HEADER_FIELDS, 'entries'].map((name) => [name, `$${name}`]),
    );
    const selected = await collections.roots.findOne<{ readonly record: JournalCommit | null }>(
      { _id: root._id },
      {
        projection: {
          _id: 0,
          record: {
            $cond: [
              { $lte: [{ $bsonSize: payload }, ledger.physicalLimit - ledger.physicalBytes] },
              payload,
              null,
            ],
          },
        },
        timeoutMS: journalTimeout(ledger.budget),
        collation: { locale: 'simple' },
      },
    );
    if (selected === null) throw new KernelError('INVALID', 'Inline journal root disappeared');
    if (selected.record === null)
      throw new KernelError('BUDGET', 'Mongo inline journal BSON allowance exceeded');
    let record = selected.record;
    const physical = serializeJournalBson(record).length;
    if (physical > ledger.physicalLimit - ledger.physicalBytes)
      throw new KernelError('BUDGET', 'Mongo inline journal BSON allowance exceeded');
    ledger.physicalBytes += physical;
    if (root._entryOverrides === true) {
      const entries = [...record.entries];
      for (let ordinal = 0; ordinal < entries.length; ordinal++) {
        const indexed = await collections.entries.findOne(
          { _id: `${root._position}:${ordinal}`, owner: collections.owner },
          {
            projection: JOURNAL_ENTRY_PROJECTION,
            timeoutMS: journalTimeout(ledger.budget),
            collation: { locale: 'simple' },
          },
        );
        if (indexed === null)
          throw new KernelError('INVALID', 'Inline journal override index is absent');
        chargeJournal(indexed, ledger);
        if (indexed.entry !== undefined)
          entries[ordinal] = await readJournalEntry(
            collections,
            root,
            indexed,
            ledger,
            await readJournalVisibility(collections, indexed, ledger),
          );
      }
      record = { ...record, entries };
      if (
        Buffer.byteLength(JSON.stringify(record)) !== root._logicalBytes ||
        serializeJournalBson(record).length !== root._bsonBytes
      )
        throw new KernelError('INVALID', 'Inline journal override canonical counts differ');
    }
    chargeJournal(record, ledger);
    return record;
  }
  if (
    !Number.isSafeInteger(root.entryCount) ||
    root.entryCount < 0 ||
    !Number.isSafeInteger(root.logicalBytes) ||
    root.logicalBytes < 2
  )
    throw new KernelError('INVALID', 'Malformed fragment journal counts');
  if (root.logicalBytes > ledger.budget.bytes - ledger.logicalBytes)
    throw new KernelError('BUDGET', 'Mongo canonical journal budget exceeded');
  if (!Number.isSafeInteger(root.payloadBsonBytes) || root.payloadBsonBytes < 5)
    throw new KernelError('INVALID', 'Malformed fragment journal physical byte count');
  if (root.payloadBsonBytes > ledger.physicalLimit - ledger.physicalBytes)
    throw new KernelError('BUDGET', 'Mongo journal BSON reconstruction allowance exceeded');
  const header = await readJournalHeader(collections, root, ledger);
  const entries: JournalEntry[] = [];
  for (let ordinal = 0; ordinal < root.entryCount; ordinal++) {
    const indexed = await collections.entries.findOne(
      { _id: `${root._position}:${ordinal}`, owner: collections.owner },
      {
        projection: JOURNAL_ENTRY_PROJECTION,
        timeoutMS: journalTimeout(ledger.budget),
        collation: { locale: 'simple' },
      },
    );
    if (indexed === null || indexed.ordinal !== ordinal)
      throw new KernelError('INVALID', 'Fragment journal entry index is missing or inconsistent');
    entries.push(
      await readJournalEntry(
        collections,
        root,
        indexed,
        ledger,
        await readJournalVisibility(collections, indexed, ledger),
      ),
    );
  }
  const record: JournalCommit = { ...header, entries };
  if (Buffer.byteLength(JSON.stringify(record)) !== root.logicalBytes)
    throw new KernelError('INVALID', 'Fragment journal canonical byte count differs');
  chargeJournal(record, ledger);
  return record;
}
