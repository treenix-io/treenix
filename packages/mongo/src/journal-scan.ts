import { type Collection, type Document, type Filter, type Sort, type WithId } from 'mongodb';
import { comparePaths, isChildPath } from '@treenx/core';
import { KernelError } from '@treenx/core/errors';
import { createSiftTest } from '@treenx/core/kernel/expr';
import { readJournalImages } from '@treenx/core/kernel/journal';
import { comparePositions } from '@treenx/core/kernel/position';
import { mapNodeForSift } from '@treenx/core/kernel/store/keys';
import { scanPage } from '@treenx/core/kernel/store/scan';
import {
  DEFAULT_LIMITS,
  type DecisionMetadata,
  type DecisionMetadataRange,
  type DecisionRange,
  type JournalCommit,
  type JournalEntry,
  type JournalIntakeHead,
  type JournalIntakeHeadRange,
  type JournalPositionHead,
  type JournalPositionHeadRange,
  type JournalRange,
  type ScanQuery,
  type ScanResult,
} from '@treenx/core/kernel/types';
import { stableJson } from '@treenx/core/util/stable-json';
import {
  chargeJournal,
  journalIdentity,
  journalTimeout,
  readJournalEntry,
  readJournalHeader,
  readInlineHead,
  readJournalPosition,
  readJournalRecord,
  readJournalVisibility,
  JOURNAL_ENTRY_PROJECTION,
  FRAGMENT_HEAD_PROJECTION,
  type InlineJournalHead,
  type JournalCollections,
  type JournalEntryIndex,
  type JournalHead,
} from '#journal-records';
import type { JournalReadLedger } from '#journal-units';

type MetadataRange = JournalPositionHeadRange | JournalIntakeHeadRange | DecisionMetadataRange;
type MetadataResult = JournalPositionHead | JournalIntakeHead | DecisionMetadata;
type JournalQuery = ScanQuery<JournalRange | DecisionRange | MetadataRange>;
const FRAGMENT_PROJECTION = FRAGMENT_HEAD_PROJECTION;
const ENTRY_PROJECTION = JOURNAL_ENTRY_PROJECTION;

/** Single bounded batches continue through short wire pages until an actual empty page. */
async function* pages<T extends Document>(
  collection: Collection<T>,
  filter: (last: WithId<T> | undefined) => Filter<T>,
  sort: Sort,
  query: JournalQuery,
  projection?: Document,
): AsyncGenerator<WithId<T>> {
  let last: WithId<T> | undefined;
  for (;;) {
    const batch = await collection
      .find(filter(last), {
        sort,
        projection,
        limit: 101,
        batchSize: 101,
        singleBatch: true,
        timeoutMS: journalTimeout(query.budget),
        timeoutMode: 'cursorLifetime',
        collation: { locale: 'simple' },
      })
      .toArray();
    if (batch.length === 0) return;
    for (const item of batch) yield item;
    last = batch[batch.length - 1];
  }
}

/** One scan owns both ledgers; page, header, entry and compact-anchor work never renews its budget. */
export function journalLedger(
  collections: JournalCollections,
  query: JournalQuery,
): JournalReadLedger {
  return {
    budget: query.budget,
    physicalLimit: collections.physicalLimit,
    physicalBytes: 0,
    logicalBytes: 0,
  };
}

/** Individual short batches keep cumulative metadata bounded without a live cursor cleanup phase. */
async function* inlinePages(
  collections: JournalCollections,
  filter: (last: InlineJournalHead | undefined) => Document,
  sort: Sort,
  ledger: JournalReadLedger,
): AsyncGenerator<InlineJournalHead> {
  let last: InlineJournalHead | undefined;
  for (;;) {
    const loaded = await readInlineHead(collections, filter(last), ledger, sort);
    if (loaded === null) return;
    yield loaded;
    last = loaded;
  }
}

