import { KernelError } from '#errors';
import { isRecord } from '#util/is-record';
import { comparePositions } from '#kernel/position';
import type { BlobReferenceWork } from '#kernel/blob-references';
import type {
  BlobArchiveMutation,
  BlobHold,
  BlobHoldRow,
  Budget,
  Position,
  TransferOwnership,
} from '#kernel/types';

type Page = Extract<BlobArchiveMutation, { t: 'page' }>;
type ReferencePages = Map<Page, readonly BlobHoldRow[]>;
interface IndexUpdate {
  readonly id: string;
  readonly group: readonly BlobHoldRow[];
  readonly pages: ReferencePages;
}
interface ReferenceUpdate {
  readonly id: string;
  readonly current: ReferencePages;
  readonly removed: readonly Page[];
  readonly added: ReferencePages | undefined;
}
interface Owner {
  readonly generation: Position;
  readonly pages: Map<number, Page>;
  sealed: boolean;
  transfer?: {
    readonly intent: TransferOwnership;
    readonly copies: Map<number, Extract<BlobArchiveMutation, { t: 'copyPage' }>>;
    readonly switched?: Position;
  };
}

interface ArchiveState {
  readonly owners: Map<string, Owner>;
  readonly references: Map<string, ReferencePages>;
  pending: number;
  retiring: number;
}

/** Evaluate one archived row against its captured provenance and the advancing root clock. */
export function archivedBlobRow(row: BlobHoldRow, page: Page, clock: number) {
  if (page.retiredAt !== undefined)
    return {
      live: 0,
      history: 0,
      releasedAt: Math.max(page.retiredAt, row.t === 'released' ? row.at : 0),
    };
  if (row.t === 'live') return { live: 1, history: 0, releasedAt: 0 };
  if (row.t === 'released') return { live: 0, history: 0, releasedAt: row.at };

  const expiredByFloor =
    row.retainUntil === undefined &&
    row.acceptedAt !== undefined &&
    page.boundary !== undefined &&
    row.acceptedAt < page.boundary;
  const expiredByTime = row.retainUntil !== undefined && row.retainUntil < clock;

  if (expiredByFloor) return { live: 0, history: 0, releasedAt: page.clock };
  if (expiredByTime)
    return { live: 0, history: 0, releasedAt: Math.max(row.retainUntil!, page.clock) };
  return { live: 0, history: 1, releasedAt: 0 };
}

