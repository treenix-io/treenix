import { randomUUID } from 'node:crypto';
import { KernelError } from '#errors';
import { createBlobHolds, type BlobHoldSnapshot } from '#kernel/blob-holds';
import { createBlobArchives } from '#kernel/blob-archives';
import { blobIds, type BlobReferenceWork } from '#kernel/blob-references';
import { decodeChainNode } from '#kernel/chain-index';
import { comparePositions } from '#kernel/position';
import { assertStoreCommit } from '#kernel/store/commit';
import type { ExprWork } from '#kernel/eval';
import { createSiftTest } from '#kernel/expr';
import {
  DEFAULT_LIMITS,
  type Budget,
  type DecisionRange,
  type JournalCommit,
  type JournalRange,
  type JournalPositionHeadRange,
  type JournalIntakeHeadRange,
  type DecisionMetadataRange,
  type JournalPositionHead,
  type JournalIntakeHead,
  type DecisionMetadata,
  type BlobArchiveMutation,
  type StoreCensusQuery,
  type StoreCensusRange,
  type StoreCensusNode,
  type OpId,
  type ScanQuery,
  type ScanRange,
  type ScanResult,
  type Store,
  type StoreCommit,
  type StoredNode,
} from '#kernel/types';
import { stableJson } from '#util/stable-json';
import { transferImageDigest } from '#kernel/transfer-image';
import { mapNodeForSift } from './keys';
import { createJournalIndex } from '#kernel/store/journal-index';
import { treeEnsure, treeNavigate, treeRemove, treeWalk, type TreeNode } from './nested-map';
import { scanPage } from './scan';

export interface MemoryStoreOptions {
  domain: string;
  /** An Fs shadow delegates physical canonical maintenance to its owning adapter. */
  readonly externalMaintenance?: boolean;
  beforeRecord?(): void;
  readonly recovered?: {
    readonly nodes: readonly StoredNode[];
    readonly commits: readonly StoreCommit[];
    readonly writerEpoch: number;
    readonly blobHolds?: BlobHoldSnapshot;
    readonly blobArchives?: {
      readonly units: Iterable<BlobArchiveMutation>;
      readonly budget: () => Budget;
    };
    readonly journalRetentionBoundary?: number;
  };
}

export interface MemoryStore extends Store {
  /** Captures the accepted sparse hold metadata for durable snapshot publication. */
  blobSnapshot(): BlobHoldSnapshot;
  /** Prepares one transaction's hold and journal updates before its publisher runs. */
  stageCommit(input: StoreCommit, work?: BlobReferenceWork): () => void;
  /** Restores validated archive units before the owning adapter opens admission. */
  loadBlobArchives(
    units: Iterable<BlobArchiveMutation>,
    budget: () => Budget,
    work?: BlobReferenceWork,
  ): void;
  close(): void;
}

const decisionKey = (caller: string, opId: OpId) => stableJson([caller, opId]);