/** Physical identity predicates use scalar opId fields for old inline records and fixed hashes for fragments. */
function decisions(decision: DecisionRange['decision']): Document {
  return {
    caller: decision.caller,
    $or: [
      {
        'decision.opId.epoch': decision.opId.epoch,
        'decision.opId.time': decision.opId.time,
        'decision.opId.nonce': decision.opId.nonce,
      },
      {
        'anchorDecision.opId.epoch': decision.opId.epoch,
        'anchorDecision.opId.time': decision.opId.time,
        'anchorDecision.opId.nonce': decision.opId.nonce,
      },
    ],
  };
}

/** Combine the latest actual old/inline record and fragmented record without touching node payloads. */
async function latest(
  collections: JournalCollections,
  query: JournalQuery,
  ledger: JournalReadLedger,
  mode: 'position' | 'intake' | 'decision',
): Promise<JournalHead | undefined> {
  const range = query.range;
  const decision =
    'decisionMetadata' in range
      ? range.decisionMetadata
      : 'decision' in range
        ? range.decision
        : undefined;
  const inline = await readInlineHead(
    collections,
    decision === undefined
      ? mode === 'intake'
        ? { intake: { $exists: true } }
        : {}
      : decisions(decision),
    ledger,
    { 'pos.instance': -1, 'pos.epoch': -1, 'pos.seq': -1 },
  );
  const fragment = await collections.headers.findOne(
    decision === undefined
      ? mode === 'intake'
        ? { hasIntake: true }
        : {}
      : {
          callerIdentity: journalIdentity(decision.caller),
          $or: [
            { decisionIdentity: journalIdentity(decision.opId) },
            { anchorIdentity: journalIdentity(decision.opId) },
          ],
        },
    {
      projection: FRAGMENT_PROJECTION,
      sort: { _epoch: -1, _seq: -1 },
      timeoutMS: journalTimeout(query.budget),
      collation: { locale: 'simple' },
    },
  );
  if (fragment === null) return inline === null ? undefined : inline;
  if (inline === null) return fragment;
  return comparePositions(await readJournalPosition(collections, fragment, ledger), inline.pos) > 0
    ? fragment
    : inline;
}

/** Return exactly the canonical metadata projection, retaining complete decisions and outcomes. */
export async function scanJournalMetadata(
  collections: JournalCollections,
  query: ScanQuery<MetadataRange>,
  scope: string,
): Promise<ScanResult<MetadataResult>> {
  const ledger = journalLedger(collections, query);
  const mode = 'decisionMetadata' in query.range ? 'decision' : query.range.journalHead;
  const root = await latest(collections, query, ledger, mode);
  const items: MetadataResult[] = [];
  const work = { limit: query.budget.exprWork, used: 0 };
  if (root !== undefined) {
    const header = await readJournalHeader(collections, root, ledger, mode);
    const item: MetadataResult = header;
    chargeJournal(item, ledger);
    const test =
      query.where === undefined ? undefined : createSiftTest(query.where, DEFAULT_LIMITS);
    if (test === undefined || test(mapNodeForSift(item), work)) items.push(item);
  }
  if (root !== undefined && query.budget.nodes < 1)
    throw new KernelError('BUDGET', 'Mongo metadata node budget exceeded');
  return {
    ...scanPage(
      items,
      query.sort ?? [],
      (item) => stableJson(item.pos),
      scope,
      query.after,
      query.limit,
      () => {
        journalTimeout(query.budget);
      },
    ),
    cost: { nodes: root === undefined ? 0 : 1, bytes: ledger.logicalBytes, exprWork: work.used },
  };
}

