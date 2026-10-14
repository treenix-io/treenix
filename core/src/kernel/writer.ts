import { assertSafePath } from '#core/path';
import { isDeepStrictEqual } from 'node:util';
import { KernelError } from '#errors';
import type { OperationReadCost } from '#kernel/store/budget';
import { createProcessCache, type CacheRead, type Image, type ProcessCache } from '#kernel/cache';
import type { NodeChange } from '#kernel/changeset';
import { createInfluenceIndex, type InfluenceOptions } from '#kernel/influence';
import {
  createIdempotency,
  type IdempotencyOptions,
  type MutationIdentity,
  type MutationWaiter,
} from '#kernel/idempotency';
import { comparePositions } from '#kernel/position';
import { matchingDecision } from '#kernel/journal';
import { readTransferProvenance, type TransferProvenance } from '#kernel/transfer-provenance';
import { maintenanceRecord } from '#kernel/maintenance';
import { assertCommitGroups, sameStoreOwner } from '#kernel/store/owner';
import { createInstanceStream, streamDomainEpochs } from '#kernel/stream';
import {
  DEFAULT_LIMITS,
  type Budget,
  type DomainId,
  type FederationForward,
  type OpId,
  type Principal,
  type JournalCommit,
  type JournalEntry,
  type OpDecision,
  type OpenedStoreMountTarget,
  type Outcome,
  type Position,
  type PositionCounter,
  type Rev,
  type Store,
  type StoreCommit,
  type StoredWrite,
  type StreamDomain,
  type StreamEvent,
  type BlobArchiveMutation,
  type BlobBirth,
  type BlobCarrier,
  type BlobHoldRow,
  type BlobHoldResult,
  type BlobStore,
  type StoreCommitGroup,
  type StoredNode,
  type TransferCopy,
  type TransferOwnership,
  type UnknownExternalImage,
} from '#kernel/types';

export interface StoreTargetRegistration {
  readonly key: string;
  readonly revision: Rev;
  readonly target: OpenedStoreMountTarget;
}
export interface TargetPublication {
  readonly registration: StoreTargetRegistration;
  readonly pos: Position;
  readonly kind: 'activate' | 'retire';
}
export interface TargetLifecycle {
  validate(registration: StoreTargetRegistration): void;
  publish(event: TargetPublication): void;
}
export interface TargetTransferSwitch {
  readonly declarationStore: Store;
  readonly before: StoredNode;
  rejected(): void;
  /** Recheck the whole source footprint and the prepared route inside Writer order. */
  check(): void;
  /** Prepare the canonical declaration without publishing its new routing claim. */
  prepare(pos: Position): PreparedTransferSwitch | Promise<PreparedTransferSwitch>;
  /** Remove the copied source images after the new route is accepted. */
  readonly source: Store;
  readonly removed: readonly (readonly TransferCopy[])[];
}
export interface PreparedTransferSwitch extends PreparedCommit {
  readonly registration: StoreTargetRegistration;
  accepted(owner: AcceptedNodeRead): Promise<void>;
}
const acceptedNodeOwner = Symbol('accepted-node-owner');

/** A switch-local capability reads only its actual durably accepted declaring image. */
export interface AcceptedNodeRead {
  readonly [acceptedNodeOwner]: true;
  readonly path: string;
  readonly id: string;
}
const acceptedNodeReads = new WeakMap<AcceptedNodeRead, () => Promise<StoredNode>>();

/** Read through the actual Writer-owned switch capability, never a caller-supplied image. */
export function readAcceptedNode(owner: AcceptedNodeRead): Promise<StoredNode> {
  const read = acceptedNodeReads.get(owner);
  if (read === undefined)
    throw new KernelError('UNAVAILABLE', 'Accepted node owner has left its switch');
  return read();
}

interface TargetPin {
  readonly registration: StoreTargetRegistration;
  readonly writerEpoch: number;
  generation: number;
  active: boolean;
  retirement?: 'requested' | 'complete';
  readonly startup?: boolean;
}

export interface WriterOptions {
  readonly instance: string;
  readonly root: Store;
  readonly blobs?: BlobStore;
  readonly writerEpoch: number;
  readonly domains: readonly StreamDomain[];
  readonly counter: PositionCounter;
  readonly budget?: () => Budget;
  readonly cache?: ProcessCache;
  readonly influence?: Pick<InfluenceOptions, 'maxWrites' | 'maxBytes'>;
  readonly intake?: Pick<IdempotencyOptions, 'now' | 'limits'>;
  readonly maintenance?: {
    readonly now?: () => number;
    readonly retentionMs?: () => number;
    readonly changeSet?: () => number;
    readonly orphanMs?: () => number;
  };
  readonly applied?: (
    domain: DomainId,
    commit: StoreCommit,
    images: readonly Image[],
    store: Store,
  ) => void;
  readonly stageApplied?: (commit: StoreCommit, groups: readonly StoreCommitGroup[]) => () => void;
  readonly targetLifecycle?: TargetLifecycle;
  readonly startupTargets?: readonly StoreTargetRegistration[];
}

export interface PreparedCommit {
  readonly budget?: Budget;
  readonly writes: readonly StoredWrite[];
  readonly groups?: readonly StoreCommitGroup[];
  readonly record: JournalCommit;
  readonly transitions?: readonly NodeChange[];
  readonly check?: () => void;
  readonly maintenanceLimits?: StoreCommit['maintenanceLimits'];
  readonly transferBefore?: StoreCommit['transferBefore'];
  readonly transferAbsent?: StoreCommit['transferAbsent'];
}
export interface PreparedMutation extends PreparedCommit {
  readonly value?: unknown;
}
export interface MutationSpan {
  readonly anchor: OpDecision;
  beginIo(executor: Principal, check: () => void): Promise<void>;
  beginStream(stream: NonNullable<OpDecision['stream']>): Promise<void>;
  validateAnchor(): Promise<void>;
  step(
    store: Store,
    reads: readonly DomainId[],
    prepare: (position: Position) => PreparedCommit | Promise<PreparedCommit>,
  ): Promise<Position>;
  finish(
    store: Store,
    reads: readonly DomainId[],
    prepare: (position: Position) => PreparedMutation | Promise<PreparedMutation>,
  ): Promise<Outcome>;
}
export interface ForwardMutation {
  readonly identity: MutationIdentity;
  readonly cost: OperationReadCost;
  readonly check: (forward?: FederationForward) => void;
  readonly prepare: () => Promise<FederationForward>;
  readonly execute: (forward: FederationForward) => Promise<Outcome>;
  readonly wait?: MutationWaiter;
}

export interface ForwardMutation {
  readonly identity: MutationIdentity;
  readonly cost: OperationReadCost;
  readonly check: (forward?: FederationForward) => void;
  readonly prepare: () => Promise<FederationForward>;
  readonly execute: (forward: FederationForward) => Promise<Outcome>;
  readonly wait?: MutationWaiter;
}

type Applied =
  | {
      readonly t: 'committed';
      readonly pos: Position;
      readonly domain: DomainId;
      readonly store: Store;
      readonly commit: StoreCommit;
      readonly changes: readonly NodeChange[] | null;
      readonly event: StreamEvent;
      readonly publishGroups?: () => readonly Image[];
    }
  | {
      readonly t: 'gap';
      readonly pos: Position;
      readonly event: StreamEvent;
      readonly error: unknown;
    }
  | { readonly t: 'refused'; readonly error: unknown }
  | { readonly t: 'unchanged' }
  | { readonly t: 'retired'; readonly pos?: Position };

/** Refuses invalid domain bindings before the counter or Store can accept an effect. */
export function assertWriterDomains(root: Store, domains: readonly StreamDomain[]): void {
  streamDomainEpochs(domains);
  if (!domains.some((domain) => domain.store === root))
    throw new KernelError('INVALID', 'Root Store is not a declared target');
}

/** Owns ordered positions, commit delivery, decision intake, and registered target lifetimes. */
/** Release only acquired startup resources if ordered initialization cannot complete. */
export async function createWriter(options: WriterOptions) {
  try {
    return await initializeWriter(options);
  } catch (error) {
    console.error(error);
    const borrowed = new Set(options.domains.map((domain) => domain.store));
    const owned = new Set(
      options.startupTargets
        ?.map((registration) => registration.target)
        .filter((target) => !borrowed.has(target.store)),
    );
    const released = await Promise.allSettled(
      [...owned].map((target) => Promise.resolve().then(() => target.close())),
    );
    const failures = released.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    if (failures.length !== 0)
      throw new AggregateError([error, ...failures], 'Writer initialization and release failed');
    throw error;
  }
}

