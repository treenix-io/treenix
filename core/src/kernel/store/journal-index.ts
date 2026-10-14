import { KernelError } from '#errors';
import { comparePaths } from '#core/path';
import { decodeChainNode } from '#kernel/chain-index';
import { applyFieldDeltas, compactJournal, readJournalImages } from '#kernel/journal';
import { comparePositions } from '#kernel/position';
import type {
  Budget,
  JournalCommit,
  JournalEntry,
  JournalImageTypes,
  JournalRange,
  JournalVisibility,
  ScanResult,
  StoredNode,
  StoredWrite,
  StoreCommit,
  JournalAddress,
} from '#kernel/types';
import { treeEnsure, treeNavigate, treeWalk, type TreeNode } from '#kernel/store/nested-map';

interface IndexedEntry {
  readonly record: JournalCommit;
  entry: JournalEntry;
  readonly visibility: JournalVisibility;
  previous?: IndexedEntry;
  next?: IndexedEntry;
}

/** Decode a stored image into the visibility fields used by history queries. */
function metadata(image: StoredNode): JournalImageTypes {
  const decoded = decodeChainNode(image);
  return Object.freeze({
    path: decoded.path,
    id: decoded.id,
    types: decoded.types,
    hasOwner: decoded.hasOwner,
    ...(decoded.owner === undefined ? {} : { owner: decoded.owner }),
    ...(decoded.invalid === undefined ? {} : { invalid: decoded.invalid }),
  });
}

/** Build immutable history visibility from one transition without loading unrelated journal images. */
export function journalVisibility(
  record: Pick<JournalCommit, 'pos' | 'kind'>,
  entry: JournalEntry,
  prior: JournalVisibility['after'] | undefined,
  accepted?: StoredNode,
): JournalVisibility {
  const change = entry.change;
  let before: JournalVisibility['before'], after: JournalVisibility['after'];
  if (change.t === 'create') {
    before = null;
    after = metadata(change.after);
  } else if (change.t === 'delete') {
    before = metadata(change.before);
    after = null;
  } else if (change.t === 'reconcile') {
    before =
      change.before === undefined
        ? prior === undefined
          ? 'unknown'
          : prior
        : change.before === null
          ? null
          : metadata(change.before);
    after = change.after === null ? null : metadata(change.after);
  } else {
    const image = change.after === undefined ? accepted : change.after;
    if (image === undefined)
      throw new KernelError('INVALID', 'Journal update has no accepted image');
    if (change.after === undefined) {
      if (prior === undefined || prior === null)
        throw new KernelError('INVALID', 'Compact journal update has no anchor');
      before = prior;
    } else before = metadata(applyFieldDeltas(change.after, change.delta, 'from'));
    after = metadata(image);
  }
  return Object.freeze({
    path: entry.path,
    ...(entry.from === undefined ? {} : { from: entry.from }),
    address: Object.freeze({ pos: Object.freeze({ ...record.pos }), id: entry.id }),
    kind: record.kind,
    before,
    after,
  });
}