/** Keeps bounded archive pages authoritative until their exact physical carrier reactivates. */
export function createBlobArchives(
  recovered?: {
    readonly units: Iterable<BlobArchiveMutation>;
    readonly budget: () => Budget;
  },
  state: ArchiveState = { owners: new Map(), references: new Map(), pending: 0, retiring: 0 },
) {
  const { owners, references } = state;

  /** Indexes only identities named by one bounded page, never unrelated owner rows. */
  function index(page: Page, add: boolean, budget: Budget, work: BlobReferenceWork): () => void {
    /** Reserve each metadata edge before allocating its index entry. */
    function charge(): void {
      work.exprWork++;
      if (work.exprWork > budget.exprWork || Date.now() > budget.deadline)
        throw new KernelError('BUDGET', 'Archive reference work exceeded its allowance');
    }
    const rows = new Map<string, BlobHoldRow[]>();
    for (const row of page.rows) {
      charge();
      const ids = row.t === 'released' ? [row.id] : row.ids;
      for (const id of ids) {
        charge();
        let group = rows.get(id);
        if (group === undefined) {
          group = [];
          rows.set(id, group);
        }
        group.push(row);
      }
    }

    const updates: IndexUpdate[] = [];
    for (const [id, group] of rows) {
      charge();
      const previous = references.get(id);
      if (!add && (previous === undefined || !previous.has(page)))
        throw new KernelError('INVALID', 'Archived reference index is inconsistent');
      updates.push({ id, group, pages: previous ?? new Map<Page, readonly BlobHoldRow[]>() });
    }
    return () => {
      for (const { id, group, pages } of updates) {
        if (add) {
          pages.set(page, group);
          references.set(id, pages);
        } else {
          pages.delete(page);
          if (pages.size === 0) references.delete(id);
        }
      }
    };
  }

  /** Validates the next archive unit before returning its synchronous publication. */
  function stage(
    change: BlobArchiveMutation,
    budget: Budget,
    work: BlobReferenceWork = { exprWork: 0 },
  ): () => void {
    const owner = owners.get(change.owner);
    if (owner !== undefined && comparePositions(owner.generation, change.generation) !== 0)
      throw new KernelError('CONFLICT', 'Archived carrier generation differs');
    if (Date.now() > budget.deadline) throw new KernelError('BUDGET', 'Archive deadline exceeded');
    /** Serialize full pages only after their reference traversal fits the operation. */
    function checkBytes(unit: BlobArchiveMutation, extra = 0): void {
      if (extra + Buffer.byteLength(JSON.stringify(unit)) > budget.bytes)
        throw new KernelError('BUDGET', 'Archive byte budget exceeded');
    }
    if (change.t !== 'page' && change.t !== 'copyPage') checkBytes(change);

    switch (change.t) {
      case 'begin':
        if (owner !== undefined)
          throw new KernelError('CONFLICT', 'Archived carrier already exists');
        if (
          change.transfer !== undefined &&
          (change.transfer.destination !== change.owner ||
            !Number.isSafeInteger(change.transfer.firstPage) ||
            change.transfer.firstPage < 0)
        )
          throw new KernelError('INVALID', 'Transfer owner differs from its physical archive');
        return () => {
          owners.set(change.owner, {
            generation: change.generation,
            pages: new Map(),
            sealed: false,
            ...(change.transfer === undefined
              ? {}
              : { transfer: { intent: change.transfer, copies: new Map() } }),
          });
          state.pending++;
        };
      case 'reopen':
        if (owner === undefined || !owner.sealed)
          throw new KernelError('CONFLICT', 'Archived carrier is not sealed');
        return () => {
          owner.sealed = false;
          state.pending++;
        };
      case 'restartTransfer': {
        const prior = owner?.transfer;
        if (
          prior === undefined ||
          prior.switched !== undefined ||
          change.transfer.node !== prior.intent.node ||
          change.transfer.component !== prior.intent.component ||
          change.transfer.base !== prior.intent.base ||
          change.transfer.pattern !== prior.intent.pattern ||
          change.transfer.source !== prior.intent.source ||
          change.transfer.destination !== prior.intent.destination ||
          change.transfer.firstPage !== prior.intent.firstPage
        )
          throw new KernelError('CONFLICT', 'Transfer retry differs from its physical owner');
        return () => {
          owner!.transfer = { ...prior, intent: change.transfer };
          if (owner!.sealed) {
            owner!.sealed = false;
            state.pending++;
          }
        };
      }
      case 'copyPage': {
        const transfer = owner?.transfer;
        if (
          transfer === undefined ||
          transfer.switched !== undefined ||
          change.page !== transfer.intent.firstPage + transfer.copies.size
        )
          throw new KernelError('CONFLICT', 'Transfer copy pages are not contiguous');
        if (change.copies.length > budget.nodes)
          throw new KernelError('BUDGET', 'Transfer identity page exceeded its allowance');
        work.exprWork += change.copies.length;
        if (work.exprWork > budget.exprWork)
          throw new KernelError('BUDGET', 'Transfer identity work exceeded its allowance');
        checkBytes(change);
        return () => {
          transfer.copies.set(change.page, change);
        };
      }
      case 'retireCopyPage': {
        const transfer = owner?.transfer;
        if (
          transfer === undefined ||
          change.page !== transfer.intent.firstPage ||
          !transfer.copies.has(change.page)
        )
          throw new KernelError('CONFLICT', 'Transfer retirement is not contiguous');
        return () => {
          transfer.copies.delete(change.page);
          owner!.transfer = {
            ...transfer,
            intent: { ...transfer.intent, firstPage: change.page + 1 },
          };
        };
      }
      case 'switchTransfer': {
        const transfer = owner?.transfer;
        if (transfer === undefined || transfer.switched !== undefined)
          throw new KernelError('CONFLICT', 'Transfer owner has already switched');
        return () => {
          owner!.transfer = { ...transfer, switched: change.pos };
          state.retiring++;
        };
      }
      case 'completeTransfer':
        if (owner?.transfer === undefined || owner.transfer.copies.size !== 0)
          throw new KernelError('CONFLICT', 'Transfer still owns copied identities');
        return () => {
          if (owner.transfer!.switched !== undefined) state.retiring--;
          owner.transfer = undefined;
          if (owner.pages.size === 0 && owner.sealed) owners.delete(change.owner);
        };
      case 'page': {
        if (
          !Number.isFinite(change.clock) ||
          (change.boundary !== undefined && !Number.isFinite(change.boundary))
        )
          throw new KernelError('INVALID', 'Archive retention provenance is invalid');
        if (
          !Number.isSafeInteger(change.page) ||
          change.page < 0 ||
          change.rows.length > budget.nodes
        )
          throw new KernelError('BUDGET', 'Archive page budget exceeded');
        if (owner?.sealed || change.page !== (owner?.pages.size ?? 0))
          throw new KernelError('CONFLICT', 'Archive pages are not contiguous');
        const publishIndex = index(change, true, budget, work);
        checkBytes(change);
        return () => {
          let target = owner;
          if (target === undefined) {
            target = { generation: change.generation, pages: new Map(), sealed: false };
            owners.set(change.owner, target);
            state.pending++;
          }
          target.pages.set(change.page, change);
          publishIndex();
        };
      }
      case 'retirePage': {
        const page = owner?.pages.get(change.page);
        if (
          page === undefined ||
          owner!.sealed ||
          !Number.isFinite(change.at) ||
          change.at < page.clock
        )
          throw new KernelError('CONFLICT', 'Archived carrier release is not pending');
        if (page.rows.length > budget.nodes)
          throw new KernelError('BUDGET', 'Archived release page exceeded its budget');
        const retired = { ...page, retiredAt: change.at };
        const removeIndex = index(page, false, budget, work);
        const addIndex = index(retired, true, budget, work);
        checkBytes(page, Buffer.byteLength(JSON.stringify(change)));
        return () => {
          removeIndex();
          owner!.pages.set(change.page, retired);
          addIndex();
        };
      }
      case 'seal':
        if (
          !Number.isSafeInteger(change.pages) ||
          change.pages < 0 ||
          change.pages !== (owner?.pages.size ?? 0) ||
          owner?.sealed
        )
          throw new KernelError('CONFLICT', 'Archive seal does not cover its pages');
        return () => {
          if (owner === undefined)
            owners.set(change.owner, {
              generation: change.generation,
              pages: new Map(),
              sealed: true,
            });
          else {
            owner.sealed = true;
            state.pending--;
          }
        };
      case 'removePage': {
        const page = owner?.pages.get(change.page);
        if (page === undefined || change.page !== owner!.pages.size - 1)
          throw new KernelError('CONFLICT', 'Archived removal is not contiguous');
        const removeIndex = index(page, false, budget, work);
        checkBytes(page, Buffer.byteLength(JSON.stringify(change)));
        return () => {
          if (owner!.sealed) {
            owner!.sealed = false;
            state.pending++;
          }
          owner!.pages.delete(change.page);
          removeIndex();
        };
      }
      case 'remove':
        if (owner === undefined || owner.pages.size !== 0)
          throw new KernelError('CONFLICT', 'Archived carrier still has pages');
        return () => {
          if (!owner.sealed) state.pending--;
          if (owner.transfer === undefined) owners.delete(change.owner);
          else owner.sealed = true;
        };
    }
  }

  /** Reads requested identities under the durable root clock; live references never expire. */
  function get(ids: readonly string[], clock: number, budget: Budget) {
    if (!Number.isFinite(clock)) throw new KernelError('INVALID', 'Archive clock is invalid');
    if (state.pending !== 0 || state.retiring !== 0)
      throw new KernelError(
        'UNAVAILABLE',
        'Archived carrier census or transfer cleanup is incomplete',
      );
    if (ids.length > budget.nodes)
      throw new KernelError('BUDGET', 'Archive identity budget exceeded');
    const cost = { nodes: 0, bytes: 0, exprWork: 0 };
    const items: BlobHold[] = [];

    for (const id of ids) {
      let live = 0,
        history = 0,
        releasedAt = 0;
      for (const [page, rows] of references.get(id) ?? [])
        for (const row of rows) {
          if (Date.now() > budget.deadline)
            throw new KernelError('BUDGET', 'Archive deadline exceeded');
          cost.nodes++;
          cost.exprWork += 1 + (row.t === 'released' ? 1 : row.ids.length);
          if (cost.exprWork > budget.exprWork)
            throw new KernelError('BUDGET', 'Archive reference work exceeded its allowance');
          cost.bytes += Buffer.byteLength(JSON.stringify(row));
          if (cost.nodes > budget.nodes || cost.bytes > budget.bytes)
            throw new KernelError('BUDGET', 'Archive read budget exceeded');
          const item = archivedBlobRow(row, page, clock);
          live += item.live;
          history += item.history;
          releasedAt = Math.max(releasedAt, item.releasedAt);
        }
      items.push({ id, live, history, releasedAt });
    }
    return { items, cost };
  }

  /** Streams one exact owner without walking unrelated archived carriers. */
  function* ownerUnits(key: string, owner: Owner): Iterable<BlobArchiveMutation> {
    yield {
      t: 'begin',
      owner: key,
      generation: owner.generation,
      ...(owner.transfer === undefined ? {} : { transfer: owner.transfer.intent }),
    };
    if (owner.transfer !== undefined) yield* owner.transfer.copies.values();
    yield* owner.pages.values();
    if (owner.sealed)
      yield { t: 'seal', owner: key, generation: owner.generation, pages: owner.pages.size };
    if (owner.transfer?.switched !== undefined)
      yield {
        t: 'switchTransfer',
        owner: key,
        generation: owner.generation,
        pos: owner.transfer.switched,
      };
  }

  /** Streams exact archive units for bounded durable serialization or reactivation removal. */
  function* census(ownerKey?: string): Iterable<BlobArchiveMutation> {
    if (ownerKey !== undefined) {
      const owner = owners.get(ownerKey);
      if (owner !== undefined) yield* ownerUnits(ownerKey, owner);
      return;
    }
    for (const [key, owner] of owners) yield* ownerUnits(key, owner);
  }

  /** Validates sequential candidate state and the complete budget before any owner is published. */
  function stageBatch(
    changes: readonly BlobArchiveMutation[],
    budget: Budget,
    work: BlobReferenceWork = { exprWork: 0 },
  ): () => void {
    if (changes.length === 1) return stage(changes[0], budget, work);
    const affected = new Set(changes.map((change) => change.owner));
    const candidate: ArchiveState = {
      owners: new Map(),
      references: new Map(),
      pending: 0,
      retiring: 0,
    };
    const next = createBlobArchives(undefined, candidate);
    let nodes = 0,
      bytes = 0;

    /** Charges metadata copied into this bounded candidate, including its existing affected pages. */
    function charge(unit: BlobArchiveMutation): void {
      nodes +=
        unit.t === 'page'
          ? Math.max(1, unit.rows.length)
          : unit.t === 'copyPage'
            ? Math.max(1, unit.copies.length)
            : 1;
      bytes += Buffer.byteLength(JSON.stringify(unit));
      if (nodes > budget.nodes || bytes > budget.bytes || Date.now() > budget.deadline)
        throw new KernelError('BUDGET', 'Archive batch exceeded its budget');
    }

    for (const owner of affected)
      for (const unit of census(owner)) {
        const publish = next.stage(unit, budget, work);
        charge(unit);
        publish();
      }
    /** Charge candidate index edges before materializing the publication plan. */
    function chargeReference(count = 1): void {
      work.exprWork += count;
      if (work.exprWork > budget.exprWork || Date.now() > budget.deadline)
        throw new KernelError('BUDGET', 'Archive reference work exceeded its allowance');
    }
    const prior = new Map<string, Page[]>();
    const ids = new Set<string>();
    for (const [id, pages] of candidate.references) {
      chargeReference();
      const selected: Page[] = [];
      for (const page of pages.keys()) {
        chargeReference();
        selected.push(page);
      }
      prior.set(id, selected);
      ids.add(id);
    }
    for (const unit of changes) {
      const publish = next.stage(unit, budget, work);
      charge(unit);
      publish();
    }
    for (const id of candidate.references.keys()) {
      chargeReference();
      ids.add(id);
    }
    const updates: ReferenceUpdate[] = [];
    for (const id of ids) {
      chargeReference();
      const current = references.get(id) ?? new Map<Page, readonly BlobHoldRow[]>();
      const removed = prior.get(id) ?? [];
      for (const page of removed) {
        chargeReference();
        if (!current.has(page))
          throw new KernelError('INVALID', 'Archived reference index is inconsistent');
      }
      const added = candidate.references.get(id);
      if (added !== undefined) chargeReference(added.size);
      updates.push({ id, current, removed, added });
    }
    let pendingDelta = candidate.pending;
    for (const owner of affected) if (owners.get(owner)?.sealed === false) pendingDelta--;

    let retiringDelta = candidate.retiring;
    for (const owner of affected)
      if (owners.get(owner)?.transfer?.switched !== undefined) retiringDelta--;

    return () => {
      for (const owner of affected) {
        const replacement = candidate.owners.get(owner);
        if (replacement === undefined) owners.delete(owner);
        else owners.set(owner, replacement);
      }
      for (const { id, current, removed, added } of updates) {
        for (const page of removed) current.delete(page);
        if (added !== undefined) for (const [page, rows] of added) current.set(page, rows);
        if (current.size === 0) references.delete(id);
        else references.set(id, current);
      }
      state.pending += pendingDelta;
      state.retiring += retiringDelta;
    };
  }

  if (recovered !== undefined)
    for (const change of recovered.units) stage(change, recovered.budget())();
  return { stage, stageBatch, get, census };
}

