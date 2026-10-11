import { BSON, Int32, MongoOperationTimeoutError, MongoServerError, type MongoClient, type Collection, type Document, type Filter, type IndexDescription, type Sort, type WithId } from 'mongodb';
import { assertSafePath, comparePaths, dirname, isChildPath } from '@treenx/core';
import { KernelError } from '@treenx/core/errors';
import { decodeChainNode } from '@treenx/core/kernel/chain-index';
import { createSiftTest } from '@treenx/core/kernel/expr';
import { fromStorageKeys, mapNodeForSift, toStorageKeys } from '@treenx/core/kernel/store/keys';
import { parseScanCursor, scanPage } from '@treenx/core/kernel/store/scan';
import { DEFAULT_LIMITS, type Budget, type DecisionRange, type JournalCommit, type JournalRange,
  type JournalPositionHeadRange, type JournalIntakeHeadRange, type DecisionMetadataRange,
  type JournalPositionHead, type JournalIntakeHead, type DecisionMetadata,
  type ScanQuery, type ScanRange, type ScanResult, type Store, type StoreCommit, type StoredNode, type StoreTransactionOwner, type StoredWrite,
  type StoreCensusQuery, type StoreCensusNode, type StoreCensusRange } from '@treenx/core/kernel/types';
import type { ExternalCandidate, BlobCarrier } from '@treenx/core/kernel/types';
import { comparePositions } from '@treenx/core/kernel/position';
import { stableJson } from '@treenx/core/util/stable-json';
import { buildPattern } from '#index';
import { createBackfill, type BackfillDocument } from '#backfill';
import type { JournalCollections } from '#journal-records';
import { scanJournalMetadata, scanJournalRecords } from '#journal-scan';
import { createMongoReporter, type MongoWatchHooks, type ReportedDocument } from '#store-watch';

export interface StoredDocument {
  readonly _path: StoredNode['$path'];
  readonly _tid: StoredNode['$id'];
  readonly _type: StoredNode['$type'];
  readonly _pos: StoredNode['$pos'];
  readonly [field: string]: unknown;
}
type CensusDocument = Pick<StoredDocument, '_path' | '_tid' | '_type' | '_pos'> & Readonly<Record<string, unknown>> & {
  readonly components: Readonly<Record<string, { readonly _type?: unknown } | null>>;
};
interface CensusImage { readonly image: CensusDocument | null; readonly bytes: number }
const CENSUS_PROJECTION = {
  _path: '$_path', _tid: '$_tid', _type: '$_type', _pos: '$_pos', _acl: '$_acl', _owner: '$_owner',
  components: { $arrayToObject: { $map: {
    input: { $filter: { input: { $objectToArray: '$$ROOT' }, as: 'field',
      cond: { $regexMatch: { input: '$$field.k', regex: '^#' } } } },
    as: 'component',
    in: { k: '$$component.k', v: { $cond: [
      { $eq: [{ $type: '$$component.v' }, 'object'] },
      { _type: { $getField: { field: { $literal: '$type' }, input: '$$component.v' } } }, null,
    ] } },
  } } },
};
export type JournalDocument = JournalCommit & { readonly _id: string };
type ReportedCost = NonNullable<ScanResult<StoredNode>['cost']>;
type ScanCost = { -readonly [Field in keyof ReportedCost]: ReportedCost[Field] };

export interface MongoStoreOptions {
  readonly uri: string;
  readonly db: string;
  readonly collection: string;
  readonly domain: Store['domain'];
  readonly indexes?: readonly IndexDescription[];
  readonly journalReadBsonBytes?: number;
  readonly journalUpgradeMs?: number;
  readonly journalRetentionMs?: number;
  beforeRecord?(): void | Promise<void>;
}
export interface MongoStore extends Store { readonly blobJournal: BlobCarrier; close(): Promise<void> }

/** Preserve the native metadata types while the shared mapping encodes authored fields. */
export function encode(node: StoredNode): StoredDocument {
  return { ...toStorageKeys(node), _path: node.$path, _tid: node.$id, _type: node.$type, _pos: node.$pos };
}
export function decode(doc: StoredDocument): StoredNode {
  return { ...fromStorageKeys(doc), $path: doc._path, $id: doc._tid, $type: doc._type, $pos: doc._pos };
}
export function databaseError(error: unknown): never {
  if (error instanceof MongoOperationTimeoutError) throw new KernelError('BUDGET', 'Mongo operation deadline exceeded');
  if (error instanceof MongoServerError) {
    const received: unknown = error.code;
    const code = received instanceof Int32 ? received.value : received;
    if (code === 50) throw new KernelError('BUDGET', 'Mongo query deadline exceeded');
    if (code === 11000) throw new KernelError('CONFLICT', 'Mongo identity or journal position already exists');
  }
  throw error;
}