/** Indexes immutable address/type metadata independently of compact journal payloads. */
export function createJournalIndex() {
  const paths: TreeNode<Set<IndexedEntry>> = { children: new Map() };
  const latest = new Map<string, IndexedEntry>();
  const empty = new Map<JournalCommit, true>();
  const rows = new Map<JournalCommit, JournalEntry[]>();
  const order = new Map<
    IndexedEntry | JournalCommit,
    { readonly acceptedAt?: number; readonly retainUntil?: number }
  >();
  let cursor: Iterator<IndexedEntry | JournalCommit> | undefined;
  let waiting: IteratorResult<IndexedEntry | JournalCommit> | undefined;
  let latestIntake: JournalCommit | undefined;

  /** Prepares all derived metadata before the Store publishes any writes. */
  function prepare(
    input: JournalCommit,
    writes: readonly StoredWrite[],
    retention?: Pick<StoreCommit, 'acceptedAt' | 'journalRetentionMs'>,
  ) {
    const entries: JournalEntry[] = [];
    const record = { ...input, entries };
    const written = new Map<string, StoredNode>();
    for (const write of writes) if (write.node !== null) written.set(write.node.$id, write.node);

    const staged: IndexedEntry[] = [];
    for (const entry of input.entries) {
      entries.push(entry);
      const prior = latest.get(entry.id);
      const indexed: IndexedEntry = {
        record,
        entry,
        previous: prior,
        visibility: journalVisibility(
          record,
          entry,
          prior?.visibility.after,
          entry.change.t === 'update' && entry.change.after === undefined
            ? written.get(entry.id)
            : undefined,
        ),
      };
      staged.push(indexed);
    }

    return {
      record,
      publish() {
        rows.set(record, entries);
        const provenance = {
          acceptedAt: retention?.acceptedAt,
          ...(retention?.acceptedAt === undefined || retention.journalRetentionMs === undefined
            ? {}
            : { retainUntil: retention.acceptedAt + retention.journalRetentionMs }),
        };
        if (record.intake !== undefined) latestIntake = record;
        if (record.entries.length === 0) {
          empty.set(record, true);
          order.set(record, provenance);
        }
        for (const value of staged) {
          if (value.previous !== undefined) value.previous.next = value;
          latest.set(value.entry.id, value);
          order.set(value, provenance);
          for (const at of [value.entry.path, value.entry.from]) {
            if (at === undefined) continue;
            const node = treeEnsure(paths, at);
            if (node.data === undefined) node.data = new Set();
            node.data.add(value);
          }
        }
      },
    };
  }

  /** Reconstructs only the selected identity chain, charging every canonical anchor read. */
  function images(member: IndexedEntry, charge: (value: object) => void, step: () => void) {
    const anchors: JournalCommit[] = [];
    for (
      let current: IndexedEntry | undefined = member;
      current !== undefined;
      current = current.previous
    ) {
      step();
      const anchor = { ...current.record, entries: [current.entry] };
      charge(anchor);
      anchors.push(anchor);
      const change = current.entry.change;
      if (change.t === 'update' && change.after === undefined) continue;
      if (current === member && change.t === 'reconcile' && change.before === undefined) continue;
      break;
    }
    return readJournalImages(anchors.reverse(), { pos: member.record.pos, id: member.entry.id });
  }

  /** Stages bounded canonical promotion and retirement; its publisher also advances the owner cursor. */
  function maintenance(commit: StoreCommit) {
    const intent = commit.record.maintenance,
      limits = commit.maintenanceLimits;
    if (intent === undefined || limits === undefined || commit.acceptedAt === undefined)
      throw new KernelError('INVALID', 'Canonical maintenance lacks its execution context');
    const budget = limits.budget,
      cap = Math.min(budget.nodes, limits.changeSet);
    const cost = { nodes: 0, bytes: 0, exprWork: 0 };
    const retired: JournalAddress[] = [],
      dropped: (IndexedEntry | JournalCommit)[] = [];
    const promoted = new Map<IndexedEntry, JournalEntry>();
    const pending = cursor !== undefined;
    const active = cursor ?? order.keys();
    let next = waiting ?? active.next();

    /** Counts canonical data actually consulted by this maintenance batch. */
    function charge(value: object): void {
      cost.nodes++;
      cost.bytes += Buffer.byteLength(JSON.stringify(value));
      if (cost.nodes > cap || cost.bytes > budget.bytes || Date.now() > budget.deadline)
        throw new KernelError('BUDGET', 'Canonical maintenance budget exceeded');
    }

    /** Charges chain traversal separately from returned image bytes. */
    function step(): void {
      cost.exprWork++;
      if (cost.exprWork > budget.exprWork || Date.now() > budget.deadline)
        throw new KernelError('BUDGET', 'Canonical maintenance traversal budget exceeded');
    }

    try {
      while (!next.done) {
        const unit = next.value,
          provenance = order.get(unit)!;
        const priorCost = { ...cost };
        try {
          charge(provenance);
          const expired =
            provenance.retainUntil === undefined
              ? provenance.acceptedAt !== undefined && provenance.acceptedAt < intent.journalBefore
              : provenance.retainUntil < commit.acceptedAt;
          if (expired && 'entry' in unit) {
            const successor = unit.next,
              change = successor?.entry.change;
            if (
              successor !== undefined &&
              ((change?.t === 'update' && change.after === undefined) ||
                (change?.t === 'reconcile' && change.before === undefined))
            ) {
              const current = images(unit, charge, step),
                before = unit.entry.change;
              const anchored = {
                ...unit.entry,
                change:
                  before.t === 'update'
                    ? { ...before, after: current.after! }
                    : before.t === 'reconcile' && current.before !== 'unknown'
                      ? { ...before, before: current.before }
                      : before,
              };
              const records = compactJournal(
                [
                  { ...unit.record, entries: [anchored] },
                  { ...successor.record, entries: [successor.entry] },
                ],
                successor.record.pos,
              );
              const replacement = records.find(
                (record) => comparePositions(record.pos, successor.record.pos) === 0,
              )!.entries[0]!;
              charge(replacement);
              promoted.set(successor, replacement);
            }
            retired.push({ pos: unit.record.pos, id: unit.entry.id });
            dropped.push(unit);
          } else if (
            expired &&
            !('entry' in unit) &&
            unit !== latestIntake &&
            (unit.decision === undefined || unit.decision.opId.time < intent.decisionBefore) &&
            (unit.anchorDecision === undefined ||
              unit.anchorDecision.opId.time < intent.decisionBefore)
          )
            dropped.push(unit);
        } catch (error) {
          if (!(error instanceof KernelError && error.code === 'BUDGET') || priorCost.nodes === 0)
            throw error;
          Object.assign(cost, priorCost);
          break;
        }
        next = active.next();
      }
    } catch (error) {
      cursor = undefined;
      waiting = undefined;
      throw error;
    }

    return {
      retired,
      retained: [...promoted].map(([unit, entry]) => ({
        pos: unit.record.pos,
        entry,
        ...order.get(unit),
      })),
      cost,
      cancel() {
        cursor = pending ? order.keys() : undefined;
        waiting = undefined;
      },
      publish() {
        for (const [unit, entry] of promoted) {
          const entries = rows.get(unit.record)!;
          entries[entries.indexOf(unit.entry)] = entry;
          unit.entry = entry;
        }
        for (const unit of dropped) {
          const provenance = order.get(unit)!;
          order.delete(unit);
          if ('entry' in unit) {
            const entries = rows.get(unit.record)!;
            entries.splice(entries.indexOf(unit.entry), 1);
            for (const path of [unit.entry.path, unit.entry.from])
              if (path !== undefined) treeNavigate(paths, path)!.data!.delete(unit);
            if (unit.next !== undefined) unit.next.previous = unit.previous;
            if (unit.previous !== undefined) unit.previous.next = unit.next;
            if (latest.get(unit.entry.id) === unit) latest.delete(unit.entry.id);
            if (entries.length === 0) {
              empty.set(unit.record, true);
              order.set(unit.record, provenance);
            }
          } else {
            empty.delete(unit);
            rows.delete(unit);
          }
        }
        cursor = next.done ? undefined : active;
        waiting = next.done ? undefined : next;
      },
    };
  }

  /** Selects indexed addresses before the predicate sees visibility metadata. */
  function select(
    range: JournalRange,
    budget: Budget,
  ): { records: readonly JournalCommit[]; cost: NonNullable<ScanResult<JournalCommit>['cost']> } {
    const cost = { nodes: 0, bytes: 0, exprWork: 0 };

    /** Enforce the cumulative scan budget before more work or data is returned. */
    function check(): void {
      if (
        Date.now() > budget.deadline ||
        cost.nodes > budget.nodes ||
        cost.bytes > budget.bytes ||
        cost.exprWork > budget.exprWork
      )
        throw new KernelError('BUDGET', 'Journal scan budget exceeded');
    }

    /** Count one unit of index traversal work and recheck the budget. */
    function step(): void {
      cost.exprWork++;
      check();
    }

    /** Include reconstructed journal data in the response budget. */
    function charge(value: object): void {
      cost.nodes++;
      cost.bytes += Buffer.byteLength(JSON.stringify(value));
      check();
    }

    const selected = new Map<JournalCommit, IndexedEntry[]>();
    const visited = new Set<IndexedEntry>();
    const start = treeNavigate(paths, range.journal);
    check();

    if (start !== undefined)
      for (const node of treeWalk(start)) {
        step();
        for (const indexed of node.data ?? []) {
          step();
          if (visited.has(indexed)) continue;
          visited.add(indexed);
          if (range.after !== undefined && comparePositions(indexed.record.pos, range.after) <= 0)
            continue;
          if (range.accept !== undefined && !range.accept(indexed.visibility)) continue;
          const list = selected.get(indexed.record);
          if (list === undefined) selected.set(indexed.record, [indexed]);
          else list.push(indexed);
        }
      }

    if (range.accept === undefined) {
      if (range.journal === '/')
        for (const record of empty.keys()) {
          step();
          if (range.after === undefined || comparePositions(record.pos, range.after) > 0)
            selected.set(record, []);
        }
      return { records: [...selected.keys()], cost };
    }

    if (range.take !== undefined) {
      if (!Number.isSafeInteger(range.take) || range.take < 1)
        throw new KernelError('INVALID', 'History limit must be positive');
      const entries = [...selected.values()].flat();
      entries.sort((a, b) => {
        step();
        return comparePositions(a.record.pos, b.record.pos) || comparePaths(a.entry.id, b.entry.id);
      });
      selected.clear();
      for (const entry of entries.slice(0, range.take)) {
        step();
        const list = selected.get(entry.record);
        if (list === undefined) selected.set(entry.record, [entry]);
        else list.push(entry);
      }
    }

    const records: JournalCommit[] = [];
    for (const [record, members] of selected) {
      const entries: JournalEntry[] = [];
      for (const member of members) {
        const current = images(member, charge, step);
        const change = member.entry.change;
        if (change.t === 'update') {
          if (current.after === null)
            throw new KernelError('INVALID', 'Journal update has no after-image');
          entries.push({ ...member.entry, change: { ...change, after: current.after } });
        } else
          entries.push({
            ...member.entry,
            change:
              change.t === 'reconcile' && current.before !== 'unknown'
                ? { ...change, before: current.before }
                : change,
          });
      }
      records.push({ ...record, entries });
    }

    check();
    return { records, cost };
  }
  return {
    prepare,
    select,
    maintenance,
    get maintenancePending() {
      return cursor !== undefined;
    },
  };
}