/** Validates one persisted archive unit before it enters the trusted root catalogue. */
export function isBlobArchiveMutation(value: unknown): value is BlobArchiveMutation {
  if (!isRecord(value) || typeof value.owner !== 'string' || !archivePosition(value.generation))
    return false;
  const generation = value.generation;
  switch (value.t) {
    case 'begin':
      return value.transfer === undefined || transferOwnership(value.transfer);
    case 'restartTransfer':
      return transferOwnership(value.transfer);
    case 'remove':
    case 'completeTransfer':
    case 'reopen':
      return true;
    case 'switchTransfer':
      return archivePosition(value.pos);
    case 'retireCopyPage':
      return typeof value.page === 'number' && Number.isSafeInteger(value.page) && value.page >= 0;
    case 'copyPage':
      return (
        typeof value.page === 'number' &&
        Number.isSafeInteger(value.page) &&
        value.page >= 0 &&
        Array.isArray(value.copies) &&
        value.copies.every(
          (copy) =>
            isRecord(copy) &&
            typeof copy.path === 'string' &&
            typeof copy.sourceId === 'string' &&
            typeof copy.id === 'string' &&
            typeof copy.digest === 'string' &&
            /^[a-f0-9]{64}$/.test(copy.digest) &&
            typeof copy.copiedDigest === 'string' &&
            /^[a-f0-9]{64}$/.test(copy.copiedDigest) &&
            archivePosition(copy.pos) &&
            copy.pos.instance === generation.instance,
        )
      );
    case 'removePage':
      return Number.isSafeInteger(value.page) && typeof value.page === 'number' && value.page >= 0;
    case 'retirePage':
      return (
        typeof value.page === 'number' &&
        Number.isSafeInteger(value.page) &&
        value.page >= 0 &&
        typeof value.at === 'number' &&
        Number.isFinite(value.at)
      );
    case 'seal':
      return (
        Number.isSafeInteger(value.pages) && typeof value.pages === 'number' && value.pages >= 0
      );
    case 'page':
      return (
        typeof value.page === 'number' &&
        Number.isSafeInteger(value.page) &&
        value.page >= 0 &&
        typeof value.clock === 'number' &&
        Number.isFinite(value.clock) &&
        (value.boundary === undefined ||
          (typeof value.boundary === 'number' && Number.isFinite(value.boundary))) &&
        (value.retiredAt === undefined ||
          (typeof value.retiredAt === 'number' && Number.isFinite(value.retiredAt))) &&
        Array.isArray(value.rows) &&
        value.rows.every(archiveRow)
      );
    default:
      return false;
  }
}