/** OpId object key order never determines durable decision identity. */
function decisionFilter({ caller, opId }: DecisionRange['decision']): Filter<JournalDocument> {
  return { caller, $or: [
    { 'decision.opId.epoch': opId.epoch, 'decision.opId.time': opId.time, 'decision.opId.nonce': opId.nonce },
    { 'anchorDecision.opId.epoch': opId.epoch, 'anchorDecision.opId.time': opId.time, 'anchorDecision.opId.nonce': opId.nonce },
  ] };
}
type MetadataRange = JournalPositionHeadRange | JournalIntakeHeadRange | DecisionMetadataRange;
type MetadataResult = JournalPositionHead | JournalIntakeHead | DecisionMetadata;

export interface MongoHandleOptions {
  readonly db: string;
  readonly collection: string;
  readonly logicalBase: string;
  readonly indexes?: readonly IndexDescription[];
  readonly external?: 'trusted';
  readonly journalRetentionMs?: number;
}

export interface MongoHandleContext {
  readonly client: MongoClient;
  readonly owner: StoreTransactionOwner;
  readonly journal: JournalCollections;
  readonly blobCarrier: BlobCarrier;
  readonly blobJournal: BlobCarrier;
  readonly blobArchives: Pick<Store, 'blobArchiveCensus' | 'archivedBlobHolds'>;
  readonly watch?: MongoWatchHooks;
  readonly backfill: Collection<BackfillDocument>;
  maintenancePending(): boolean;
  retentionBoundary(): number | undefined;
  retentionClock(): number | undefined;
  journalFloor(): StoredNode['$pos'] | undefined;
  available(): void;
  pin(): () => Promise<void>;
  close(store: MongoStore): Promise<void>;
}

/** Map only structural addresses; issued identities and authored values stay unchanged. */
export function localPath(base: string, path: string): string {
  if (base === '/') return path;
  if (path === base) return '/';
  if (!path.startsWith(`${base}/`)) throw new KernelError('INVALID', 'Mongo address is outside its logical base');
  return path.slice(base.length);
}

/** Ancestor census ranges inspect the owned collection; disjoint logical ranges remain empty. */
function nodeRange(base: string, range: ScanRange): Filter<StoredDocument> {
  const path = 'node' in range ? range.node : 'children' in range ? range.children : range.subtree;
  if (path !== base && !isChildPath(base, path, false)) {
    if ('subtree' in range && isChildPath(path, base, false)) return {};
    if ('children' in range && dirname(base) === path) return { _path: '/' };
    return { _path: { $in: [] } };
  }
  const local = localPath(base, path);
  if ('node' in range) return { _path: local };
  if ('children' in range) return { _path: buildPattern(local, 1) };
  return { $or: [{ _path: local }, { _path: buildPattern(local, -1) }] };
}