/** Establish all accepted position and decision sources before any root effect. */
async function initializeWriter(options: WriterOptions) {
  assertWriterDomains(options.root, options.domains);
  const startupTargets = options.startupTargets ?? [];
  if (startupTargets.length !== 0 && options.targetLifecycle === undefined)
    throw new KernelError('INVALID', 'Target lifecycle owner is missing');
  const initial = [...options.domains];
  const initialStores = new Set(initial.map((domain) => domain.store)),
    keys = new Set<string>();
  for (const registration of startupTargets) {
    const { store, resources } = registration.target;
    if (keys.has(registration.key) || initialStores.has(store))
      throw new KernelError('INVALID', 'Startup target already has an owner');
    if (!Number.isSafeInteger(resources.writerEpoch) || resources.writerEpoch < 0)
      throw new KernelError('INVALID', 'Target writer token is invalid');
    keys.add(registration.key);
    initialStores.add(store);
    initial.push({ store, epoch: resources.epoch, persistent: resources.persistent });
  }
  streamDomainEpochs(initial);
  const ownerTokens = new Map<NonNullable<Store['transactionOwner']>, number>();
  for (const domain of initial)
    if (domain.store.transactionOwner !== undefined) {
      const owner = domain.store.transactionOwner;
      if (owner.domain !== domain.store.domain)
        throw new KernelError('INVALID', 'Store transaction owner domain differs');
      const token =
        startupTargets.find((registration) => registration.target.store === domain.store)?.target
          .resources.writerEpoch ?? options.writerEpoch;
      const previous = ownerTokens.get(owner);
      if (previous !== undefined && previous !== token)
        throw new KernelError('CONFLICT', 'Atomic participants have different fencing tokens');
      ownerTokens.set(owner, token);
    }
  const startupStores = new Set(startupTargets.map((registration) => registration.target.store));
  const cache = options.cache ?? createProcessCache();
  const budget =
    options.budget ??
    (() => ({
      nodes: DEFAULT_LIMITS.readNodes,
      bytes: DEFAULT_LIMITS.readBytes,
      exprWork: DEFAULT_LIMITS.exprWork,
      deadline: Date.now() + DEFAULT_LIMITS.queryMs,
    }));
  const loaded = await options.counter.load();
  let maximum: Position = { instance: options.instance, epoch: 0, seq: 0 };
  for (const domain of initial) {
    if (!domain.persistent && !startupStores.has(domain.store)) continue;
    const rows = await domain.store.scan({ range: { journalHead: 'position' }, budget: budget() });
    const last = rows.items[0]?.pos;
    if (last !== undefined && last.instance !== options.instance)
      throw new KernelError('INVALID', 'Target belongs to another instance');
    if (last !== undefined && comparePositions(last, maximum) > 0) maximum = last;
  }
  let position: Position;
  if (
    loaded !== undefined &&
    loaded.instance === options.instance &&
    comparePositions(loaded, maximum) >= 0
  )
    position = { ...loaded };
  else {
    const floor =
      loaded?.instance === options.instance ? Math.max(loaded.epoch, maximum.epoch) : maximum.epoch;
    const epoch = await options.counter.freshEpoch(floor);
    if (!Number.isSafeInteger(epoch) || epoch <= floor)
      throw new KernelError('INVALID', 'Instance epoch must be fresh and increasing');
    position = { instance: options.instance, epoch, seq: 0 };
    await options.counter.save(position, options.writerEpoch);
  }
  const stream = createInstanceStream({ position, domains: initial, budget });
  const domains = new Set(initial.map((domain) => domain.store.domain));
  const stores = new Set(initial.map((domain) => domain.store));
  let inventory = initial;
  const targets = new Map<string, TargetPin>();
  const storePins = new Map<Store, TargetPin>();
  const domainPins = new Map<DomainId, Set<TargetPin>>();
  const cleanup = new WeakMap<OpenedStoreMountTarget, Promise<void>>();
  const ownedTargets = new Set<OpenedStoreMountTarget>();
  const copyingTargets = new Map<
    OpenedStoreMountTarget,
    {
      readonly carriers: Map<BlobCarrier, Position>;
      readonly firstPage: number;
      nextPage: number;
      sealed: boolean;
    }
  >();
  let targetGeneration = 0;
  for (const registration of startupTargets) {
    const pin: TargetPin = {
      registration,
      writerEpoch: registration.target.resources.writerEpoch,
      active: false,
      startup: true,
      generation: 0,
    };
    targets.set(registration.key, pin);
    storePins.set(registration.target.store, pin);
    ownedTargets.add(registration.target);
    const domain = registration.target.store.domain;
    let selected = domainPins.get(domain);
    if (selected === undefined) {
      selected = new Set();
      domainPins.set(domain, selected);
    }
    selected.add(pin);
  }
  const intake = await createIdempotency({
    root: options.root,
    domains: initial,
    budget,
    ...options.intake,
  });
  const influence = createInfluenceIndex({ position, domains: [...domains], ...options.influence });
  const writers = new Map<DomainId, Promise<void>>();
  const readers = new Map<DomainId, Set<Promise<void>>>();
  const recovering = new Map<DomainId, Promise<void>>();
  const failedObservations = new Set<DomainId>();
  let reservation = Promise.resolve(),
    publication = Promise.resolve();
  let admission = Promise.resolve();
  let fatal: { readonly error: unknown } | undefined;
  let closing = false,
    closedTargets: Promise<void> | undefined;
  const maintenanceNow = options.maintenance?.now ?? options.intake?.now ?? Date.now;
  const retentionMs = options.maintenance?.retentionMs ?? (() => DEFAULT_LIMITS.journalRetentionMs);
  const maintainedAt = new Map<Store, number>(
    [...stores].map((store) => [store, maintenanceNow()]),
  );
  let maintenanceTail = Promise.resolve();
  const ownerMaintenance = new Map<NonNullable<Store['transactionOwner']>, Promise<void>>();

  /** Native continuation retains consumed preparation cost and the original absolute deadline. */
  function executionLimits(
    prepared: StoreCommit['maintenanceLimits'],
  ): NonNullable<StoreCommit['maintenanceLimits']> {
    const current = budget(),
      changeSet = options.maintenance?.changeSet?.() ?? DEFAULT_LIMITS.changeSet;
    if (prepared === undefined) return { budget: current, changeSet };
    return {
      changeSet: Math.min(changeSet, prepared.changeSet),
      budget: {
        nodes: Math.min(current.nodes, prepared.budget.nodes),
        bytes: Math.min(current.bytes, prepared.budget.bytes),
        exprWork: Math.min(current.exprWork, prepared.budget.exprWork),
        deadline: Math.min(current.deadline, prepared.budget.deadline),
      },
    };
  }

  /** A shared journal keeps the longest policy declared by any actual registered participant. */
  function ownerRetention(store: Store): number {
    let retention = store.journalRetentionMs ?? retentionMs();
    for (const sibling of stores)
      if (sameStoreOwner(store, sibling))
        retention = Math.max(retention, sibling.journalRetentionMs ?? retentionMs());
    if (!Number.isFinite(retention) || retention < 0)
      throw new KernelError('INVALID', 'Invalid journal retention');
    return retention;
  }

  /** Serialize maintenance requests while each actual record uses ordinary domain barriers. */
  function maintain(store: Store = options.root): Promise<void> {
    if (closing) return Promise.reject(new KernelError('UNAVAILABLE', 'Writer is closing'));
    if (!stores.has(store))
      return Promise.reject(new KernelError('INVALID', 'Unknown maintenance domain'));
    const transactionOwner = store.transactionOwner;
    if (transactionOwner !== undefined) {
      const pending = ownerMaintenance.get(transactionOwner);
      if (pending !== undefined) return pending;
    }
    const time = maintenanceNow(),
      retention = ownerRetention(store);
    const owner = storePins.get(store);
    if (!Number.isFinite(retention) || retention < 0)
      return Promise.reject(new KernelError('INVALID', 'Invalid journal retention'));
    if (store.transactionOwner === undefined) maintainedAt.set(store, time);
    else
      for (const sibling of stores)
        if (sameStoreOwner(store, sibling)) maintainedAt.set(sibling, time);
    const pending = maintenanceTail.then(async () => {
      await applyCommit(
        options.root,
        [...domains],
        (pos) => ({
          writes: [],
          transitions: [],
          record: {
            pos,
            kind: 'kernel',
            executor: 'kernel',
            caller: 'kernel',
            entries: [],
            intake: intake.next(pos),
          },
        }),
        undefined,
        true,
        owner,
      );
      do {
        const position = await applyCommit(
          store,
          [options.root.domain],
          (pos) => ({
            writes: [],
            transitions: [],
            record: maintenanceRecord(pos, time - retention, intake.state.boundary),
          }),
          async () => true,
          true,
          owner,
        );
        if (position === undefined) break;
      } while (
        store.maintenancePending === true &&
        stores.has(store) &&
        owner?.retirement === undefined
      );
      if (options.blobs !== undefined && !closing) await lifecycle(collectBlobs);
    });
    maintenanceTail = pending.then(
      () => {},
      (error) => {
        console.error(error);
      },
    );
    if (transactionOwner === undefined) return pending;
    const shared = pending.finally(() => {
      ownerMaintenance.delete(transactionOwner);
    });
    ownerMaintenance.set(transactionOwner, shared);
    return shared;
  }
  function checkFailure(maintenance = false): void {
    if (fatal !== undefined) throw fatal.error;
    if (closing && !maintenance) throw new KernelError('UNAVAILABLE', 'Writer is closing');
  }

  /** Persist the next position before making it available to a Store. */
  async function reservePosition(): Promise<Position> {
    if (!Number.isSafeInteger(position.seq + 1))
      throw new KernelError('BUDGET', 'Position counter exhausted');
    const assigned = { ...position, seq: position.seq + 1 };
    // A failed reservation never issues a position; issued gaps are durable counter entries too.
    await options.counter.save(assigned, options.writerEpoch);
    position = assigned;
    return assigned;
  }
  function allocate(maintenance = false): Promise<Position> {
    const barrier = admission;
    const next = reservation
      .then(() => barrier)
      .then(() => {
        checkFailure(maintenance);
        return reservePosition();
      });
    reservation = next.then(
      () => {},
      (error) => {
        console.error(error);
      },
    );
    return next;
  }

  // Fence every target before serving writes: an old process may have reserved a position already.
  const fencing =
    startupTargets.length === 0
      ? [...stores]
      : [...stores].filter((store) => store !== options.root).concat(options.root);
  const rotate = startupTargets.some(
    (registration) => registration.target.resources.decisionHistory === 'unconfirmed',
  );
  for (const store of fencing) {
    const pos = await allocate();
    const record: JournalCommit = {
      pos,
      kind: 'kernel',
      executor: 'kernel',
      caller: 'kernel',
      entries: [],
      ...(store === options.root ? { intake: intake.next(pos, rotate) } : {}),
    };
    try {
      const commit = {
        pos,
        acceptedAt: maintenanceNow(),
        journalRetentionMs: ownerRetention(store),
        writerEpoch: storePins.get(store)?.writerEpoch ?? options.writerEpoch,
        writes: [],
        record,
      };
      await store.commit(commit);
      if (record.intake !== undefined) intake.publish(record.intake);
      const images = cache.apply(store, commit);
      options.applied?.(store.domain, commit, images, store);
      influence.record(store.domain, pos, []);
      stream.publish({ t: 'commit', domain: store.domain, record });
    } catch (error) {
      console.error(error);
      influence.advance(pos);
      stream.publish({ t: 'gap', pos });
      throw error;
    }
  }

  function commit(
    store: Store,
    reads: readonly DomainId[],
    prepare: (position: Position) => PreparedCommit | Promise<PreparedCommit>,
  ): Promise<Position> {
    return applyCommit(store, reads, prepare).then((pos) => {
      if (pos === undefined)
        throw new KernelError('INVALID', 'Unconditional commit was not allocated');
      return pos;
    });
  }
  /** Rechecks only actual grouped participants after preparation and ordered metadata barriers. */
  function assertParticipants(
    groups: readonly StoreCommitGroup[],
    generation: number,
    writerEpoch: number,
  ): void {
    for (const group of groups) {
      const captured = storePins.get(group.store);
      if (!stores.has(group.store) || (captured !== undefined && captured.generation > generation))
        throw new KernelError('UNAVAILABLE', 'Atomic participant registration changed');
      if ((captured?.writerEpoch ?? options.writerEpoch) !== writerEpoch)
        throw new KernelError('CONFLICT', 'Atomic participants have different fencing tokens');
      if (captured !== undefined) {
        if (!captured.active) throw new KernelError('UNAVAILABLE', 'Atomic participant retired');
        options.targetLifecycle!.validate(captured.registration);
      }
    }
  }
  /** Conditional external preparation owns its domain before deciding whether to reserve a position. */
  function applyCommit(
    store: Store,
    reads: readonly DomainId[],
    prepare: (position: Position) => PreparedCommit | Promise<PreparedCommit>,
    preflight?: () => Promise<boolean>,
    maintenance = false,
    retirement?: TargetPin,
    recovery = false,
    copiedTarget?: OpenedStoreMountTarget,
  ): Promise<Position | undefined> {
    if (!recovery) {
      for (const domain of [...reads, store.domain])
        if (failedObservations.has(domain))
          throw new KernelError('UNAVAILABLE', 'External observation domain is unavailable');
      const gates = new Set(
        [...reads, store.domain].flatMap((domain) => {
          const gate = recovering.get(domain);
          return gate === undefined ? [] : [gate];
        }),
      );
      if (gates.size !== 0)
        return Promise.all(gates).then(() =>
          applyCommit(
            store,
            reads,
            prepare,
            preflight,
            maintenance,
            retirement,
            recovery,
            copiedTarget,
          ),
        );
    }
    try {
      checkFailure(maintenance);
    } catch (error) {
      return Promise.reject(error);
    }
    const retired = () => retirement?.retirement !== undefined;
    if (retired()) return Promise.resolve(undefined);
    if (
      (copiedTarget === undefined && !stores.has(store)) ||
      reads.some((domain) => !domains.has(domain))
    )
      return Promise.reject(new KernelError('INVALID', 'Unknown transaction domain'));
    if (copiedTarget !== undefined && (copiedTarget.store !== store || stores.has(store)))
      return Promise.reject(new KernelError('INVALID', 'Physical copy target is already routed'));
    const pin = storePins.get(store);
    const priorPublication = publication;
    const writerEpoch =
      copiedTarget?.resources.writerEpoch ?? pin?.writerEpoch ?? options.writerEpoch;
    const generation = targetGeneration;
    const assertPin = () => {
      if (pin !== undefined) {
        if (!pin.active || storePins.get(store) !== pin)
          throw new KernelError('UNAVAILABLE', 'Target registration changed');
        options.targetLifecycle!.validate(pin.registration);
      }
    };
    try {
      assertPin();
    } catch (error) {
      return Promise.reject(error);
    }
    const inputDomains = new Set([...reads, store.domain]);
    const dependencies = new Set<Promise<void>>();
    for (const domain of inputDomains) {
      const prior = writers.get(domain);
      if (prior !== undefined) dependencies.add(prior);
    }
    for (const prior of readers.get(store.domain) ?? []) dependencies.add(prior);
    let release: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    writers.set(store.domain, done);
    for (const domain of reads) {
      let active = readers.get(domain);
      if (active === undefined) {
        active = new Set();
        readers.set(domain, active);
      }
      active.add(done);
    }
    let assigned: Promise<Position | undefined>;
    if (preflight === undefined) assigned = allocate(maintenance);
    else {
      const barrier = admission;
      assigned = reservation
        .then(() => barrier)
        .then(async () => {
          await Promise.all(dependencies);
          checkFailure(maintenance);
          if (retired()) return undefined;
          assertPin();
          if (!(await preflight())) return undefined;
          checkFailure(maintenance);
          if (retired()) return undefined;
          assertPin();
          return reservePosition();
        });
      reservation = assigned.then(
        () => {},
        (error) => {
          console.error(error);
        },
      );
    }
    const applied: Promise<Applied> = (async () => {
      let pos: Position | undefined;
      const leases: CacheRead[] = [];
      try {
        pos = await assigned;
        if (pos === undefined) return retired() ? { t: 'retired' } : { t: 'unchanged' };
        await Promise.all(dependencies);
        checkFailure(maintenance);
        if (retired()) return { t: 'retired', pos };
        assertPin();
        const operationBudget = budget();
        const prepared = await prepare(pos);
        if (prepared.groups !== undefined)
          assertCommitGroups(store, { writes: prepared.writes }, prepared.groups);
        const writeOwners =
          prepared.groups === undefined
            ? undefined
            : new Map(
                prepared.groups.flatMap((group) =>
                  group.writes.map((write) => [write.path, group.store] as const),
                ),
              );
        let changes: readonly NodeChange[] | null = prepared.transitions ?? null;
        if (
          prepared.transitions === undefined &&
          !prepared.record.entries.some(
            (entry) => entry.change.t === 'reconcile' && entry.change.before === undefined,
          )
        ) {
          const captured: NodeChange[] = [],
            allowance = budget();
          const after = new Map(prepared.writes.map((write) => [write.path, write.node]));
          let nodes = 0,
            bytes = 0;
          for (const entry of prepared.record.entries) {
            const path = entry.from ?? entry.path;
            const local = writeOwners === undefined ? store : writeOwners.get(path);
            if (local === undefined)
              throw new KernelError('INVALID', 'Journal source has no atomic participant');
            const lease = await cache.fill(local, { node: path }, allowance);
            leases.push(lease);
            const before =
              entry.change.t === 'reconcile' ? entry.change.before! : (lease.nodes[0] ?? null);
            if (before !== null) {
              nodes++;
              bytes += Buffer.byteLength(JSON.stringify(before));
            }
            if (nodes > allowance.nodes || bytes > allowance.bytes)
              throw new KernelError('BUDGET', 'Influence capture exceeded the read budget');
            const node = entry.change.t === 'delete' ? null : after.get(entry.path)!;
            captured.push({ id: entry.id, before, after: node });
          }
          changes = captured;
        }
        let quarantine =
          prepared.record.quarantine?.length === undefined
            ? undefined
            : new Map(prepared.record.quarantine.map((change) => [change.path, change]));
        for (const write of prepared.writes)
          if (
            (writeOwners === undefined ? store : writeOwners.get(write.path)!).acceptedFault?.(
              write.path,
            ) !== undefined
          ) {
            quarantine ??= new Map();
            quarantine.set(write.path, { path: write.path, fault: null });
          }
        const record =
          quarantine === undefined
            ? prepared.record
            : { ...prepared.record, quarantine: [...quarantine.values()] };
        const commit: StoreCommit = {
          writes: prepared.writes,
          record,
          pos,
          writerEpoch,
          acceptedAt: maintenanceNow(),
          ...(prepared.transferBefore === undefined
            ? {}
            : { transferBefore: prepared.transferBefore }),
          ...(prepared.transferAbsent === undefined
            ? {}
            : { transferAbsent: prepared.transferAbsent }),
          journalRetentionMs: ownerRetention(store),
          maintenanceLimits:
            record.maintenance === undefined && record.backfill === undefined
              ? {
                  budget: prepared.budget ?? operationBudget,
                  changeSet: options.maintenance?.changeSet?.() ?? DEFAULT_LIMITS.changeSet,
                }
              : executionLimits(prepared.maintenanceLimits),
        };
        checkFailure(maintenance);
        if (retired()) return { t: 'retired', pos };
        assertPin();
        prepared.check?.();
        let publishGroups: (() => readonly Image[]) | undefined;
        if (prepared.groups !== undefined) {
          assertCommitGroups(store, commit, prepared.groups);
          // Topology stages capture the current global version; earlier publications must finish first.
          if (options.stageApplied !== undefined) await priorPublication;
          checkFailure(maintenance);
          assertPin();
          assertParticipants(prepared.groups, generation, writerEpoch);
          prepared.check?.();
          const publishCache = cache.stageGroups(store, commit, prepared.groups);
          const publishMetadata = options.stageApplied?.(commit, prepared.groups);
          publishGroups = () => {
            const images = publishCache();
            publishMetadata?.();
            return images;
          };
          await store.transactionOwner!.commit(commit, prepared.groups);
        } else await store.commit(commit);
        return {
          t: 'committed',
          pos,
          domain: store.domain,
          store,
          commit,
          changes,
          ...(publishGroups === undefined ? {} : { publishGroups }),
          event:
            commit.record.maintenance === undefined && commit.record.decision?.forward === undefined
              ? { t: 'commit', domain: store.domain, record: commit.record }
              : { t: 'gap', pos },
        };
      } catch (error) {
        if (pos === undefined) return { t: 'refused', error };
        console.error(error);
        return { t: 'gap', pos, event: { t: 'gap', pos }, error };
      } finally {
        for (const lease of leases) lease.release();
      }
    })();
    const settled = publication
      .then(async () => {
        const result = await applied;
        if (fatal !== undefined) throw fatal.error;
        if (result.t === 'committed') {
          if (result.commit.record.intake !== undefined)
            intake.publish(result.commit.record.intake);
          if (result.commit.record.kind === 'transfer') {
            influence.advance(result.pos);
            stream.publish(result.event);
            return result;
          }

          const accepted =
            result.publishGroups === undefined
              ? cache.apply(result.store, result.commit)
              : result.publishGroups();
          if (result.commit.record.maintenance !== undefined)
            for (const participant of stores)
              if (sameStoreOwner(result.store, participant)) cache.retireStore(participant);
          if (result.publishGroups === undefined)
            options.applied?.(result.domain, result.commit, accepted, result.store);
          const images = new Map(accepted.map((image) => [image.id, image.node]));
          if (result.changes === null || result.commit.record.quarantine?.length)
            influence.reset(result.domain, result.pos);
          else
            influence.record(
              result.domain,
              result.pos,
              result.changes.map((change) => ({
                ...change,
                after: change.after === null ? null : images.get(change.id)!,
              })),
            );
        } else if (result.t === 'gap') influence.advance(result.pos);
        else if (result.t === 'retired' && result.pos !== undefined) {
          influence.advance(result.pos);
          stream.publish({ t: 'gap', pos: result.pos });
        }
        if (result.t !== 'refused' && result.t !== 'unchanged' && result.t !== 'retired')
          stream.publish(result.event);
        return result;
      })
      .catch((error) => {
        fatal = { error };
        throw error;
      })
      .finally(() => {
        // Later rights checks read the shared cache, so completion includes its ordered update.
        release();
        if (writers.get(store.domain) === done) writers.delete(store.domain);
        for (const domain of reads) {
          const active = readers.get(domain);
          active?.delete(done);
          if (active?.size === 0) readers.delete(domain);
        }
      });
    publication = settled.then(
      () => {},
      (error) => {
        console.error(error);
        fatal = { error };
      },
    );
    return settled.then((result) => {
      if (result.t === 'unchanged' || result.t === 'retired') return undefined;
      if (result.t !== 'committed') throw result.error;
      if (!maintenance && stores.has(store) && pin?.retirement === undefined) {
        const prior = maintainedAt.get(store);
        if (prior === undefined) maintainedAt.set(store, maintenanceNow());
        else if (
          store.maintenancePending === true ||
          maintenanceNow() - prior >= ownerRetention(store)
        ) {
          void maintain(store).catch((error) => {
            console.error(error);
            fatal = { error };
          });
        }
      }
      return result.pos;
    });
  }

  /** Copy native images under their off-route physical owner's fence and the ordinary Writer order. */
  async function copyTarget(
    target: OpenedStoreMountTarget,
    writes: readonly StoredWrite[],
    allowance: Budget,
    ownership: TransferOwnership,
    copies: readonly TransferCopy[],
    retry?: TransferProvenance,
    conditions?: Pick<StoreCommit, 'transferBefore' | 'transferAbsent'> & {
      readonly check?: () => void;
      readonly begun?: () => void;
    },
  ): Promise<Position> {
    let remaining = { ...allowance };
    ownedTargets.add(target);
    if (!Number.isSafeInteger(target.resources.writerEpoch) || target.resources.writerEpoch < 0)
      throw new KernelError('INVALID', 'Target writer token is invalid');
    if (!copyingTargets.has(target))
      await lifecycle(async () => {
        conditions?.check?.();
        const active = carrierInventory(inventory),
          pending = new Map<BlobCarrier, Position>();
        if (active.has(target.store.blobOwner))
          throw new KernelError('CONFLICT', 'Physical destination is already active');
        copyingTargets.set(target, {
          carriers: pending,
          firstPage: retry === undefined ? 0 : retry.intent.firstPage + retry.pages.length,
          nextPage: retry === undefined ? 0 : retry.intent.firstPage + retry.pages.length,
          sealed: false,
        });
        conditions?.begun?.();
        for (const carrier of referenceCarriers(target.store))
          if (!active.has(carrier.blobOwner)) {
            if (remaining.nodes < 1)
              throw new KernelError('BUDGET', 'Copy ownership exceeds its allowance');
            let generation: Position;
            if (retry === undefined) {
              generation = await archiveUnit(
                (pos) => [
                  {
                    t: 'begin',
                    owner: carrier.blobOwner,
                    generation: pos,
                    ...(carrier === target.store ? { transfer: ownership } : {}),
                  },
                ],
                remaining,
              );
            } else if (carrier === target.store) {
              const current = await readTransferProvenance(
                options.root,
                carrier.blobOwner,
                remaining,
              );
              if (
                current === undefined ||
                current.switched !== undefined ||
                !isDeepStrictEqual(current.intent, retry.intent) ||
                !isDeepStrictEqual(current.generation, retry.generation) ||
                !isDeepStrictEqual(current.pages, retry.pages) ||
                current.archivePages !== retry.archivePages
              )
                throw new KernelError('CONFLICT', 'Transfer retry ownership changed before copy');
              remaining = current.remaining;
              generation = current.generation;
              await archiveUnit(
                [
                  {
                    t: 'restartTransfer',
                    owner: carrier.blobOwner,
                    generation,
                    transfer: ownership,
                  },
                ],
                remaining,
              );
              for (let page = current.archivePages - 1; page >= 0; page--)
                await archiveUnit(
                  [{ t: 'removePage', owner: carrier.blobOwner, generation, page }],
                  remaining,
                );
            } else {
              let captured: Position | undefined;
              let pages = 0,
                sealed = false;
              for await (const unit of options.root.blobArchiveCensus(carrier.blobOwner)) {
                remaining.nodes--;
                remaining.bytes -= Buffer.byteLength(JSON.stringify(unit));
                remaining.exprWork -=
                  unit.t === 'page'
                    ? unit.rows.reduce(
                        (sum, row) => sum + 1 + (row.t === 'released' ? 1 : row.ids.length),
                        0,
                      )
                    : 1;
                if (
                  remaining.nodes < 0 ||
                  remaining.bytes < 0 ||
                  remaining.exprWork < 0 ||
                  Date.now() > remaining.deadline
                )
                  throw new KernelError('BUDGET', 'Transfer retry carrier exceeded its allowance');
                if (unit.t === 'begin') captured = unit.generation;
                if (unit.t === 'page') pages++;
                if (unit.t === 'seal') sealed = true;
              }
              if (captured === undefined) {
                generation = await archiveUnit(
                  (pos) => [{ t: 'begin', owner: carrier.blobOwner, generation: pos }],
                  remaining,
                );
              } else {
                generation = captured;
                if (sealed)
                  await archiveUnit(
                    [{ t: 'reopen', owner: carrier.blobOwner, generation }],
                    remaining,
                  );
                for (let page = pages - 1; page >= 0; page--)
                  await archiveUnit(
                    [{ t: 'removePage', owner: carrier.blobOwner, generation, page }],
                    remaining,
                  );
              }
            }
            remaining = {
              ...remaining,
              nodes: remaining.nodes - 1,
              bytes:
                remaining.bytes -
                Buffer.byteLength(
                  JSON.stringify({
                    t: 'begin',
                    owner: carrier.blobOwner,
                    generation,
                    ...(carrier === target.store ? { transfer: ownership } : {}),
                  }),
                ),
            };
            pending.set(carrier, generation);
          }
      });
    const copying = copyingTargets.get(target);
    const generation = copying?.carriers.get(target.store);
    if (copying === undefined || generation === undefined || copying.sealed)
      throw new KernelError('INVALID', 'Copy has no writable physical archive owner');
    if (copies.length !== 0) {
      if (copies.length > remaining.nodes || copies.length > remaining.exprWork)
        throw new KernelError('BUDGET', 'Copy identity metadata exceeds its allowance');
      const unit: Extract<BlobArchiveMutation, { t: 'copyPage' }> = {
        t: 'copyPage',
        owner: target.store.blobOwner,
        generation,
        page: copying.nextPage,
        copies: [...copies],
      };
      await lifecycle(() => {
        conditions?.check?.();
        return archiveUnit([unit], remaining);
      });
      remaining = {
        ...remaining,
        nodes: remaining.nodes - copies.length,
        bytes: remaining.bytes - Buffer.byteLength(JSON.stringify(unit)),
        exprWork: remaining.exprWork - copies.length,
      };
      copying.nextPage++;
    }
    const pos = await applyCommit(
      target.store,
      [],
      (accepted) => ({
        writes,
        transitions: [],
        budget: remaining,
        ...conditions,
        record: {
          pos: accepted,
          kind: 'transfer',
          executor: 'kernel',
          caller: 'kernel',
          entries: [],
        },
      }),
      undefined,
      false,
      undefined,
      false,
      target,
    );

    if (pos === undefined)
      throw new KernelError('INVALID', 'Physical copy has no accepted position');
    return pos;
  }

  /** Complete the durable off-route census before activation or retention of a rejected copy. */
  function sealCopiedTarget(target: OpenedStoreMountTarget, deadline?: number): Promise<void> {
    return lifecycle(async () => {
      const pending = copyingTargets.get(target);
      if (pending === undefined)
        throw new KernelError('INVALID', 'Target has no physical copy census');
      for (const [carrier, generation] of pending.carriers)
        await archiveCarrier(carrier, true, generation, deadline);
      pending.sealed = true;
    });
  }

  /** Superseded copy pages remain durable until the replacement census is complete. */
  function finishCopyRetry(
    target: OpenedStoreMountTarget,
    retry: TransferProvenance,
    allowance: Budget,
  ): Promise<void> {
    return lifecycle(async () => {
      const pending = copyingTargets.get(target);
      if (pending?.sealed !== true)
        throw new KernelError('INVALID', 'Transfer retry census is incomplete');
      for (const page of retry.pages)
        await archiveUnit(
          [
            {
              t: 'retireCopyPage',
              owner: target.store.blobOwner,
              generation: retry.generation,
              page: page.page,
            },
          ],
          allowance,
        );
    });
  }
  async function read<T>(
    inputs: readonly DomainId[] | (() => readonly DomainId[]),
    run: () => Promise<T>,
    recovery = false,
  ): Promise<T> {
    const select = inputs;
    if (typeof inputs === 'function') {
      for (;;) {
        const admitted = admission,
          published = publication;
        await Promise.all([admitted, published]);
        checkFailure();
        if (admitted === admission && published === publication) break;
      }
      inputs = inputs();
    }
    if (!recovery) {
      for (const domain of inputs)
        if (failedObservations.has(domain))
          throw new KernelError('UNAVAILABLE', 'External observation domain is unavailable');
      const gates = new Set(
        inputs.flatMap((domain) => {
          const gate = recovering.get(domain);
          return gate === undefined ? [] : [gate];
        }),
      );
      if (gates.size !== 0) {
        await Promise.all(gates);
        return read(select, run);
      }
    }
    checkFailure();
    const locked = new Set(inputs);
    const pinned = new Set<TargetPin>();
    for (const domain of locked) for (const pin of domainPins.get(domain) ?? []) pinned.add(pin);
    if ([...locked].some((domain) => !domains.has(domain)))
      throw new KernelError('INVALID', 'Unknown read domain');
    const dependencies = new Set<Promise<void>>();
    dependencies.add(admission);
    let release: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    for (const domain of locked) {
      const prior = writers.get(domain);
      if (prior !== undefined) dependencies.add(prior);
      let active = readers.get(domain);
      if (active === undefined) {
        active = new Set();
        readers.set(domain, active);
      }
      active.add(done);
    }
    try {
      await Promise.all(dependencies);
      checkFailure();
      if ([...locked].some((domain) => !domains.has(domain)))
        throw new KernelError('UNAVAILABLE', 'Read target was retired');
      for (const pin of pinned) {
        if (!pin.active || storePins.get(pin.registration.target.store) !== pin)
          throw new KernelError('UNAVAILABLE', 'Read target registration changed');
        options.targetLifecycle!.validate(pin.registration);
      }
      return await run();
    } finally {
      release();
      for (const domain of locked) {
        const active = readers.get(domain);
        active?.delete(done);
        if (active?.size === 0) readers.delete(domain);
      }
    }
  }
  async function refreshIntake(force = false): Promise<void> {
    await commit(options.root, [...domains], (pos) => ({
      writes: [],
      transitions: [],
      record: {
        pos,
        kind: 'kernel',
        executor: 'kernel',
        caller: 'kernel',
        entries: [],
        intake: intake.next(pos, force),
      },
    }));
  }
  /** Publishes remote intake under the actual local Writer before a shard mutation can be sent. */
  async function publishShardIntake(instance: string, epoch: string | undefined): Promise<void> {
    checkFailure();
    if (instance === options.instance)
      throw new KernelError('INVALID', 'Shard intake refers to its origin');
    await commit(options.root, [...domains], (pos) => {
      const shards = { ...intake.state.shards };
      if (epoch === undefined) delete shards[instance];
      else shards[instance] = epoch;
      return {
        writes: [],
        transitions: [],
        record: {
          pos,
          kind: 'kernel',
          executor: 'kernel',
          caller: 'kernel',
          entries: [],
          intake: intake.next(pos, false, undefined, false, shards),
        },
      };
    });
  }
  /** Release the resource exactly once, including concurrent failed-open and retirement paths. */
  function closeTarget(target: OpenedStoreMountTarget): Promise<void> {
    let pending = cleanup.get(target);
    if (pending === undefined) {
      pending = Promise.resolve()
        .then(() => target.close())
        .then(() => {
          ownedTargets.delete(target);
        });
      cleanup.set(target, pending);
    }
    return pending;
  }

  /** Reserve a lifecycle span before subsequent allocations and domain readers enter. */
  function lifecycle<T>(run: () => Promise<T>): Promise<T> {
    const dependencies = new Set([admission, reservation, publication, ...writers.values()]);
    for (const active of readers.values()) for (const done of active) dependencies.add(done);
    let release: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    admission = done;
    reservation = done;
    publication = done;
    return Promise.all(dependencies).then(run).finally(release);
  }

  /** Publish accepted kernel records through the same cache and observer path as ordinary commits. */
  function applyKernel(
    store: Store,
    commit: StoreCommit,
    transitions: readonly NodeChange[] = [],
  ): StreamEvent {
    if (commit.record.intake !== undefined) intake.publish(commit.record.intake);
    const images = cache.apply(store, commit);
    options.applied?.(store.domain, commit, images, store);
    influence.record(store.domain, commit.pos, transitions);
    return { t: 'commit', domain: store.domain, record: commit.record };
  }

  /** Accepts one bounded archive unit through the root's actual canonical kernel publication. */
  async function archiveUnit(
    change: readonly BlobArchiveMutation[] | ((pos: Position) => readonly BlobArchiveMutation[]),
    allowance = budget(),
  ): Promise<Position> {
    const pos = await reservePosition();
    const clock = Math.max(
      maintenanceNow(),
      options.root.journalRetentionClock ?? maintenanceNow(),
    );
    const commit: StoreCommit = {
      pos,
      acceptedAt: clock,
      writerEpoch: options.writerEpoch,
      journalRetentionMs: ownerRetention(options.root),
      writes: [],
      blobArchive: typeof change === 'function' ? change(pos) : change,
      maintenanceLimits: {
        budget: allowance,
        changeSet: options.maintenance?.changeSet?.() ?? DEFAULT_LIMITS.changeSet,
      },
      record: { pos, kind: 'kernel', caller: 'kernel', executor: 'kernel', entries: [] },
    };
    try {
      await options.root.commit(commit);
      stream.publish(applyKernel(options.root, commit));
      return pos;
    } catch (error) {
      fatal = { error };
      throw error;
    }
  }

  /** Preserves persistent holds or the actual release age of a carrier whose lifetime ends. */
  async function archiveCarrier(
    store: BlobCarrier,
    persistent: boolean,
    copiedGeneration?: Position,
    deadline?: number,
  ): Promise<(() => Promise<void>) | undefined> {
    const allowance = () => {
      const current = budget();
      return deadline === undefined
        ? current
        : { ...current, deadline: Math.min(current.deadline, deadline) };
    };
    const source = store.blobCensus()[Symbol.asyncIterator]();
    try {
      if (copiedGeneration !== undefined) {
        let pages = 0,
          sealed = false;
        const remaining = { ...allowance() };
        for await (const unit of options.root.blobArchiveCensus(store.blobOwner)) {
          remaining.nodes -=
            unit.t === 'page'
              ? Math.max(1, unit.rows.length)
              : unit.t === 'copyPage'
                ? Math.max(1, unit.copies.length)
                : 1;
          remaining.bytes -= Buffer.byteLength(JSON.stringify(unit));
          if (remaining.nodes < 0 || remaining.bytes < 0 || Date.now() > remaining.deadline)
            throw new KernelError('BUDGET', 'Copy archive inventory exceeded its allowance');
          if (unit.t === 'page') pages++;
          if (unit.t === 'seal') sealed = true;
        }
        if (sealed) {
          if (pages !== 0 && persistent) return;
          await archiveUnit(
            [{ t: 'reopen', owner: store.blobOwner, generation: copiedGeneration }],
            remaining,
          );
          if (pages !== 0)
            return async () => {
              const at = Math.max(
                maintenanceNow(),
                options.root.journalRetentionClock ?? maintenanceNow(),
              );
              for (let page = 0; page < pages; page++)
                await archiveUnit([
                  {
                    t: 'retirePage',
                    owner: store.blobOwner,
                    generation: copiedGeneration,
                    page,
                    at,
                  },
                ]);
              await archiveUnit([
                { t: 'seal', owner: store.blobOwner, generation: copiedGeneration, pages },
              ]);
            };
        }
      }
      let next = await source.next();
      if (next.done && copiedGeneration === undefined) return;
      const generation =
        copiedGeneration ??
        (await archiveUnit(
          (pos) => [{ t: 'begin', owner: store.blobOwner, generation: pos }],
          allowance(),
        ));
      let page = 0;
      while (!next.done) {
        const current = allowance();
        const limit = Math.min(
          current.nodes,
          options.maintenance?.changeSet?.() ?? DEFAULT_LIMITS.changeSet,
        );
        const rows: BlobHoldRow[] = [];
        const clock = options.root.journalRetentionClock;
        if (clock === undefined)
          throw new KernelError('UNAVAILABLE', 'Durable archive clock is absent');
        const unit: Extract<BlobArchiveMutation, { t: 'page' }> = {
          t: 'page',
          owner: store.blobOwner,
          generation,
          page,
          clock,
          ...(store.journalRetentionBoundary === undefined
            ? {}
            : { boundary: store.journalRetentionBoundary }),
          rows,
        };
        let bytes = Buffer.byteLength(JSON.stringify(unit));
        while (!next.done && rows.length < limit) {
          if (Date.now() > current.deadline)
            throw new KernelError('BUDGET', 'Archive census deadline exceeded');
          const size = Buffer.byteLength(JSON.stringify(next.value)) + (rows.length === 0 ? 0 : 1);
          if (bytes + size > current.bytes) {
            if (rows.length === 0)
              throw new KernelError('BUDGET', 'Archive census row exceeds its budget');
            break;
          }
          rows.push(next.value);
          bytes += size;
          next = await source.next();
        }
        if (rows.length === 0)
          throw new KernelError('BUDGET', 'Archive census page cannot progress');
        await archiveUnit([unit], current);
        page++;
      }
      const owner = store.blobOwner;
      if (persistent)
        await archiveUnit([{ t: 'seal', owner, generation, pages: page }], allowance());
      else
        return async () => {
          const at = Math.max(
            maintenanceNow(),
            options.root.journalRetentionClock ?? maintenanceNow(),
          );
          for (let number = 0; number < page; number++)
            await archiveUnit([{ t: 'retirePage', owner, generation, page: number, at }]);
          await archiveUnit([{ t: 'seal', owner, generation, pages: page }], allowance());
        };
    } catch (error) {
      if (copiedGeneration === undefined) fatal = { error };
      throw error;
    } finally {
      await source.return?.();
    }
  }

  /** Stages every archive removal for the same atomic activation publication. */
  async function reactivateArchive(
    store: BlobCarrier,
    mutations: BlobArchiveMutation[],
    allowance: {
      nodes: number;
      bytes: number;
      readonly deadline: number;
    },
  ): Promise<void> {
    let generation: Position | undefined,
      pages = 0;
    for await (const unit of options.root.blobArchiveCensus(store.blobOwner)) {
      allowance.nodes--;
      allowance.bytes -= Buffer.byteLength(JSON.stringify(unit));
      if (allowance.nodes < 0 || allowance.bytes < 0 || Date.now() > allowance.deadline)
        throw new KernelError('BUDGET', 'Blob archive activation exceeded its allowance');
      generation = unit.generation;
      if (unit.t === 'page') pages++;
    }
    if (generation === undefined) return;
    for (let page = pages - 1; page >= 0; page--)
      mutations.push({ t: 'removePage', owner: store.blobOwner, generation, page });
    mutations.push({ t: 'remove', owner: store.blobOwner, generation });
  }

  /** Enumerates only the physical carriers explicitly owned by this Store contract. */
  function* referenceCarriers(store: Store): Iterable<BlobCarrier> {
    yield store;
    if (store.blobJournal !== undefined) yield store.blobJournal;
  }

  /** Shared aliases contribute their actual physical carrier once. */
  function carrierInventory(domains: readonly StreamDomain[]): Map<string, BlobCarrier> {
    const carriers = new Map<string, BlobCarrier>();
    for (const domain of domains)
      for (const carrier of referenceCarriers(domain.store))
        if (!carriers.has(carrier.blobOwner)) carriers.set(carrier.blobOwner, carrier);
    return carriers;
  }

  /** Archives only carriers absent from the replacement inventory before this owning handle closes. */
  async function archiveLeaving(store: Store, persistent: boolean, next: readonly StreamDomain[]) {
    const retained = carrierInventory(next),
      releases: (() => Promise<void>)[] = [];
    for (const carrier of referenceCarriers(store)) {
      if (retained.has(carrier.blobOwner)) continue;
      const finish = await archiveCarrier(carrier, persistent);
      if (finish !== undefined) releases.push(finish);
    }
    return async () => {
      for (const finish of releases) await finish();
    };
  }

  /** Returns all final removals for the same atomic owning activation record. */
  async function reactivateCarriers(store: Store) {
    const mutations: BlobArchiveMutation[] = [];
    const allowance = { ...budget() };
    for (const carrier of referenceCarriers(store))
      await reactivateArchive(carrier, mutations, allowance);
    return { mutations, allowance };
  }

  let birthCensus: AsyncIterator<BlobBirth> | undefined;
  let pendingBirth: BlobBirth | undefined;

  /** Checks one bounded upload batch while lifecycle admission excludes pending Store publications. */
  async function collectBlobs(): Promise<void> {
    // Off-route copies publish an incomplete durable census before their first physical write.
    for (const target of copyingTargets.values()) if (!target.sealed) return;

    const blobs = options.blobs;
    if (blobs === undefined) return;
    const clock = options.root.journalRetentionClock;
    if (clock === undefined)
      throw new KernelError('UNAVAILABLE', 'Durable blob maintenance clock is absent');
    const grace = options.maintenance?.orphanMs?.() ?? DEFAULT_LIMITS.blobOrphanMs;
    if (!Number.isFinite(grace) || grace < 0)
      throw new KernelError('INVALID', 'Blob orphan grace is invalid');
    const current = budget(),
      limit = Math.min(
        current.nodes,
        options.maintenance?.changeSet?.() ?? DEFAULT_LIMITS.changeSet,
      );
    const carriers = carrierInventory(inventory);
    birthCensus ??= blobs.census()[Symbol.asyncIterator]();

    const cost = { nodes: 0, bytes: 0, exprWork: 0 };

    /** Shares one remaining budget across every actual carrier consulted for this batch. */
    function remaining(): Budget {
      return {
        ...current,
        nodes: limit - cost.nodes,
        bytes: current.bytes - cost.bytes,
        exprWork: current.exprWork - cost.exprWork,
      };
    }

    /** Adds the owning adapter's actual metadata cost before another read is admitted. */
    function account(result: BlobHoldResult): void {
      cost.nodes += result.cost.nodes;
      cost.bytes += result.cost.bytes;
      cost.exprWork += result.cost.exprWork;
    }

    for (let count = 0; count < limit; count++) {
      if (Date.now() > current.deadline)
        throw new KernelError('BUDGET', 'Blob maintenance deadline exceeded');
      const next =
        pendingBirth === undefined
          ? await birthCensus.next()
          : { done: false, value: pendingBirth };
      if (next.done) {
        birthCensus = undefined;
        return;
      }
      const birth = next.value;
      pendingBirth = undefined;
      if (cost.nodes >= limit) {
        pendingBirth = birth;
        return;
      }
      cost.nodes++;
      cost.bytes += Buffer.byteLength(JSON.stringify(birth));
      if (cost.bytes > current.bytes)
        throw new KernelError('BUDGET', 'Blob birth census exceeded its budget');
      if (birth.retiredAt !== undefined || birth.bornAt + grace >= clock) continue;
      let held = false,
        releasedAt = birth.bornAt;
      try {
        for (const store of carriers.values()) {
          const result = await store.blobHolds([birth.reference.$blob], remaining());
          account(result);
          const hold = result.items[0]!;
          held ||= hold.live + hold.history > 0;
          releasedAt = Math.max(releasedAt, hold.releasedAt);
        }
        const result = await options.root.archivedBlobHolds(
          [birth.reference.$blob],
          clock,
          remaining(),
        );
        account(result);
        const archived = result.items[0]!;
        held ||= archived.live + archived.history > 0;
        releasedAt = Math.max(releasedAt, archived.releasedAt);
      } catch (error) {
        if (error instanceof KernelError && error.code === 'UNAVAILABLE') {
          console.error(error);
          pendingBirth = birth;
          return;
        }
        if (!(error instanceof KernelError && error.code === 'BUDGET') || count === 0) throw error;
        pendingBirth = birth;
        return;
      }
      if (held || releasedAt + grace >= clock) continue;
      try {
        await blobs.delete(birth.reference.$blob);
      } catch (error) {
        if (!(error instanceof KernelError && error.code === 'CONFLICT')) throw error;
      }
    }
  }

  /** Install a complete inventory synchronously; returned work drains its former lookup resources. */
  function installInventory(
    next: readonly StreamDomain[],
    pos: Position,
    changed: readonly DomainId[] = [],
  ) {
    stores.clear();
    domains.clear();
    for (const domain of next) {
      stores.add(domain.store);
      domains.add(domain.store.domain);
    }
    for (const domain of inventory)
      if (!stores.has(domain.store)) {
        cache.retireStore(domain.store);
        maintainedAt.delete(domain.store);
      }
    inventory = [...next];
    domainPins.clear();
    for (const pin of storePins.values()) {
      const domain = pin.registration.target.store.domain;
      let selected = domainPins.get(domain);
      if (selected === undefined) {
        selected = new Set();
        domainPins.set(domain, selected);
      }
      selected.add(pin);
    }
    influence.replaceDomains([...domains], pos, changed);
    const decisionDrain = intake.replaceDomains(next);
    const replay = stream.replaceDomains(next, pos);
    return {
      drained: Promise.all([decisionDrain, replay.drained]).then(() => {}),
      publish: replay.publish,
    };
  }

  /** Retire each exact original and its durable proof in bounded Writer-ordered batches. */
  async function cleanupCopies(
    target: OpenedStoreMountTarget,
    source: Store,
    generation: Position,
    pages: TransferProvenance['pages'],
    writerEpoch: number,
  ): Promise<void> {
    for (const page of pages) {
      for (let offset = 0; offset < page.copies.length; ) {
        const consumed = await lifecycle(async () => {
          const allowance = budget();
          const count = Math.min(
            options.maintenance?.changeSet?.() ?? DEFAULT_LIMITS.changeSet,
            allowance.nodes,
          );
          if (count <= 0) throw new KernelError('BUDGET', 'Physical cleanup cannot progress');
          const originals = page.copies.slice(offset, offset + count);
          const pos = await reservePosition();
          const removed: StoreCommit = {
            pos,
            acceptedAt: maintenanceNow(),
            writerEpoch,
            journalRetentionMs: ownerRetention(source),
            transferBefore: originals,
            writes: originals.map((copy) => ({ path: copy.path, node: null })),
            maintenanceLimits: {
              budget: allowance,
              changeSet: options.maintenance?.changeSet?.() ?? DEFAULT_LIMITS.changeSet,
            },
            record: { pos, kind: 'transfer', executor: 'kernel', caller: 'kernel', entries: [] },
          };
          await source.commit(removed);
          influence.advance(pos);
          stream.publish({ t: 'commit', domain: source.domain, record: removed.record });
          return originals.length;
        });
        offset += consumed;
      }
      await lifecycle(() =>
        archiveUnit([
          { t: 'retireCopyPage', owner: target.store.blobOwner, generation, page: page.page },
        ]),
      );
    }
    await lifecycle(() =>
      archiveUnit([{ t: 'completeTransfer', owner: target.store.blobOwner, generation }]),
    );
    copyingTargets.delete(target);
  }

  /** Resume accepted physical cleanup from archive ownership after the target route has reopened. */
  async function resumeTransfer(
    target: OpenedStoreMountTarget,
    source: Store,
    writerEpoch: number,
    opened?: OpenedStoreMountTarget,
  ): Promise<void> {
    if (!stores.has(target.store))
      throw new KernelError('UNAVAILABLE', 'Transfer destination is not active');
    const proof = await readTransferProvenance(options.root, target.store.blobOwner, budget());
    if (
      proof === undefined ||
      proof.switched === undefined ||
      proof.intent.source !== source.blobOwner
    )
      throw new KernelError('INVALID', 'Transfer cleanup differs from its physical ownership');
    await cleanupCopies(target, source, proof.generation, proof.pages, writerEpoch);
    if (opened !== undefined)
      await lifecycle(async () => {
        const archived = await reactivateCarriers(source);
        if (archived.mutations.length !== 0)
          await archiveUnit(archived.mutations, archived.allowance);
        const released = await archiveLeaving(source, opened.resources.persistent, inventory);
        await closeTarget(opened);
        await released();
      });
  }

  /** Retain a genuinely opened physical source until its archive and handle can retire together. */
  function retainTarget(target: OpenedStoreMountTarget): void {
    ownedTargets.add(target);
  }

  /** Acquire target authority and durable intake before admitting its exact registration. */
  function activateTarget(
    registration: StoreTargetRegistration,
    transfer?: TargetTransferSwitch,
  ): Promise<Position> {
    let cleanup: (() => Promise<void>) | undefined;
    return lifecycle(async () => {
      const owner = options.targetLifecycle;
      const target = registration.target,
        resources = target.resources,
        store = target.store;
      let acceptedRegistration = registration;
      const previous = targets.get(registration.key);
      const releaseOnFailure = !stores.has(store);
      let accepted = false,
        rootAttempted = false;
      let rootAccepted: StoreCommit | undefined;
      const reserved: Position[] = [];
      try {
        checkFailure();
        transfer?.check();
        if (owner === undefined)
          throw new KernelError('INVALID', 'Target lifecycle owner is missing');
        owner.validate(registration);
        if (previous?.startup && !previous.active) {
          if (
            previous.registration.revision !== registration.revision ||
            previous.registration.target !== target
          )
            throw new KernelError('UNAVAILABLE', 'Startup target registration differs');
          const archived = await reactivateCarriers(store);
          if (archived.mutations.length !== 0)
            await archiveUnit(archived.mutations, archived.allowance);
          const pos = stream.cursor().pos;
          previous.active = true;
          previous.generation = ++targetGeneration;
          try {
            owner.publish({ registration: previous.registration, pos, kind: 'activate' });
          } catch (error) {
            fatal = { error };
            throw error;
          }
          return pos;
        }
        if (!Number.isSafeInteger(resources.writerEpoch) || resources.writerEpoch < 0)
          throw new KernelError('INVALID', 'Target writer token is invalid');
        if (stores.has(store)) throw new KernelError('INVALID', 'Store already has a writer owner');
        if (store.transactionOwner !== undefined) {
          if (store.transactionOwner.domain !== store.domain)
            throw new KernelError('INVALID', 'Store transaction owner domain differs');
          for (const sibling of stores)
            if (
              sameStoreOwner(store, sibling) &&
              (storePins.get(sibling)?.writerEpoch ?? options.writerEpoch) !== resources.writerEpoch
            )
              throw new KernelError(
                'CONFLICT',
                'Atomic participants have different fencing tokens',
              );
        }
        const next = inventory.filter(
          (domain) => domain.store !== previous?.registration.target.store,
        );
        next.push({ store, epoch: resources.epoch, persistent: resources.persistent });
        const epochs = Object.fromEntries(streamDomainEpochs(next));
        if (resources.persistent) {
          const result = await store.scan({ range: { journalHead: 'position' }, budget: budget() });
          const last = result.items[0]?.pos;
          if (last !== undefined && last.instance !== options.instance)
            throw new KernelError('INVALID', 'Target belongs to another instance');
          if (last !== undefined && comparePositions(last, position) > 0) {
            const epoch = await options.counter.freshEpoch(Math.max(position.epoch, last.epoch));
            if (!Number.isSafeInteger(epoch) || epoch <= Math.max(position.epoch, last.epoch))
              throw new KernelError('INVALID', 'Instance epoch must be fresh and increasing');
            const floor = { instance: options.instance, epoch, seq: 0 };
            await options.counter.save(floor, options.writerEpoch);
            position = floor;
          }
        }
        owner.validate(registration);
        const fencePos = await reservePosition();
        reserved.push(fencePos);
        const fence: StoreCommit = {
          pos: fencePos,
          acceptedAt: maintenanceNow(),
          journalRetentionMs: ownerRetention(store),
          writerEpoch: resources.writerEpoch,
          writes: [],
          record: {
            pos: fencePos,
            kind: 'kernel',
            executor: 'kernel',
            caller: 'kernel',
            entries: [],
          },
        };
        owner.validate(registration);
        await store.commit(fence);
        owner.validate(registration);
        const archived = await reactivateCarriers(store);
        const pos = await reservePosition();
        reserved.push(pos);
        const root: StoreCommit = {
          pos,
          acceptedAt: maintenanceNow(),
          journalRetentionMs: ownerRetention(options.root),
          writerEpoch: options.writerEpoch,
          writes: [],
          ...(transfer !== undefined || archived.mutations.length === 0
            ? {}
            : {
                blobArchive: archived.mutations,
                maintenanceLimits: {
                  budget: archived.allowance,
                  changeSet: options.maintenance?.changeSet?.() ?? DEFAULT_LIMITS.changeSet,
                },
              }),
          record: {
            pos,
            kind: 'kernel',
            executor: 'kernel',
            caller: 'kernel',
            entries: [],
            intake: intake.next(
              pos,
              transfer !== undefined ||
                previous !== undefined ||
                resources.decisionHistory !== 'fresh',
              epochs,
              transfer === undefined &&
                previous === undefined &&
                resources.decisionHistory === 'fresh',
            ),
          },
        };
        owner.validate(registration);
        // A rejected Store promise can follow durable journal acceptance.
        rootAttempted = true;
        await options.root.commit(root);
        rootAccepted = root;
        let declaration: StoreCommit | undefined;
        let activation: StoreCommit | undefined;
        let declarationTransitions: readonly NodeChange[] = [];
        if (transfer !== undefined) {
          transfer.check();
          const declarationPos = await reservePosition();
          reserved.push(declarationPos);
          const prepared = await transfer.prepare(declarationPos);
          prepared.check?.();
          declarationTransitions = prepared.transitions ?? [];
          acceptedRegistration = prepared.registration;
          if (
            acceptedRegistration.key !== registration.key ||
            acceptedRegistration.target !== target
          )
            throw new KernelError('INVALID', 'Transfer switch changed its physical owner');
          const declarationBudget = prepared.budget ?? budget();
          declaration = {
            pos: declarationPos,
            acceptedAt: maintenanceNow(),
            writerEpoch:
              storePins.get(transfer.declarationStore)?.writerEpoch ?? options.writerEpoch,
            writes: prepared.writes,
            record: prepared.record,
            journalRetentionMs: ownerRetention(transfer.declarationStore),
            maintenanceLimits: {
              budget: declarationBudget,
              changeSet: options.maintenance?.changeSet?.() ?? DEFAULT_LIMITS.changeSet,
            },
          };
          const image = prepared.writes[0]?.node;
          if (prepared.writes.length !== 1 || image === null || image === undefined)
            throw new KernelError('INVALID', 'Transfer switch requires one declaring image');
          await transfer.declarationStore.commit(declaration);
          const owner: AcceptedNodeRead = Object.freeze({
            [acceptedNodeOwner]: true as const,
            path: image.$path,
            id: image.$id,
          });
          acceptedNodeReads.set(owner, async () => {
            const read = await transfer.declarationStore.scan({
              range: { node: image.$path },
              budget: declarationBudget,
            });
            const node = read.items[0];
            if (
              read.items.length !== 1 ||
              node === undefined ||
              node.$id !== image.$id ||
              comparePositions(node.$pos, declarationPos) !== 0
            )
              throw new KernelError(
                'INVALID',
                'Committed declaring image differs from its switch owner',
              );
            return node;
          });
          try {
            await prepared.accepted(owner);
          } finally {
            acceptedNodeReads.delete(owner);
          }
          const copying = copyingTargets.get(target);
          const generation = copying?.carriers.get(store);
          if (generation === undefined || copying?.sealed !== true)
            throw new KernelError('INVALID', 'Transfer copy has no sealed ownership');
          const archiveMutations: BlobArchiveMutation[] = [
            ...archived.mutations,
            { t: 'switchTransfer', owner: store.blobOwner, generation, pos: declarationPos },
          ];
          if (archiveMutations.length !== 0) {
            const activationPos = await reservePosition();
            reserved.push(activationPos);
            activation = {
              pos: activationPos,
              acceptedAt: maintenanceNow(),
              writerEpoch: options.writerEpoch,
              writes: [],
              blobArchive: archiveMutations,
              journalRetentionMs: ownerRetention(options.root),
              maintenanceLimits: {
                budget: archived.allowance,
                changeSet: options.maintenance?.changeSet?.() ?? DEFAULT_LIMITS.changeSet,
              },
              record: {
                pos: activationPos,
                kind: 'kernel',
                caller: 'kernel',
                executor: 'kernel',
                entries: [],
              },
            };
            await options.root.commit(activation);
          }
        }
        accepted = true;
        ownedTargets.add(target);
        const pin: TargetPin = {
          registration: acceptedRegistration,
          writerEpoch: resources.writerEpoch,
          active: true,
          generation: ++targetGeneration,
        };
        if (previous !== undefined) {
          previous.active = false;
          previous.retirement = 'requested';
          storePins.delete(previous.registration.target.store);
        }
        targets.set(registration.key, pin);
        storePins.set(store, pin);
        const drained = installInventory(next, fencePos, [store.domain]);
        const fenceEvent = applyKernel(store, fence);
        const rootEvent = applyKernel(options.root, root);
        const declarationEvent =
          declaration === undefined
            ? undefined
            : applyKernel(transfer!.declarationStore, declaration, declarationTransitions);
        const activationEvent =
          activation === undefined ? undefined : applyKernel(options.root, activation);
        owner.publish({
          registration: acceptedRegistration,
          pos: declaration?.pos ?? pos,
          kind: 'activate',
        });
        drained.publish();
        stream.publish(fenceEvent);
        stream.publish(rootEvent);
        if (declarationEvent !== undefined) stream.publish(declarationEvent);
        if (activationEvent !== undefined) stream.publish(activationEvent);
        await drained.drained;
        if (transfer !== undefined) {
          const source = transfer.source;
          const pages = transfer.removed;
          const copying = copyingTargets.get(target);
          const generation = copying?.carriers.get(store);
          if (copying === undefined || generation === undefined)
            throw new KernelError('INVALID', 'Transfer cleanup has no ownership');
          cleanup = async () => {
            await cleanupCopies(
              target,
              source,
              generation,
              pages.map((copies, page) => ({ page: copying.firstPage + page, copies })),
              previous?.registration.target.store === source
                ? previous.writerEpoch
                : (storePins.get(source)?.writerEpoch ?? options.writerEpoch),
            );
            if (previous !== undefined)
              await lifecycle(async () => {
                const released = await archiveLeaving(
                  previous.registration.target.store,
                  previous.registration.target.resources.persistent,
                  inventory,
                );
                await closeTarget(previous.registration.target);
                await released();
                previous.retirement = 'complete';
              });
          };
        } else if (previous !== undefined) {
          const released = await archiveLeaving(
            previous.registration.target.store,
            previous.registration.target.resources.persistent,
            next,
          );
          await closeTarget(previous.registration.target);
          await released();
          previous.retirement = 'complete';
        }
        return declaration?.pos ?? pos;
      } catch (error) {
        console.error(error);
        if (!accepted && transfer !== undefined && rootAccepted !== undefined) {
          try {
            const read = await transfer.declarationStore.scan({
              range: { node: transfer.before.$path },
              budget: budget(),
            });
            if (read.items.length === 1 && isDeepStrictEqual(read.items[0], transfer.before)) {
              const pos = await reservePosition();
              const recovery: StoreCommit = {
                pos,
                acceptedAt: maintenanceNow(),
                writerEpoch: options.writerEpoch,
                writes: [],
                journalRetentionMs: ownerRetention(options.root),
                record: {
                  pos,
                  kind: 'kernel',
                  caller: 'kernel',
                  executor: 'kernel',
                  entries: [],
                  intake: intake.next(pos, true, Object.fromEntries(streamDomainEpochs(inventory))),
                },
              };
              await options.root.commit(recovery);
              stream.publish(applyKernel(options.root, rootAccepted));
              for (const gap of reserved)
                if (comparePositions(gap, rootAccepted.pos) > 0) {
                  influence.advance(gap);
                  stream.publish({ t: 'gap', pos: gap });
                }
              stream.publish(applyKernel(options.root, recovery));
              transfer.rejected();
              rootAttempted = false;
            }
          } catch (recoveryError) {
            fatal = { error: recoveryError };
            throw new AggregateError(
              [error, recoveryError],
              'Transfer refusal and intake recovery failed',
            );
          }
        }
        if (rootAttempted && (!accepted || transfer === undefined)) fatal = { error };
        if (!accepted) {
          if (!rootAttempted && rootAccepted === undefined)
            for (const pos of reserved) {
              influence.advance(pos);
              stream.publish({ t: 'gap', pos });
            }
          if (releaseOnFailure && transfer === undefined)
            try {
              await closeTarget(target);
            } catch (closeError) {
              throw new AggregateError([error, closeError], 'Target activation and release failed');
            }
        }
        throw error;
      }
    }).then(async (pos) => {
      await cleanup?.();
      if (registration.target.store.maintenancePending === true)
        void maintain(registration.target.store).catch((error) => {
          console.error(error);
        });
      return pos;
    });
  }

  /** Retire lookup authority durably before releasing its owned Store. */
  function retireTarget(key: string, revision: Rev): Promise<Position> {
    const pinned = targets.get(key);
    if (pinned === undefined || pinned.registration.revision !== revision)
      return Promise.reject(new KernelError('UNAVAILABLE', 'Target registration changed'));
    pinned.active = false;
    pinned.retirement = 'requested';
    return lifecycle(async () => {
      let rootAttempted = false,
        pos: Position | undefined;
      try {
        checkFailure();
        if (targets.get(key) !== pinned)
          throw new KernelError('UNAVAILABLE', 'Target registration changed');
        const next = inventory.filter(
          (domain) => domain.store !== pinned.registration.target.store,
        );
        const retiring = pinned.registration.target;
        const retainedOwner =
          retiring.store.transactionOwner !== undefined &&
          retiring.resources.decisionHistory !== 'unconfirmed' &&
          next.some((domain) => {
            const sibling = storePins.get(domain.store);
            return (
              sameStoreOwner(retiring.store, domain.store) &&
              domain.epoch === retiring.resources.epoch &&
              (sibling === undefined
                ? domain.persistent
                : sibling.active &&
                  sibling.registration.target.resources.decisionHistory !== 'unconfirmed')
            );
          });
        const released = await archiveLeaving(retiring.store, retiring.resources.persistent, next);
        pos = await reservePosition();
        const root: StoreCommit = {
          pos,
          acceptedAt: maintenanceNow(),
          journalRetentionMs: ownerRetention(options.root),
          writerEpoch: options.writerEpoch,
          writes: [],
          record: {
            pos,
            kind: 'kernel',
            executor: 'kernel',
            caller: 'kernel',
            entries: [],
            intake: intake.next(pos, !retainedOwner, Object.fromEntries(streamDomainEpochs(next))),
          },
        };
        // The Store contract cannot distinguish pre-effect refusal from failed durable publication.
        rootAttempted = true;
        await options.root.commit(root);
        targets.delete(key);
        storePins.delete(pinned.registration.target.store);
        const drained = installInventory(next, pos);
        const rootEvent = applyKernel(options.root, root);
        options.targetLifecycle!.publish({
          registration: pinned.registration,
          pos,
          kind: 'retire',
        });
        drained.publish();
        stream.publish(rootEvent);
        await drained.drained;
        await closeTarget(pinned.registration.target);
        await released?.();
        pinned.retirement = 'complete';
        return pos;
      } catch (error) {
        console.error(error);
        if (rootAttempted) fatal = { error };
        else if (pos !== undefined) {
          influence.advance(pos);
          stream.publish({ t: 'gap', pos });
        }
        throw error;
      }
    });
  }
  /** Drain accepted work and release mounted resources while preserving the borrowed root authority. */
  function closeTargets(): Promise<void> {
    if (closedTargets !== undefined) return closedTargets;
    closing = true;
    const dependencies = new Set([
      admission,
      reservation,
      publication,
      maintenanceTail,
      ...writers.values(),
    ]);
    for (const active of readers.values()) for (const done of active) dependencies.add(done);
    closedTargets = (async () => {
      await Promise.all(dependencies);
      await birthCensus?.return?.();
      birthCensus = undefined;
      const archived = new Set<string>(),
        borrowed = carrierInventory(options.domains);
      const released = new Map<OpenedStoreMountTarget, () => Promise<void>>();
      for (const target of ownedTargets) {
        const releases: (() => Promise<void>)[] = [];
        for (const carrier of referenceCarriers(target.store)) {
          if (archived.has(carrier.blobOwner) || borrowed.has(carrier.blobOwner)) continue;
          const finish = await archiveCarrier(
            carrier,
            target.resources.persistent,
            copyingTargets.get(target)?.carriers.get(carrier),
          );
          if (finish !== undefined) releases.push(finish);
          archived.add(carrier.blobOwner);
        }
        if (releases.length !== 0)
          released.set(target, async () => {
            for (const finish of releases) await finish();
          });
      }
      await Promise.all([
        intake.replaceDomains(options.domains),
        stream.replaceDomains(options.domains, position).drained,
      ]);
      const failures: unknown[] = [];
      for (const pin of targets.values()) pin.active = false;
      for (const target of ownedTargets) {
        try {
          await closeTarget(target);
          await released.get(target)?.();
        } catch (error) {
          failures.push(error);
        }
      }
      targets.clear();
      storePins.clear();
      domainPins.clear();
      if (failures.length !== 0)
        throw new AggregateError(failures, 'Target resource release failed');
    })();
    return closedTargets;
  }
  /** Coordinates one ordered mutation, including its unfinished stream anchors. */
  async function mutate(
    input: MutationIdentity,
    execute: (span: MutationSpan) => Promise<unknown>,
    wait?: MutationWaiter,
  ): Promise<Outcome> {
    checkFailure();
    return intake.run(
      input,
      () => refreshIntake(),
      async (decision) => {
        let ioStarted = false;
        let started = false,
          pending = false,
          outcome: Outcome | undefined;
        let stream = input.stream,
          currentDecision = decision,
          anchor = decision;
        /** Recheck the original started decision inside each ordered preparation, including finalization. */
        async function validateAnchor(): Promise<void> {
          if (input.anchor === undefined && !started) return;
          if (stream === undefined)
            throw new KernelError('INVALID', 'Only a stream may continue an anchor');
          const anchorId = input.anchor ?? input.opId;
          if (anchorId.time < intake.boundary())
            throw new KernelError('EXPIRED', 'Stream anchor has expired');
          const record = await intake.lookup(
            input.actor.principal,
            anchorId,
            input.anchorLookupCost,
          );
          if (record === undefined) {
            intake.checkAdmitted(anchorId);
            throw new KernelError('INVALID', 'Stream anchor is absent');
          }
          const found = matchingDecision(record, input.actor.principal, anchorId);
          if (
            found.outcome !== undefined ||
            found.stream === undefined ||
            found.stream.executor !== stream.executor ||
            found.stream.target !== stream.target
          )
            throw new KernelError(
              'INVALID',
              'Stream anchor does not name this unfinished execution',
            );
          anchor = found;
        }
        await validateAnchor();
        async function apply(
          store: Store,
          reads: readonly DomainId[],
          prepare: (pos: Position) => PreparedMutation | Promise<PreparedMutation>,
          finish: boolean,
        ): Promise<Position> {
          if (pending || outcome !== undefined)
            throw new KernelError('INVALID', 'Mutation steps must be ordered and finish once');
          pending = true;
          try {
            let final: Outcome | undefined;
            const position = await commit(
              store,
              [...new Set([...reads, options.root.domain])],
              async (pos) => {
                intake.checkAdmitted(input.opId);
                await validateAnchor();
                const prepared = await prepare(pos);
                if (prepared.record.caller !== input.actor.principal)
                  throw new KernelError('INVALID', 'Mutation caller differs from its journal');
                const value: Outcome = structuredClone({
                  pos,
                  ...(Object.hasOwn(prepared, 'value') ? { value: prepared.value } : {}),
                });
                const record = {
                  ...prepared.record,
                  ...(finish || !started
                    ? {
                        decision: { ...currentDecision, ...(finish ? { outcome: value } : {}) },
                      }
                    : {}),
                  ...(finish && input.anchor !== undefined
                    ? {
                        anchorDecision: { ...anchor, outcome: value },
                      }
                    : {}),
                };
                if (finish) final = value;
                return { ...prepared, record };
              },
            );
            if (finish) outcome = final;
            return position;
          } finally {
            pending = false;
          }
        }
        const span: MutationSpan = {
          get anchor() {
            return anchor;
          },
          async beginIo(executor, check) {
            if (ioStarted) return;
            if (pending || outcome !== undefined)
              throw new KernelError('INVALID', 'I/O admission must precede mutation completion');
            await commit(options.root, [options.root.domain], (pos) => {
              check();
              intake.checkAdmitted(input.opId);
              return {
                writes: [],
                budget: input.anchorLookupCost?.budget() ?? budget(),
                check,
                record: {
                  pos,
                  kind: 'kernel',
                  caller: input.actor.principal,
                  executor,
                  entries: [],
                  decision: currentDecision,
                },
              };
            });
            ioStarted = true;
          },
          async beginStream(metadata) {
            if (
              stream !== undefined &&
              (stream.executor !== metadata.executor || stream.target !== metadata.target)
            )
              throw new KernelError('INVALID', 'Stream execution identity changed');
            stream = metadata;
            currentDecision = { ...decision, stream: metadata };
            if (input.anchor === undefined && !started) anchor = currentDecision;
            await validateAnchor();
          },
          validateAnchor,
          async step(store, reads, prepare) {
            if (stream === undefined)
              throw new KernelError('INVALID', 'Only a stream has intermediate mutation steps');
            const pos = await apply(store, reads, prepare, false);
            started = true;
            return pos;
          },
          async finish(store, reads, prepare) {
            await apply(store, reads, prepare, true);
            return structuredClone(outcome!);
          },
        };
        await execute(span);
        if (outcome === undefined)
          throw new KernelError('INVALID', 'Mutation returned without its durable final outcome');
        return outcome;
      },
      wait,
    );
  }
  /** A continuation translates only an admitted original caller's durable forwarding anchor. */
  async function forwardAnchor(
    principal: Principal,
    opId: OpId,
    cost: OperationReadCost,
    wait: MutationWaiter,
  ): Promise<FederationForward> {
    checkFailure();
    if (opId.time < intake.boundary())
      throw new KernelError('EXPIRED', 'Forwarding anchor has expired');
    const record = await wait(intake.lookup(principal, opId, cost));
    if (record === undefined) {
      intake.checkAdmitted(opId);
      throw new KernelError('INVALID', 'Forwarding anchor is absent');
    }
    const decision = matchingDecision(record, principal, opId);
    if (decision.forward === undefined || decision.outcome !== undefined)
      throw new KernelError('INVALID', 'Forwarding anchor does not name an unfinished execution');
    return structuredClone(decision.forward);
  }
  /** Persist the exact foreign request before sending and resume only that accepted request. */
  async function forward(input: ForwardMutation): Promise<Outcome> {
    checkFailure();
    input.check();
    async function persist(decision: OpDecision): Promise<void> {
      input.check(decision.forward);
      const bytes = Buffer.byteLength(JSON.stringify(decision));
      input.cost.charge(1, bytes);
      const allowance = input.cost.budget();
      await commit(options.root, [options.root.domain], (pos) => ({
        writes: [],
        budget: allowance,
        check: () => input.check(decision.forward),
        record: {
          pos,
          kind: 'kernel',
          caller: input.identity.actor.principal,
          executor: input.identity.actor.principal,
          entries: [],
          decision,
        },
      }));
    }
    async function resume(decision: OpDecision): Promise<Outcome> {
      const saved = decision.forward;
      if (saved === undefined) throw new KernelError('INVALID', 'Forwarding request is absent');
      input.check(saved);
      const outcome = await input.execute(structuredClone(saved));
      input.check(saved);
      await persist({ ...decision, outcome });
      return structuredClone(outcome);
    }
    return intake.run(
      { ...input.identity, lookupCost: input.cost },
      () => refreshIntake(),
      async (decision) => {
        const request = await input.prepare();
        input.check(request);
        if (request.request.kind === 'act' && request.request.value.pre.kind === 'read')
          return input.execute(request);
        const prepared = { ...decision, forward: structuredClone(request) };
        await persist(prepared);
        return resume(prepared);
      },
      input.wait,
      resume,
      input.check,
    );
  }
  /** Accept complete physical images under the target's actual fencing token and global order. */
  async function reconcile(
    store: Store,
    paths: readonly string[],
    validate?: (
      changes: readonly NodeChange[],
      unknown: readonly UnknownExternalImage[],
    ) => void | Promise<void>,
    current?: NonNullable<Store['readExternal']>,
    options: { readonly recovery?: boolean; readonly budget?: Budget } = {},
  ): Promise<Position | undefined> {
    if (store.external === undefined || store.readExternal === undefined)
      throw new KernelError('INVALID', 'External Store reporting and reads must be paired');
    const readExternal = current ?? store.readExternal;
    const recovery = options.recovery === true;
    const allowance = options.budget ?? budget(),
      cost = { nodes: 0, bytes: 0, exprWork: 0 };
    const remaining = (): Budget => ({
      ...allowance,
      nodes: allowance.nodes - cost.nodes,
      bytes: allowance.bytes - cost.bytes,
      exprWork: allowance.exprWork - cost.exprWork,
    });
    const first = await read([store.domain], () => readExternal(paths, remaining()), recovery);
    if (first.next !== undefined)
      throw new KernelError('BUDGET', 'External reconciliation needs a bounded complete batch');
    if (first.cost === undefined)
      throw new KernelError('INVALID', 'External Store read has no inspected cost');
    cost.nodes += first.cost.nodes;
    cost.bytes += first.cost.bytes;
    cost.exprWork += first.cost.exprWork;
    if (first.items.length === 0) return undefined;
    let selected = first;
    return applyCommit(
      store,
      [store.domain],
      async (pos) => {
        const writes: StoredWrite[] = [],
          entries: JournalEntry[] = [],
          transitions: NodeChange[] = [];
        const quarantine = [];
        const unknown: UnknownExternalImage[] = [];
        const ids = new Set<string>();
        for (const image of selected.items) {
          assertSafePath(image.path);
          if ('fault' in image) {
            quarantine.push(image);
            continue;
          }
          if (image.before === 'unknown') {
            if (image.id.length === 0 || ids.has(image.id))
              throw new KernelError('INVALID', 'External stored identity is invalid');
            const after = image.after === null ? null : { ...image.after, $pos: pos };
            if (
              after !== null &&
              (after.$path !== image.path || after.$id !== image.id || !after.$type)
            )
              throw new KernelError('INVALID', 'External current image differs from its identity');
            ids.add(image.id);
            unknown.push(image);
            writes.push({ path: image.path, node: after });
            entries.push({ id: image.id, path: image.path, change: { t: 'reconcile', after } });
            continue;
          }
          const before = image.before,
            after = image.after === null ? null : { ...image.after, $pos: pos };
          if (after !== null) {
            if (
              after.$path !== image.path ||
              !after.$id ||
              !after.$type ||
              (after.$id.startsWith('p:') && after.$id !== `p:${image.path}`) ||
              ids.has(after.$id)
            )
              throw new KernelError('INVALID', 'External stored identity is invalid');
            ids.add(after.$id);
          }
          writes.push({ path: image.path, node: after });
          if (
            before !== null &&
            after !== null &&
            (before.$id !== after.$id || before.$type !== after.$type)
          ) {
            entries.push({ id: before.$id, path: image.path, change: { t: 'delete', before } });
            entries.push({ id: after.$id, path: image.path, change: { t: 'create', after } });
            transitions.push(
              { id: before.$id, before, after: null },
              { id: after.$id, before: null, after },
            );
          } else {
            const id = after?.$id ?? before?.$id;
            if (id === undefined)
              throw new KernelError('INVALID', 'External transition has no identity');
            entries.push({ id, path: image.path, change: { t: 'reconcile', before, after } });
            transitions.push({ id, before, after });
          }
        }
        await validate?.(transitions, unknown);
        return {
          writes,
          ...(unknown.length === 0 ? { transitions } : {}),
          record: {
            pos,
            kind: 'reconcile',
            caller: `external:${store.domain}`,
            executor: `external:${store.domain}`,
            entries,
            ...(quarantine.length === 0 ? {} : { quarantine }),
          },
        };
      },
      async () => {
        selected = await readExternal(paths, remaining());
        if (selected.next !== undefined)
          throw new KernelError('BUDGET', 'External reconciliation needs a bounded complete batch');
        if (selected.cost === undefined)
          throw new KernelError('INVALID', 'External Store read has no inspected cost');
        cost.nodes += selected.cost.nodes;
        cost.bytes += selected.cost.bytes;
        cost.exprWork += selected.cost.exprWork;
        if (
          Date.now() > allowance.deadline ||
          cost.nodes > allowance.nodes ||
          cost.bytes > allowance.bytes ||
          cost.exprWork > allowance.exprWork
        )
          throw new KernelError('BUDGET', 'External reconciliation read budget exceeded');
        return selected.items.length !== 0;
      },
      false,
      undefined,
      recovery,
    );
  }

  /** Hold only the lost observation domain while bounded current images regain accepted positions. */
  async function recover(
    store: Store,
    run: (members: readonly Store[], accept: typeof reconcile) => Promise<void>,
  ): Promise<void> {
    checkFailure();
    if (!stores.has(store)) throw new KernelError('INVALID', 'Unknown external recovery domain');
    const prior = recovering.get(store.domain);
    const dependencies = [writers.get(store.domain), prior, ...(readers.get(store.domain) ?? [])];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    recovering.set(store.domain, gate);
    try {
      await Promise.all(dependencies);
      const members: Store[] = [];
      for (const member of stores) if (member.domain === store.domain) members.push(member);
      await run(members, (member, paths, validate, current) => {
        if (member.domain !== store.domain)
          throw new KernelError('INVALID', 'External recovery crosses owner domains');
        return reconcile(member, paths, validate, current, { recovery: true });
      });
    } catch (error) {
      failedObservations.add(store.domain);
      throw error;
    } finally {
      if (recovering.get(store.domain) === gate) recovering.delete(store.domain);
      release();
    }
  }
  function replay(input: MutationIdentity, wait?: MutationWaiter): Promise<Outcome | undefined> {
    checkFailure();
    return intake.previous(input, wait);
  }
  /** Deny reads and writes in a native domain whose observation cannot be recovered safely. */
  function failObservation(store: Store): void {
    if (!stores.has(store)) throw new KernelError('INVALID', 'Unknown external observation domain');
    failedObservations.add(store.domain);
  }

  for (const store of stores)
    if (!startupStores.has(store) && store.maintenancePending === true)
      void maintain(store).catch((error) => {
        console.error(error);
      });

  return {
    stream,
    cache,
    influence,
    get position(): Position {
      return { ...position };
    },
    get intake() {
      return intake.state;
    },
    commit,
    copyTarget,
    sealCopiedTarget,
    finishCopyRetry,
    resumeTransfer,
    retainTarget,
    read,
    mutate,
    forward,
    forwardAnchor,
    replay,
    reconcile,
    recover,
    failObservation,
    refreshIntake,
    publishShardIntake,
    maintain,
    activateTarget,
    retireTarget,
    closeTargets,
  };
}

export type Writer = Awaited<ReturnType<typeof createWriter>>;