/** Decode the physical transfer boundary retained independently of canonical journal tails. */
function transferOwnership(value: unknown): value is TransferOwnership {
  return (
    isRecord(value) &&
    typeof value.node === 'string' &&
    typeof value.component === 'string' &&
    typeof value.base === 'string' &&
    typeof value.pattern === 'string' &&
    typeof value.source === 'string' &&
    (value.sourceDeclaration === undefined ||
      (isRecord(value.sourceDeclaration) &&
        typeof value.sourceDeclaration.component === 'string' &&
        isRecord(value.sourceDeclaration.node) &&
        typeof value.sourceDeclaration.node.$path === 'string' &&
        typeof value.sourceDeclaration.node.$id === 'string' &&
        typeof value.sourceDeclaration.node.$type === 'string' &&
        typeof value.sourceDeclaration.node.$rev === 'string')) &&
    typeof value.destination === 'string' &&
    archivePosition(value.cursor) &&
    typeof value.firstPage === 'number' &&
    Number.isSafeInteger(value.firstPage) &&
    value.firstPage >= 0
  );
}

/** Checks the canonical address at the persisted metadata boundary. */
function archivePosition(value: unknown): value is Position {
  return (
    isRecord(value) &&
    typeof value.instance === 'string' &&
    typeof value.epoch === 'number' &&
    Number.isSafeInteger(value.epoch) &&
    value.epoch >= 0 &&
    typeof value.seq === 'number' &&
    Number.isSafeInteger(value.seq) &&
    value.seq >= 0
  );
}

/** Accepts sparse census rows with explicit historical provenance when it exists. */
function archiveRow(value: unknown): value is BlobHoldRow {
  if (!isRecord(value)) return false;
  if (value.t === 'released')
    return (
      typeof value.id === 'string' && typeof value.at === 'number' && Number.isFinite(value.at)
    );
  if (!Array.isArray(value.ids) || !value.ids.every((id) => typeof id === 'string')) return false;
  if (value.t === 'live') return typeof value.key === 'string';
  return (
    value.t === 'history' &&
    isRecord(value.address) &&
    typeof value.address.id === 'string' &&
    archivePosition(value.address.pos) &&
    (value.acceptedAt === undefined ||
      (typeof value.acceptedAt === 'number' && Number.isFinite(value.acceptedAt))) &&
    (value.retainUntil === undefined ||
      (typeof value.retainUntil === 'number' && Number.isFinite(value.retainUntil)))
  );
}