/** A collection handle owns its local range while its explicit owner supplies the shared journal. */
export async function openMongoHandle(options: MongoHandleOptions, context: MongoHandleContext): Promise<MongoStore> {
    assertSafePath(options.logicalBase);
    let closed = false;
    let closing: Promise<void> | undefined;
    const nodes = context.client.db(options.db).collection<StoredDocument>(options.collection);
    const journal = context.journal.roots;
    await nodes.createIndex({ _path: 1 }, { unique: true, collation: { locale: 'simple' } });
    await nodes.createIndex({ _tid: 1 }, { unique: true, collation: { locale: 'simple' } });
    if (options.indexes !== undefined && options.indexes.length !== 0) await nodes.createIndexes([...options.indexes]);
    function available(): void {
      context.available();
      if (closed) throw new KernelError('UNAVAILABLE', 'Mongo Store is closed');
    }
    function check(budget: Budget): void {
      available();
      if (Date.now() >= budget.deadline) throw new KernelError('BUDGET', 'Mongo scan deadline exceeded');
    }
    function timeoutMS(budget: Budget): number { check(budget); return Math.max(1, Math.ceil(budget.deadline - Date.now())); }

    /** Single batches avoid driver cleanup renewing the deadline of a live server cursor. */
    async function* pages<T extends Document>(collection: Collection<T>, select: (last: WithId<T> | undefined) => Filter<T>,
      sort: Sort, budget: Budget, unique = false): AsyncGenerator<WithId<T>> {
      let last: WithId<T> | undefined;
      for (;;) {
        const batch = await collection.find(select(last), { sort, batchSize: 101, limit: 101, singleBatch: true,
          timeoutMS: timeoutMS(budget), timeoutMode: 'cursorLifetime', collation: { locale: 'simple' } }).toArray();
        if (batch.length === 0) return;
        for (const item of batch) yield item;
        if (unique) return;
        // A wire batch can stop at 16 MiB before reaching its requested size.
        last = batch[batch.length - 1];
      }
    }

    /** Filtering stays in process until migrated field pushdown has a durable completion proof. */
    function charge<T extends object>(item: T, query: ScanQuery<unknown>, cost: ScanCost): void {
      check(query.budget);
      cost.nodes++;
      cost.bytes += Buffer.byteLength(JSON.stringify(item));
      if (cost.nodes > query.budget.nodes || cost.bytes > query.budget.bytes)
        throw new KernelError('BUDGET', 'Mongo scan payload budget exceeded');
    }
    async function collectNodes(query: ScanQuery<ScanRange>, scope: string): Promise<ScanResult<StoredNode>> {
      const range = query.range, sort = query.sort ?? [];
      const filter = nodeRange(options.logicalBase, range);
      const after = query.after === undefined ? undefined : parseScanCursor(query.after, scope, sort.length);
      // Mongo's binary UTF-8 order agrees with JS path comparisons for an ASCII anchor.
      const selected = after !== undefined && sort.length === 0 && /^[\x00-\x7f]*$/.test(after.key)
        ? { $and: [filter, { _path: { $gt: localPath(options.logicalBase, after.key) } }] } : filter;
      const cost = { nodes: 0, bytes: 0, exprWork: 0 }, work = { limit: query.budget.exprWork, used: 0 };
      const test = query.where === undefined ? undefined : createSiftTest(query.where, DEFAULT_LIMITS);
      const matches: StoredNode[] = [];
      for await (const doc of pages(nodes, last => last === undefined ? selected
        : { $and: [selected, { _path: { $gt: last._path } }] }, { _path: 1 }, query.budget, 'node' in range)) {
        const image = decode(doc);
        const node = options.logicalBase === '/' ? image : { ...image,
          $path: image.$path === '/' ? options.logicalBase : `${options.logicalBase}${image.$path}` };
        charge(node, query, cost);
        if (test === undefined || test(mapNodeForSift(node), work)) matches.push(node);
      }
      cost.exprWork = work.used;
      return { ...scanPage(matches, sort, node => node.$path, scope, query.after, query.limit, () => check(query.budget)), cost };
    }

    async function collectJournal(query: ScanQuery<JournalRange | DecisionRange>, scope: string): Promise<ScanResult<JournalCommit>> {
      const result = await scanJournalRecords(context.journal, query, scope);
      check(query.budget);
      return result;
    }

    async function collectMetadata(query: ScanQuery<MetadataRange>, scope: string): Promise<ScanResult<MetadataResult>> {
      const result = await scanJournalMetadata(context.journal, query, scope);
      check(query.budget);
      return result;
    }

    /** Project component tags on the server so activation never receives authored payload bodies. */
    async function collectCensus(query: StoreCensusQuery): Promise<ScanResult<StoreCensusNode>> {
      const cost = { nodes: 0, bytes: 0, exprWork: 0 };
      const items: StoreCensusNode[] = [];
      let last: string | undefined;
      let lastKey: Buffer | undefined;
      let physicalBytes = 0;
      const load = (limit: number, allowance: number, before?: string) => nodes.find<CensusImage>(
        last === undefined && before === undefined ? {} : { _path: {
          ...(last === undefined ? {} : { $gt: last }), ...(before === undefined ? {} : { $lt: before }),
        } }, {
          projection: { _id: 0, bytes: { $bsonSize: CENSUS_PROJECTION },
            image: { $cond: [{ $lte: [{ $bsonSize: CENSUS_PROJECTION }, allowance] }, CENSUS_PROJECTION, null] } },
          sort: { _path: 1 }, batchSize: limit, limit, singleBatch: true,
          timeoutMS: timeoutMS(query.budget), timeoutMode: 'cursorLifetime', collation: { locale: 'simple' },
        }).toArray();
      for (;;) {
        const batch = await load(101, Math.floor((context.journal.physicalLimit - physicalBytes) / 101));
        if (batch.length === 0) {
          items.sort((a, b) => { check(query.budget); return comparePaths(a.$path, b.$path); });
          check(query.budget);
          return { items, cost };
        }
        // Reserve every transferred image before a larger row retries; later batch rows remain retained.
        for (const projected of batch) if (projected.image !== null) physicalBytes += projected.bytes;
        for (let index = 0; index < batch.length; index++) {
          const projected = batch[index];
          let doc = projected.image;
          if (doc === null) {
            let before: string | undefined;
            for (let next = index + 1; next < batch.length; next++) {
              const successor = batch[next].image;
              if (successor !== null) { before = successor._path; break; }
            }
            const individual = await load(1, context.journal.physicalLimit - physicalBytes, before);
            if (individual.length !== 1) throw new KernelError('INVALID', 'Mongo census node disappeared during reconstruction');
            doc = individual[0].image;
            if (doc === null) throw new KernelError('BUDGET', 'Mongo census metadata allowance exceeded');
            physicalBytes += individual[0].bytes;
          }
          const key = Buffer.from(doc._path);
          if (lastKey !== undefined && Buffer.compare(key, lastKey) <= 0)
            throw new KernelError('INVALID', 'Mongo census order changed during reconstruction');
          const image = fromStorageKeys(doc);
          const path = options.logicalBase === '/' ? doc._path : doc._path === '/' ? options.logicalBase : `${options.logicalBase}${doc._path}`;
          const components = Object.fromEntries(Object.entries(doc.components).map(([key, value]) =>
            [key, value === null ? null : fromStorageKeys(value)]));
          const chain = decodeChainNode({ ...image, ...components,
            $path: path, $id: doc._tid, $type: doc._type });
          const item = { $path: path, $id: doc._tid, $pos: doc._pos, chain };
          charge(item, query, cost);
          items.push(item);
          last = doc._path;
          lastKey = key;
        }
      }
    }

    function scan(query: StoreCensusQuery): Promise<ScanResult<StoreCensusNode>>;
    function scan(query: ScanQuery<ScanRange>): Promise<ScanResult<StoredNode>>;
    function scan(query: ScanQuery<JournalRange | DecisionRange>): Promise<ScanResult<JournalCommit>>;
    function scan(query: ScanQuery<JournalPositionHeadRange>): Promise<ScanResult<JournalPositionHead>>;
    function scan(query: ScanQuery<JournalIntakeHeadRange>): Promise<ScanResult<JournalIntakeHead>>;
    function scan(query: ScanQuery<DecisionMetadataRange>): Promise<ScanResult<DecisionMetadata>>;
    async function scan(query: ScanQuery<ScanRange | JournalRange | DecisionRange | MetadataRange | StoreCensusRange>) {
      query = { ...query, budget: { ...query.budget, deadline: Math.min(query.budget.deadline, Date.now() + DEFAULT_LIMITS.queryMs) } };
      check(query.budget);
      const release = context.pin();
      const range = query.range;
      const scope = stableJson([context.owner.domain, 'journal' in range ? { journal: range.journal, after: range.after } : range, query.where, query.sort]);
      try {
        if ('census' in range) return await collectCensus({ range, budget: query.budget });
        if ('journalHead' in range || 'decisionMetadata' in range) return await collectMetadata({ ...query, range }, scope);
        if ('journal' in range || 'decision' in range) {
          const floor = context.journalFloor();
          if ('journal' in range && range.after !== undefined && floor !== undefined && comparePositions(range.after, floor) < 0)
            return { items: [], retainedFrom: floor, cost: { nodes: 0, bytes: 0, exprWork: 0 } };
          const result = await collectJournal({ ...query, range }, scope);
          return floor === undefined ? result : { ...result, retainedFrom: floor };
        }
        return await collectNodes({ ...query, range }, scope);
      } catch (error) { databaseError(error); }
      finally { await release(); }
    }

    const reported = new Map<string, ReportedDocument>();

    /** Re-read only the reported physical keys; prior images remain explicitly unknown. */
    async function readExternal(paths: readonly string[], budget: Budget): Promise<ScanResult<ExternalCandidate>> {
      available();
      const cost = { nodes: 0, bytes: 0, exprWork: 0 };
      let physicalBytes = 0;
      const items: ExternalCandidate[] = [];
      for (const path of paths) {
        const report = reported.get(path);
        check(budget);
        const inspectionBytes = BSON.calculateObjectSize({ bytes: new Int32(0) });
        if (inspectionBytes > context.journal.physicalLimit - physicalBytes)
          throw new KernelError('BUDGET', 'Mongo external image inspection allowance exceeded');
        const key = report === undefined ? { _path: localPath(options.logicalBase, path) } : report.documentKey;
        const selected = await nodes.findOne<{ readonly bytes: number }>({ ...key }, {
          projection: { _id: 0, bytes: { $bsonSize: '$$ROOT' } },
          timeoutMS: Math.ceil(budget.deadline - Date.now()), collation: { locale: 'simple' },
        });
        if (selected !== null) {
          physicalBytes += inspectionBytes;
          if (!Number.isSafeInteger(selected.bytes) || selected.bytes < 5)
            throw new KernelError('INVALID', 'Malformed Mongo external image size');
          if (selected.bytes > context.journal.physicalLimit - physicalBytes)
            throw new KernelError('BUDGET', 'Mongo external image allowance exceeded');
        }
        const image = selected === null ? null : await nodes.findOne({ ...key, $expr: {
          $and: [
            { $eq: [{ $bsonSize: '$$ROOT' }, selected.bytes] },
            { $lte: [{ $bsonSize: '$$ROOT' }, context.journal.physicalLimit - physicalBytes] },
          ],
        } }, { timeoutMS: Math.ceil(budget.deadline - Date.now()), collation: { locale: 'simple' } });
        if (selected !== null && image === null)
          throw new KernelError('CONFLICT', 'Mongo external image changed during bounded selection');
        let after: StoredNode | null = null;
        if (image !== null) {
          physicalBytes += selected!.bytes;
          if (typeof image._path !== 'string' || typeof image._tid !== 'string' || typeof image._type !== 'string')
            throw new KernelError('INVALID', 'Malformed Mongo external stored identity');
          const logical = options.logicalBase === '/' ? image._path : image._path === '/' ? options.logicalBase
            : `${options.logicalBase}${image._path}`;
          if (logical !== path || report !== undefined && image._tid !== report.id)
            throw new KernelError('INVALID', 'Mongo external image differs from its reported identity');
          after = { ...decode(image), $path: logical };
          decodeChainNode(after);
          charge(after, { range: { node: path }, budget }, cost);
        } else {
          cost.nodes++;
        }
        if (cost.nodes > budget.nodes) throw new KernelError('BUDGET', 'Mongo external node allowance exceeded');
        if (after !== null || report !== undefined)
          items.push({ path, id: after === null ? report!.id : after.$id, before: 'unknown', after });
        reported.delete(path);
      }
      check(budget);
      return { items, cost };
    }

    const watch = context.watch;
    if (options.external === 'trusted' && watch === undefined)
      throw new KernelError('INVALID', 'Mongo trusted collection lacks its native observer owner');
    const store: MongoStore = {
      domain: context.owner.domain, transactionOwner: context.owner, scan,
      ...context.blobCarrier, blobJournal: context.blobJournal, ...context.blobArchives,
      ...(options.external !== 'trusted' || watch === undefined ? {} : {
        external: (signal?: AbortSignal) => createMongoReporter(watch, document => reported.set(document.path, document), signal),
        readExternal,
      }),
      journalRetentionMs: options.journalRetentionMs,
      backfill: createBackfill(nodes, context.backfill, options.logicalBase, available, context.pin),
      get maintenancePending() { return context.maintenancePending(); },
      get journalRetentionBoundary() { return context.retentionBoundary(); },
      get journalRetentionClock() { return context.retentionClock(); },
      close() {
        if (closing !== undefined) return closing;
        closed = true;
        return closing = context.close(store);
      },
      async commit(commit) {
        available();
        await context.owner.commit(commit, [{ store, writes: commit.writes }]);
      },
    };
    return store;
}

/** The standalone wrapper binds its real first commit identity and preserves its durable fence. */
export async function createMongoStore(options: MongoStoreOptions): Promise<MongoStore> {
  const { openStandaloneMongoStore } = await import('#owner');
  return openStandaloneMongoStore(options);
}
