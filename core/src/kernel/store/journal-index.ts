import { KernelError } from '#errors';
import { comparePaths } from '#core/path';
import { decodeChainNode } from '#kernel/chain-index';
import { applyFieldDeltas, readJournalImages } from '#kernel/journal';
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
} from '#kernel/types';
import { treeEnsure, treeNavigate, treeWalk, type TreeNode } from '#kernel/store/nested-map';

interface IndexedEntry {
  readonly record: JournalCommit;
  readonly entry: JournalEntry;
  readonly visibility: JournalVisibility;
  readonly previous?: IndexedEntry;
}

/** Indexes immutable address/type metadata independently of compact journal payloads. */
export function createJournalIndex() {
  const paths: TreeNode<Set<IndexedEntry>> = { children: new Map() };
  const latest = new Map<string, IndexedEntry>();
  const empty: JournalCommit[] = [];

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

  /** Prepares all derived metadata before the Store publishes any writes. */
  function prepare(record: JournalCommit, writes: readonly StoredWrite[]): () => void {
    const written = new Map<string, StoredNode>();
    for (const write of writes) if (write.node !== null) written.set(write.node.$id, write.node);

    const staged: IndexedEntry[] = [];
    for (const entry of record.entries) {
      const prior = latest.get(entry.id);
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
              : prior.visibility.after
            : change.before === null
              ? null
              : metadata(change.before);
        after = change.after === null ? null : metadata(change.after);
      } else {
        const image = change.after === undefined ? written.get(entry.id) : change.after;
        if (image === undefined)
          throw new KernelError('INVALID', 'Journal update has no accepted image');
        if (change.after === undefined) {
          if (prior === undefined || prior.visibility.after === null)
            throw new KernelError('INVALID', 'Compact journal update has no anchor');
          before = prior.visibility.after;
        } else before = metadata(applyFieldDeltas(change.after, change.delta, 'from'));
        after = metadata(image);
      }
      const indexed: IndexedEntry = {
        record,
        entry,
        previous: prior,
        visibility: Object.freeze({
          path: entry.path,
          ...(entry.from === undefined ? {} : { from: entry.from }),
          address: Object.freeze({ pos: Object.freeze({ ...record.pos }), id: entry.id }),
          kind: record.kind,
          before,
          after,
        }),
      };
      staged.push(indexed);
    }

    return () => {
      if (record.entries.length === 0) empty.push(record);
      for (const value of staged) {
        latest.set(value.entry.id, value);
        for (const at of [value.entry.path, value.entry.from]) {
          if (at === undefined) continue;
          const node = treeEnsure(paths, at);
          if (node.data === undefined) node.data = new Set();
          node.data.add(value);
        }
      }
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
        for (const record of empty) {
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
        const anchors: JournalCommit[] = [];
        for (
          let current: IndexedEntry | undefined = member;
          current !== undefined;
          current = current.previous
        ) {
          step();
          const change = current.entry.change;
          const anchor = { ...current.record, entries: [current.entry] };
          charge(anchor);
          anchors.push(anchor);
          if (change.t === 'update' && change.after === undefined) continue;
          if (current === member && change.t === 'reconcile' && change.before === undefined)
            continue;
          break;
        }
        const images = readJournalImages(anchors.reverse(), {
          pos: record.pos,
          id: member.entry.id,
        });
        const change = member.entry.change;
        if (change.t === 'update') {
          if (images.after === null)
            throw new KernelError('INVALID', 'Journal update has no after-image');
          entries.push({ ...member.entry, change: { ...change, after: images.after } });
        } else
          entries.push({
            ...member.entry,
            change:
              change.t === 'reconcile' && images.before !== 'unknown'
                ? { ...change, before: images.before }
                : change,
          });
      }
      records.push({ ...record, entries });
    }

    check();
    return { records, cost };
  }
  return { prepare, select };
}