/** Select visibility first; direct members and compact ancestors retain their canonical representations. */
export async function scanJournalRecords(
  collections: JournalCollections,
  query: ScanQuery<JournalRange | DecisionRange>,
  scope: string,
): Promise<ScanResult<JournalCommit>> {
  const ledger = journalLedger(collections, query);
  const work = { limit: query.budget.exprWork, used: 0 };
  const records: JournalCommit[] = [];
  let nodes = 0;
  const charge = (record: JournalCommit) => {
    if (++nodes > query.budget.nodes)
      throw new KernelError('BUDGET', 'Mongo journal node budget exceeded');
    chargeJournal(record, ledger);
  };
  const test = query.where === undefined ? undefined : createSiftTest(query.where, DEFAULT_LIMITS);
  if ('decision' in query.range) {
    const root = await latest(collections, query, ledger, 'decision');
    if (root !== undefined) {
      const record = await readJournalRecord(collections, root, ledger);
      nodes++;
      if (test === undefined || test(mapNodeForSift(record), work)) records.push(record);
    }
  } else {
    const range = query.range;
    const grouped = new Map<string, JournalEntryIndex[]>();
    const heads = new Map<string, JournalHead>();
    const after = range.after;
    const selected: JournalEntryIndex[] = [];
    const visible = new Map<string, Awaited<ReturnType<typeof readJournalVisibility>>>();
    for await (const indexed of pages(
      collections.entries,
      (last) => ({
        owner: collections.owner,
        ...(last === undefined
          ? {}
          : {
              $or: [
                { epoch: { $gt: last.epoch } },
                { epoch: last.epoch, seq: { $gt: last.seq } },
                { epoch: last.epoch, seq: last.seq, ordinal: { $gt: last.ordinal } },
              ],
            }),
      }),
      { epoch: 1, seq: 1, ordinal: 1 },
      query,
      ENTRY_PROJECTION,
    )) {
      if (++work.used > work.limit)
        throw new KernelError('BUDGET', 'Mongo journal metadata work exceeded');
      const visibility = await readJournalVisibility(collections, indexed, ledger);
      visible.set(indexed._id, visibility);
      if (after !== undefined && comparePositions(visibility.address.pos, after) <= 0) continue;
      if (
        visibility.path !== range.journal &&
        !isChildPath(range.journal, visibility.path, false) &&
        (visibility.from === undefined ||
          (visibility.from !== range.journal &&
            !isChildPath(range.journal, visibility.from, false)))
      )
        continue;
      if (range.accept !== undefined && !range.accept(visibility)) continue;
      selected.push(indexed);
    }
    if (range.accept !== undefined && range.take !== undefined) {
      if (!Number.isSafeInteger(range.take) || range.take < 1)
        throw new KernelError('INVALID', 'History limit must be positive');
      selected.sort(
        (a, b) =>
          a.epoch - b.epoch ||
          a.seq - b.seq ||
          comparePaths(visible.get(a._id)!.address.id, visible.get(b._id)!.address.id),
      );
      selected.splice(range.take);
    }
    for (const indexed of selected) {
      const prior = grouped.get(indexed.position);
      if (prior === undefined) grouped.set(indexed.position, [indexed]);
      else prior.push(indexed);
    }
    const head = async (position: string): Promise<JournalHead> => {
      const cached = heads.get(position);
      if (cached !== undefined) return cached;
      const inline = await readInlineHead(collections, { _position: position }, ledger);
      const root =
        inline ??
        (await collections.headers.findOne(
          { _position: position },
          {
            projection: FRAGMENT_PROJECTION,
            timeoutMS: journalTimeout(query.budget),
            collation: { locale: 'simple' },
          },
        ));
      if (root === null)
        throw new KernelError('INVALID', 'Journal visibility has no canonical root');
      heads.set(position, root);
      return root;
    };
    for (const [position, members] of grouped) {
      const root = await head(position);
      if (range.accept === undefined) {
        const record = await readJournalRecord(collections, root, ledger);
        nodes++;
        if (test === undefined || test(mapNodeForSift(record), work)) records.push(record);
        continue;
      }
      const header = await readJournalHeader(collections, root, ledger);
      const entries: JournalEntry[] = [];
      for (const member of members) {
        const anchors: JournalCommit[] = [];
        let current: JournalEntryIndex | null = member;
        while (current !== null) {
          const currentRoot = await head(current.position);
          const currentHeader = await readJournalHeader(collections, currentRoot, ledger);
          const visibility = await readJournalVisibility(collections, current, ledger);
          const entry = await readJournalEntry(
            collections,
            currentRoot,
            current,
            ledger,
            visibility,
          );
          const anchor: JournalCommit = { ...currentHeader, entries: [entry] };
          charge(anchor);
          anchors.push(anchor);
          if (entry.change.t !== 'update' || entry.change.after !== undefined) {
            if (
              current !== member ||
              entry.change.t !== 'reconcile' ||
              entry.change.before !== undefined
            )
              break;
          }
          current = await collections.entries.findOne(
            {
              owner: collections.owner,
              idIdentity: member.idIdentity,
              $or: [
                { epoch: { $lt: current.epoch } },
                { epoch: current.epoch, seq: { $lt: current.seq } },
              ],
            },
            {
              projection: ENTRY_PROJECTION,
              sort: { epoch: -1, seq: -1, ordinal: -1 },
              timeoutMS: journalTimeout(query.budget),
              collation: { locale: 'simple' },
            },
          );
        }
        const images = readJournalImages(
          anchors.reverse(),
          (await readJournalVisibility(collections, member, ledger)).address,
        );
        const own = anchors.at(-1)?.entries[0];
        if (own === undefined)
          throw new KernelError('INVALID', 'History target has no journal entry');
        entries.push({
          ...own,
          change:
            own.change.t === 'update'
              ? {
                  ...own.change,
                  after:
                    images.after === null
                      ? (() => {
                          throw new KernelError('INVALID', 'Journal update has no after-image');
                        })()
                      : images.after,
                }
              : own.change.t === 'reconcile' && images.before !== 'unknown'
                ? { ...own.change, before: images.before }
                : own.change,
        });
      }
      const record: JournalCommit = { ...header, entries };
      charge(record);
      if (test === undefined || test(mapNodeForSift(record), work)) records.push(record);
    }
    // Decision-only and intake-only roots have no entry index, but remain real journal members at the root range.
    if (range.journal === '/' && range.accept === undefined) {
      for await (const empty of inlinePages(
        collections,
        (last) => ({
          _position: { $exists: true },
          entries: { $size: 0 },
          ...(last === undefined
            ? {}
            : {
                $or: [
                  { 'pos.epoch': { $gt: last.pos.epoch } },
                  { 'pos.epoch': last.pos.epoch, 'pos.seq': { $gt: last.pos.seq } },
                ],
              }),
        }),
        { 'pos.epoch': 1, 'pos.seq': 1 },
        ledger,
      )) {
        if (after !== undefined && comparePositions(empty.pos, after) <= 0) continue;
        const record = await readJournalRecord(collections, empty, ledger);
        nodes++;
        if (test === undefined || test(mapNodeForSift(record), work)) records.push(record);
      }
      for await (const empty of pages(
        collections.headers,
        (last) => ({
          entryCount: 0,
          ...(last === undefined
            ? {}
            : {
                $or: [
                  { _epoch: { $gt: last._epoch } },
                  { _epoch: last._epoch, _seq: { $gt: last._seq } },
                ],
              }),
        }),
        { _epoch: 1, _seq: 1 },
        query,
        FRAGMENT_PROJECTION,
      )) {
        const pos = await readJournalPosition(collections, empty, ledger);
        if (after !== undefined && comparePositions(pos, after) <= 0) continue;
        const record = await readJournalRecord(collections, empty, ledger);
        nodes++;
        if (test === undefined || test(mapNodeForSift(record), work)) records.push(record);
      }
    }
  }
  if (nodes > query.budget.nodes)
    throw new KernelError('BUDGET', 'Mongo journal node budget exceeded');
  return {
    ...scanPage(
      records,
      query.sort ?? [
        ['pos.epoch', 1],
        ['pos.seq', 1],
      ],
      (record) => stableJson(record.pos),
      scope,
      query.after,
      query.limit,
      () => {
        journalTimeout(query.budget);
      },
    ),
    cost: { nodes, bytes: ledger.logicalBytes, exprWork: work.used },
  };
}