/** Creates an in-memory Store whose node, journal, and decision state publish together. */
export function createMemoryStore(options: MemoryStoreOptions): MemoryStore {
  const root: TreeNode<StoredNode> = { children: new Map() };
  let journalIndex = createJournalIndex();
  const decisions = new Map<string, JournalCommit>();
  let positionHead: JournalPositionHead | undefined, intakeHead: JournalIntakeHead | undefined;
  let writerEpoch = 0;
  const recoveredBudget: Budget = {
    nodes: DEFAULT_LIMITS.readNodes,
    bytes: DEFAULT_LIMITS.readBytes,
    exprWork: DEFAULT_LIMITS.exprWork,
    deadline: Date.now() + DEFAULT_LIMITS.queryMs,
  };
  const recoveredWork = { exprWork: 0 };
  const recoveredHolds =
    options.recovered === undefined
      ? undefined
      : (options.recovered.blobHolds ?? {
          nodes: options.recovered.nodes.flatMap((node) => {
            const ids = blobIds(node, recoveredBudget, recoveredWork);
            return ids.length === 0 ? [] : [{ path: node.$path, ids }];
          }),
          history: options.recovered.commits.flatMap((commit) => {
            const after = new Map(
              commit.writes.map((write) => [
                write.path,
                write.node === null ? [] : blobIds(write.node, recoveredBudget, recoveredWork),
              ]),
            );
            return commit.record.entries.flatMap((entry) => {
              const ids = new Set(blobIds(entry.change, recoveredBudget, recoveredWork));
              for (const id of after.get(entry.path) ?? []) ids.add(id);
              return ids.size === 0
                ? []
                : [
                    {
                      pos: commit.pos,
                      id: entry.id,
                      acceptedAt: commit.acceptedAt,
                      ...(commit.acceptedAt === undefined || commit.journalRetentionMs === undefined
                        ? {}
                        : { retainUntil: commit.acceptedAt + commit.journalRetentionMs }),
                      ids: [...ids],
                    },
                  ];
            });
          }),
          released: [],
          acceptedAt: options.recovered.commits.reduce(
            (clock, commit) => Math.max(clock, commit.acceptedAt ?? 0),
            0,
          ),
        });
  const holds = createBlobHolds(recoveredHolds);
  const archives = createBlobArchives(options.recovered?.blobArchives);
  let acceptedAt = recoveredHolds?.acceptedAt ?? 0;
  let journalBoundary = options.recovered?.journalRetentionBoundary;
  let closed = false;

  if (options.recovered !== undefined) {
    for (const node of options.recovered.nodes)
      treeEnsure(root, node.$path).data = structuredClone(node);
    for (const commit of options.recovered.commits) {
      if (commit.record.maintenance !== undefined)
        journalBoundary = Math.max(
          journalBoundary ?? commit.record.maintenance.journalBefore,
          commit.record.maintenance.journalBefore,
        );
      if (commit.blobArchive !== undefined) {
        if (options.recovered.blobArchives === undefined)
          throw new KernelError('INVALID', 'Recovered archive execution budget is missing');
        archives.stageBatch(commit.blobArchive, options.recovered.blobArchives.budget())();
      }
      const record = structuredClone(commit.record);
      const accepted = journalIndex.prepare(record, commit.writes, commit);
      accepted.publish();
      publishHeads(accepted.record);
      if (record.decision !== undefined)
        decisions.set(decisionKey(record.caller, record.decision.opId), accepted.record);
      if (record.anchorDecision !== undefined)
        decisions.set(decisionKey(record.caller, record.anchorDecision.opId), accepted.record);
    }
    writerEpoch = options.recovered.writerEpoch;
  }

  /** Retain only the projected fields of actual committed heads, never their node images. */
  function publishHeads(record: JournalCommit): void {
    if (positionHead === undefined || comparePositions(record.pos, positionHead.pos) > 0)
      positionHead = { pos: record.pos };
    if (
      record.intake !== undefined &&
      (intakeHead === undefined || comparePositions(record.pos, intakeHead.pos) > 0)
    )
      intakeHead = { pos: record.pos, intake: record.intake };
  }

  /** Refuse IO after the owner releases this storage instance. */
  function available(): void {
    if (closed) throw new KernelError('UNAVAILABLE', 'Memory Store is closed');
  }

  function check(budget: Budget): void {
    if (Date.now() > budget.deadline) throw new KernelError('BUDGET', 'Scan deadline exceeded');
  }

  function* candidates(range: ScanRange, budget: Budget): Iterable<StoredNode> {
    const path =
      'node' in range ? range.node : 'children' in range ? range.children : range.subtree;
    const start = treeNavigate(root, path);
    if (start === undefined) return;
    if ('node' in range) {
      if (start.data !== undefined) yield start.data;
      return;
    }
    if ('children' in range) {
      for (const child of start.children.values()) {
        check(budget);
        if (child.data !== undefined) yield child.data;
      }
      return;
    }
    for (const node of treeWalk(start)) {
      check(budget);
      if (node.data !== undefined) yield node.data;
    }
  }

  /** Applies filters and charges every inspected item to the scan's shared cost ledger. */
  function collect<T extends object>(
    items: Iterable<T>,
    query: ScanQuery<unknown>,
    cost = { nodes: 0, bytes: 0, exprWork: 0 },
  ): T[] {
    const result: T[] = [];
    const work: ExprWork = { limit: query.budget.exprWork, used: cost.exprWork };
    const test =
      query.where === undefined ? undefined : createSiftTest(query.where, DEFAULT_LIMITS);
    check(query.budget);
    for (const item of items) {
      check(query.budget);
      cost.nodes++;
      if (cost.nodes > query.budget.nodes)
        throw new KernelError('BUDGET', 'Scan node budget exceeded');
      cost.bytes += Buffer.byteLength(JSON.stringify(item));
      if (cost.bytes > query.budget.bytes)
        throw new KernelError('BUDGET', 'Scan byte budget exceeded');
      if (test === undefined || test(mapNodeForSift(item), work)) result.push(item);
    }
    check(query.budget);
    cost.exprWork = work.used;
    return result;
  }

  /** Selects bounded node, journal, or decision results and reports inspected scan cost. */
  function scan(query: StoreCensusQuery): Promise<ScanResult<StoreCensusNode>>;
  function scan(query: ScanQuery<ScanRange>): Promise<ScanResult<StoredNode>>;
  function scan(query: ScanQuery<JournalRange | DecisionRange>): Promise<ScanResult<JournalCommit>>;
  function scan(
    query: ScanQuery<JournalPositionHeadRange>,
  ): Promise<ScanResult<JournalPositionHead>>;
  function scan(query: ScanQuery<JournalIntakeHeadRange>): Promise<ScanResult<JournalIntakeHead>>;
  function scan(query: ScanQuery<DecisionMetadataRange>): Promise<ScanResult<DecisionMetadata>>;
  async function scan(
    query: ScanQuery<
      | ScanRange
      | StoreCensusRange
      | JournalRange
      | DecisionRange
      | JournalPositionHeadRange
      | JournalIntakeHeadRange
      | DecisionMetadataRange
    >,
  ): Promise<
    | ScanResult<StoreCensusNode>
    | ScanResult<StoredNode>
    | ScanResult<JournalCommit>
    | ScanResult<JournalPositionHead>
    | ScanResult<JournalIntakeHead>
    | ScanResult<DecisionMetadata>
  > {
    available();
    const range = query.range;
    if ('census' in range) {
      function* metadata(): Iterable<StoreCensusNode> {
        for (const node of candidates({ subtree: '/' }, query.budget))
          yield { $path: node.$path, $id: node.$id, $pos: node.$pos, chain: decodeChainNode(node) };
      }
      const cost = { nodes: 0, bytes: 0, exprWork: 0 };
      return { items: collect(metadata(), { range, budget: query.budget }, cost), cost };
    }
    const scopedRange = 'journal' in range ? { journal: range.journal, after: range.after } : range;
    const scope = stableJson([options.domain, scopedRange, query.where, query.sort]);
    const deadline = () => check(query.budget);
    if ('journalHead' in range || 'decisionMetadata' in range) {
      let items: readonly (JournalPositionHead | JournalIntakeHead | DecisionMetadata)[];
      if ('journalHead' in range) {
        const head = range.journalHead === 'position' ? positionHead : intakeHead;
        items = head === undefined ? [] : [head];
      } else {
        const record = decisions.get(
          decisionKey(range.decisionMetadata.caller, range.decisionMetadata.opId),
        );
        items =
          record === undefined
            ? []
            : [
                {
                  pos: record.pos,
                  caller: record.caller,
                  ...(record.decision === undefined ? {} : { decision: record.decision }),
                  ...(record.anchorDecision === undefined
                    ? {}
                    : { anchorDecision: record.anchorDecision }),
                },
              ];
      }
      const cost = { nodes: 0, bytes: 0, exprWork: 0 };
      return {
        ...scanPage(
          collect(items, query, cost),
          query.sort ?? [],
          (item) => stableJson(item.pos),
          scope,
          query.after,
          query.limit,
          deadline,
        ),
        cost,
      };
    }
    if ('journal' in range || 'decision' in range) {
      let records: Iterable<JournalCommit>;
      if ('decision' in range) {
        const latest = decisions.get(decisionKey(range.decision.caller, range.decision.opId));
        records = latest === undefined ? [] : [latest];
      } else {
        const selected = journalIndex.select(range, query.budget);
        const records = collect(selected.records, query, selected.cost);
        const page = scanPage(
          records,
          query.sort ?? [
            ['pos.epoch', 1],
            ['pos.seq', 1],
          ],
          (record) => stableJson(record.pos),
          scope,
          query.after,
          query.limit,
          deadline,
        );
        return { ...page, cost: selected.cost };
      }
      const cost = { nodes: 0, bytes: 0, exprWork: 0 };
      return {
        ...scanPage(
          collect(records, query, cost),
          query.sort ?? [
            ['pos.epoch', 1],
            ['pos.seq', 1],
          ],
          (record) => stableJson(record.pos),
          scope,
          query.after,
          query.limit,
          deadline,
        ),
        cost,
      };
    }
    const cost = { nodes: 0, bytes: 0, exprWork: 0 };
    return {
      ...scanPage(
        collect(candidates(range, query.budget), query, cost),
        query.sort ?? [],
        (node) => node.$path,
        scope,
        query.after,
        query.limit,
        deadline,
      ),
      cost,
    };
  }

  /** Stage one owning transaction before its durable adapter publishes any effect. */
  function stageCommit(input: StoreCommit, work?: BlobReferenceWork): () => void {
    available();
    assertStoreCommit(input);
    const referenceWork = work ?? { exprWork: 0 };
    const allowance = input.maintenanceLimits?.budget ?? {
      nodes: DEFAULT_LIMITS.readNodes,
      bytes: DEFAULT_LIMITS.readBytes,
      exprWork: DEFAULT_LIMITS.exprWork,
      deadline: Date.now() + DEFAULT_LIMITS.queryMs,
    };
    if (input.transferBefore !== undefined)
      for (const original of input.transferBefore) {
        referenceWork.exprWork += 1 + original.path.length;
        if (referenceWork.exprWork > allowance.exprWork || Date.now() > allowance.deadline)
          throw new KernelError('BUDGET', 'Transfer source validation exceeded its allowance');
        const node = treeNavigate(root, original.path)?.data;
        if (
          node !== undefined &&
          (node.$id !== original.sourceId ||
            comparePositions(node.$pos, original.pos) !== 0 ||
            transferImageDigest(node, allowance, referenceWork) !== original.digest)
        )
          throw new KernelError('CONFLICT', 'Transfer source original changed before cleanup');
      }
    if (input.transferAbsent !== undefined)
      for (const path of input.transferAbsent) {
        referenceWork.exprWork += 1 + path.length;
        if (referenceWork.exprWork > allowance.exprWork || Date.now() > allowance.deadline)
          throw new KernelError('BUDGET', 'Transfer absence validation exceeded its allowance');
        if (treeNavigate(root, path)?.data !== undefined)
          throw new KernelError('CONFLICT', 'Transfer destination appeared before copy');
      }
    if (input.writerEpoch < writerEpoch) throw new KernelError('CONFLICT', 'Writer epoch is stale');
    const commit = structuredClone(input);
    if (commit.writerEpoch < writerEpoch)
      throw new KernelError('CONFLICT', 'Writer epoch is stale');
    options.beforeRecord?.();
    available();
    if (commit.writerEpoch < writerEpoch)
      throw new KernelError('CONFLICT', 'Writer epoch is stale');
    const record = commit.record;
    const publishJournal = journalIndex.prepare(record, commit.writes, commit);
    const time = Math.max(acceptedAt, commit.acceptedAt ?? acceptedAt);
    const maintenance =
      record.maintenance === undefined || options.externalMaintenance === true
        ? undefined
        : journalIndex.maintenance({ ...commit, acceptedAt: time });
    const holdBudget = {
      ...allowance,
      nodes: allowance.nodes - (maintenance?.cost.nodes ?? 0),
      bytes: allowance.bytes - (maintenance?.cost.bytes ?? 0),
      exprWork: allowance.exprWork - (maintenance?.cost.exprWork ?? 0),
    };
    let publishHolds: () => void, publishArchive: (() => void) | undefined;
    try {
      publishHolds = holds.stage(
        { ...commit, acceptedAt: time },
        holdBudget,
        undefined,
        maintenance,
        referenceWork,
      );
      if (commit.blobArchive !== undefined) {
        const archive = archiveBudget(commit);
        publishArchive = archives.stageBatch(
          commit.blobArchive,
          { ...holdBudget, nodes: Math.min(holdBudget.nodes, archive.nodes) },
          referenceWork,
        );
      }
    } catch (error) {
      maintenance?.cancel();
      throw error;
    }
    const key =
      record.decision === undefined ? undefined : decisionKey(record.caller, record.decision.opId);
    const anchorKey =
      record.anchorDecision === undefined
        ? undefined
        : decisionKey(record.caller, record.anchorDecision.opId);
    return () => {
      // All fallible staging finishes before the synchronous data and journal publication.
      for (const write of commit.writes) {
        if (write.node === null) treeRemove(root, write.path);
        else treeEnsure(root, write.path).data = write.node;
      }
      publishJournal.publish();
      maintenance?.publish();
      publishHolds();
      publishArchive?.();
      acceptedAt = time;
      if (record.maintenance !== undefined)
        journalBoundary = Math.max(
          journalBoundary ?? record.maintenance.journalBefore,
          record.maintenance.journalBefore,
        );
      publishHeads(publishJournal.record);
      if (key !== undefined) decisions.set(key, publishJournal.record);
      if (anchorKey !== undefined) decisions.set(anchorKey, publishJournal.record);
      writerEpoch = commit.writerEpoch;
    };
  }

  return {
    blobOwner: `memory:${randomUUID()}`,
    get journalRetentionClock() {
      available();
      return acceptedAt;
    },
    get journalRetentionBoundary() {
      available();
      return journalBoundary;
    },
    get maintenancePending() {
      available();
      return journalIndex.maintenancePending;
    },
    /** Restores validated bounded archive units before the owning adapter opens admission. */
    loadBlobArchives(units, budget, work = { exprWork: 0 }) {
      available();
      for (const unit of units) archives.stage(unit, budget(), work)();
    },
    /** Streams bounded archive units while the Writer retains this root authority. */
    async *blobArchiveCensus(owner) {
      available();
      for (const unit of archives.census(owner)) {
        available();
        yield unit;
      }
    },
    /** Reads archived physical carriers under the caller's durable maintenance clock. */
    async archivedBlobHolds(ids, clock, budget) {
      available();
      return archives.get(ids, clock, budget);
    },
    domain: options.domain,
    scan,
    blobSnapshot: holds.save,
    /** Yields one metadata unit at a time while the caller holds this owner stable. */
    async *blobCensus() {
      available();
      for (const row of holds.census()) {
        available();
        yield row;
      }
    },
    /** Reads only keyed reference metadata under the caller's logical budget. */
    async blobHolds(ids, budget) {
      available();
      check(budget);
      if (ids.length > budget.nodes)
        throw new KernelError('BUDGET', 'Blob hold metadata exceeded its budget');
      const items = holds.get(ids),
        bytes = Buffer.byteLength(JSON.stringify(items));
      if (items.length > budget.nodes || bytes > budget.bytes)
        throw new KernelError('BUDGET', 'Blob hold metadata exceeded its budget');
      return { items, cost: { nodes: items.length, bytes, exprWork: 0 } };
    },
    stageCommit,
    async commit(input: StoreCommit) {
      stageCommit(input)();
    },
    /** Release the owned node data; repeated release has no effects. */
    close(): void {
      if (closed) return;
      closed = true;
      root.children.clear();
      root.data = undefined;
      decisions.clear();
      positionHead = undefined;
      intakeHead = undefined;
      journalIndex = createJournalIndex();
    },
  };
}

/** Archive commits carry the Writer's actual bounded execution context. */
function archiveBudget(commit: StoreCommit): Budget {
  if (
    commit.record.kind !== 'kernel' ||
    commit.record.caller !== 'kernel' ||
    commit.record.executor !== 'kernel' ||
    commit.writes.length !== 0 ||
    commit.record.entries.length !== 0 ||
    commit.maintenanceLimits === undefined
  )
    throw new KernelError('INVALID', 'Archive publication requires bounded kernel authority');
  return {
    ...commit.maintenanceLimits.budget,
    nodes: Math.min(commit.maintenanceLimits.budget.nodes, commit.maintenanceLimits.changeSet),
  };
}
