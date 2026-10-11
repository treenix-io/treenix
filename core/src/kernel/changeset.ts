import { ancestorPaths, assertSafePath, dirname, isChildPath } from '#core/path'
import { isDeepStrictEqual } from 'node:util'
import { KernelError } from '#errors'
import { validateBlobReferences } from '#kernel/blobs'
import { runStoreScan, type OperationReadCost } from '#kernel/store/budget'
import { sameStoreOwner } from '#kernel/store/owner'
import type { ActionProvenance } from '#kernel/action-guard'
import type { CacheRead, ProcessCache } from '#kernel/cache'
import type { CapabilityState } from '#kernel/capability'
import { createGuard } from '#kernel/guard'
import { encodeJournalEntry, readJournalImages } from '#kernel/journal'
import { createMigrator } from '#kernel/migrate'
import { comparePositions } from '#kernel/position'
import type { createReader, ReaderSource } from '#kernel/reader'
import { checkPreconditions, type PreconditionOptions, type ReadSet } from '#kernel/preconditions'
import { DEFAULT_LIMITS, type Actor, type Budget, type ChangeMember, type Component, type Executor, type JournalAddress, type JournalEntry,
  type Principal,
  type BlobStore, type Limits, type NodeInput, type Position, type Registry, type ScanRange, type Selector, type Store, type StoredNode } from '#kernel/types'
import { applyUpdateOps, assertNoPrototypeKeys, assertUpdateOps } from '#kernel/update-ops'
import type { PreparedCommit } from '#kernel/writer'
import { ulid } from '#util/ulid'

export interface NodeChange {
  readonly id: string
  readonly before: StoredNode | null
  readonly after: StoredNode | null
}
/** A mapped move preserves an already-issued identity after its genuine source leaves the decision. */
export interface NodeRelocation {
  readonly source: StoredNode
  readonly id: string
}
export interface ChangeSetOptions {
  readonly store: Store
  readonly cache: ProcessCache
  readonly registry: Registry
  readonly limits?: Limits
  readonly budget?: Budget
  readonly readCost?: OperationReadCost
  readonly resolve?: (path: string) => Store
  readonly boundary?: (path: string) => boolean
  readonly readBefore?: (path: string) => Promise<StoredNode | null>
  readonly capabilities?: CapabilityState
  readonly preconditions?: Omit<PreconditionOptions, 'position'>
  readonly blobs?: BlobStore
  readonly mapping?: ChangeSetMapping
  readonly relocations?: ReadonlyMap<string, NodeRelocation>
  readonly recreateBodies?: ReadonlyMap<string, StoredNode>
  readonly actionChanges?: readonly NodeChange[]
  readonly scopePath?: (path: string) => string
}

/** An operation-owned binding validates logical changes before producing physical Store writes. */
export interface ChangeSetMapping {
  close(): void
  adopt(from: string, to: string): void
  read(range: ScanRange): Promise<readonly StoredNode[] | undefined>
  prepare(changes: readonly NodeChange[], budget: Budget): Promise<PreparedChangeSet | undefined>
}
export interface PreparedChangeSet extends PreparedCommit {
  readonly transitions: readonly NodeChange[]
  readonly logicalWrites?: readonly { readonly path: string; readonly node: StoredNode | null }[]
}
import type { ShardRights } from '#kernel/auth-factory'

export type ChangeExecutor =
  | { readonly executor: 'kernel' | `external:${string}`; readonly caller: Executor; readonly expect?: ReadSet }
  | { readonly executor: Principal; readonly caller: Executor; readonly actor: Actor; readonly shard?: ShardRights; readonly expect?: ReadSet; readonly action?: ActionProvenance }

function component(input: Component, registry: Registry): Component {
  const def = registry.type(input.$type)
  if (input.$v !== undefined && input.$v !== def.version) throw new KernelError('INVALID', 'Component version differs from the current schema')
  return { ...input, $type: def.name, $v: def.version }
}

function normalize(input: NodeInput, before: StoredNode | null, pos: Position, registry: Registry, relocated?: string): StoredNode {
  assertNoPrototypeKeys(input, input.$path)
  for (const field of ['$id', '$rev', '$pos']) {
    if (Object.hasOwn(input, field)) throw new KernelError('INVALID', `Kernel metadata in write input: ${field}`)
  }
  const main = component(input, registry)
  if (before !== null && registry.type(before.$type).name !== main.$type) throw new KernelError('CONFLICT', 'Another type occupies the address')
  const named: Record<`#${string}`, Component> = {}
  for (const key of Object.keys(input)) if (key.startsWith('#')) {
    const name = key as `#${string}`
    named[name] = component(input[name], registry)
  }
  return { ...input, ...main, ...named, $path: input.$path, $type: main.$type,
    $id: before === null ? relocated ?? ulid() : before.$id, $pos: pos }
}

/** Installs only the source owner's operation-bound mapping before preparing one canonical decision. */
export function prepareRoutedChangeSet(source: ReaderSource, options: ChangeSetOptions,
  changes: readonly ChangeMember[], position: Position, executor: ChangeExecutor): Promise<PreparedChangeSet> {
  const mapping = source.mapping?.(options, changes, position, executor)
  return prepareChangeSet(mapping === undefined ? options : { ...options, mapping }, changes, position, executor)
}

/** Run inside the writer's prepare callback: the cache and same-domain reads then precede the commit. */
export async function prepareChangeSet(
  options: ChangeSetOptions,
  changes: readonly ChangeMember[],
  pos: Position,
  who: ChangeExecutor = { executor: 'kernel', caller: 'kernel' },
): Promise<PreparedChangeSet> {
  const { store, cache, registry } = options,
    limits = options.limits ?? DEFAULT_LIMITS;
  const budget = options.budget ?? {
    nodes: limits.readNodes,
    bytes: limits.readBytes,
    exprWork: limits.exprWork,
    deadline: Date.now() + limits.queryMs,
  };
  const states = new Map<string, StoredNode | null>(),
    initial = new Map<string, StoredNode | null>(),
    final = new Map<string, StoredNode | null>();
  const originals = new Map<string, StoredNode | null>();
  const leases: CacheRead[] = [],
    loaded = new Set<string>();
  let readBytes = 0,
    transitions = 0;
  if ('actor' in who && who.actor.principal !== who.executor)
    throw new KernelError('INVALID', 'Executor and actor differ');
  const guard = createGuard({
    registry,
    executor: 'actor' in who ? who.actor : who.executor,
    shard: 'actor' in who ? who.shard : undefined,
    readBefore: options.readBefore ?? original,
    capabilities: options.capabilities,
    expect: 'actor' in who ? who.expect : undefined,
    action: 'actor' in who ? who.action : undefined,
    actionChanges: options.actionChanges,
    scopePath: options.scopePath,
  });
  const migrator = createMigrator((type) => ({
    version: registry.type(type).version,
    steps: registry.security(type, 'migrate') ?? [],
  }));

  function path(value: string): void {
    try {
      assertSafePath(value);
    } catch (error) {
      console.error(error);
      throw new KernelError('INVALID', `Invalid node path: ${value}`);
    }
    if (options.resolve !== undefined && !sameStoreOwner(options.resolve(value), store))
      throw new KernelError('CROSS_DOMAIN', 'ChangeSet spans atomic Store owners');
  }
  function touch(before: StoredNode | null, after: StoredNode | null, at: string): void {
    if (++transitions > limits.changeSet)
      throw new KernelError('BUDGET', 'ChangeSet transition budget exceeded');
    if (after !== null && Buffer.byteLength(JSON.stringify(after)) > limits.nodeBytes)
      throw new KernelError('BUDGET', 'Node byte budget exceeded');
    if (before !== null) {
      if (!initial.has(before.$id)) initial.set(before.$id, before);
      final.set(before.$id, after);
    } else if (after !== null) {
      if (!initial.has(after.$id)) initial.set(after.$id, null);
      final.set(after.$id, after);
    }
    states.set(at, after);
  }
  async function load(range: ScanRange): Promise<readonly StoredNode[]> {
    let nodes = await options.mapping?.read(range);
    if (nodes === undefined) {
      const at = 'node' in range ? range.node : 'children' in range ? range.children : range.subtree;
      const local = options.resolve?.(at) ?? store;
      if (!sameStoreOwner(local, store)) throw new KernelError('CROSS_DOMAIN', 'ChangeSet spans atomic Store owners');
      const lease = await cache.fill(local, range, options.readCost?.budget() ?? budget);
      leases.push(lease);
      nodes = lease.nodes;
    }
    if (options.readCost !== undefined)
      for (const node of nodes)
        options.readCost.charge(1, Buffer.byteLength(JSON.stringify(node)));
    for (const node of nodes)
      if (!loaded.has(node.$path)) {
        loaded.add(node.$path);
        readBytes += Buffer.byteLength(JSON.stringify(node));
        if (loaded.size > budget.nodes || readBytes > budget.bytes)
          throw new KernelError('BUDGET', 'ChangeSet read budget exceeded');
        originals.set(node.$path, node);
        if (!states.has(node.$path)) states.set(node.$path, node);
      }
    return nodes;
  }
  async function original(at: string): Promise<StoredNode | null> {
    const known = originals.get(at);
    if (known !== undefined) return known;
    const node = (await load({ node: at }))[0] ?? null;
    originals.set(at, node);
    return node;
  }
  async function get(at: string): Promise<StoredNode | null> {
    const known = states.get(at);
    if (known !== undefined) return known;
    const node = (await load({ node: at }))[0] ?? null;
    states.set(at, node);
    return node;
  }
  async function subtree(at: string): Promise<readonly StoredNode[]> {
    if (options.boundary?.(at)) {
      const node = await get(at);
      return node === null ? [] : [node];
    }
    const nodes = new Map((await load({ subtree: at })).map((node) => [node.$path, node]));
    for (const [child, node] of states)
      if (child === at || isChildPath(at, child, false)) {
        if (node === null) nodes.delete(child);
        else nodes.set(child, node);
      }
    return [...nodes.values()].filter(
      (node) =>
        !ancestorPaths(node.$path).some(
          (parent) =>
            parent !== node.$path &&
            (parent === at || isChildPath(at, parent, false)) &&
            options.boundary?.(parent),
        ),
    );
  }
  async function remove(at: string): Promise<void> {
    for (const before of await subtree(at)) touch(before, null, before.$path);
  }
  async function move(from: string, to: string): Promise<void> {
    path(from);
    path(to);
    if (from === '/' || to === '/' || from === to || isChildPath(from, to, false)) {
      throw new KernelError('INVALID', 'Invalid move addresses');
    }
    if ((await get(from)) === null) throw new KernelError('NOT_FOUND', 'Move source is absent');
    const nodes = await subtree(from);
    if ((await subtree(to)).length !== 0)
      throw new KernelError('CONFLICT', 'Move destination is occupied');
    for (const before of nodes) {
      const at = to + before.$path.slice(from.length);
      path(at);
      const current = migrator.migrate(before);
      if (before.$id.startsWith('p:')) {
        touch(before, null, before.$path);
        touch(null, { ...current, $id: ulid(), $path: at, $pos: pos }, at);
      } else {
        states.set(before.$path, null);
        touch(before, { ...current, $path: at, $pos: pos }, at);
      }
    }
  }
  async function journal(address: JournalAddress) {
    const records = (
      await runStoreScan(
        budget,
        limits.queryMs,
        (queryBudget) =>
          store.scan({
            range: { journal: '/', accept: entry => entry.address.id === address.id
              && comparePositions(entry.address.pos, address.pos) === 0 },
            budget: queryBudget,
          }),
        options.readCost,
      )
    ).items;
    const images = readJournalImages(records, address);
    const record = records.find((record) => comparePositions(record.pos, address.pos) === 0)!;
    const entry = record.entries.find((entry) => entry.id === address.id)!;
    await guard.history(entry, [images.before, images.after]);
    return { record, entry, images };
  }
  /** Restore a retained deletion after checking its path, identity, and parent. */
  async function restore(address: JournalAddress): Promise<void> {
    const { images } = await journal(address);

    const before = images.before;
    if (before === null || before === 'unknown')
      throw new KernelError('INVALID', 'The record has no known before-image');
    path(before.$path);
    if ((await get(before.$path)) !== null)
      throw new KernelError('CONFLICT', 'Restore address is occupied');
    await absentIdentity(before.$id);
    await restoreParent(before.$path);
    touch(null, { ...migrator.migrate(before), $pos: pos }, before.$path);
  }
  async function absentIdentity(id: string): Promise<void> {
    const staged = final.get(id);
    if (staged !== undefined && staged !== null)
      throw new KernelError('CONFLICT', 'Restore identity is alive');
    if (staged === undefined) {
      if (options.capabilities !== undefined) {
        if ((await options.capabilities.node(id)) !== null)
          throw new KernelError('CONFLICT', 'Restore identity is alive');
      } else {
        const live = (
          await runStoreScan(
            budget,
            limits.queryMs,
            (queryBudget) =>
              store.scan({
                range: { subtree: '/' },
                where: { $id: id },
                budget: queryBudget,
              }),
            options.readCost,
          )
        ).items;
        if (live.length !== 0) throw new KernelError('CONFLICT', 'Restore identity is alive');
      }
    }
  }
  async function restoreParent(at: string): Promise<void> {
    const parent = dirname(at);
    if (parent !== null) {
      const parentStore = options.resolve?.(parent) ?? store;
      let parentNode: StoredNode | null;
      if (parentStore === store) parentNode = await get(parent);
      else {
        if (options.readBefore === undefined)
          throw new KernelError('INVALID', 'Restore requires its composed parent source');
        parentNode = await options.readBefore(parent);
      }
      if (parentNode === null) throw new KernelError('NOT_FOUND', 'Restore parent is absent');
    }
  }
  /** Apply selected journal inverses atomically after validating their current images. */
  async function undo(addresses: readonly JournalAddress[]): Promise<void> {
    const inverses: NodeChange[] = [], selected = new Map<string, NodeChange>();

    for (const address of addresses) {
      const { record, images } = await journal(address);
      if (record.kind !== 'commit' || images.before === 'unknown')
        throw new KernelError('INVALID', 'Only retained kernel changes have an inverse');
      if (selected.has(address.id)) throw new KernelError('INVALID', 'An inverse selects an identity twice');
      const expected = images.after, prior = images.before;
      if (expected !== null) {
        path(expected.$path);
        if (!isDeepStrictEqual(await get(expected.$path), expected))
          throw new KernelError('CONFLICT', 'The accepted journal image changed');
      } else if (prior !== null) {
        path(prior.$path);
        if (await get(prior.$path) !== null)
          throw new KernelError('CONFLICT', 'Restore address is occupied');
        await absentIdentity(prior.$id);
      }
      const inverse = { id: address.id, before: expected, after: prior };
      inverses.push(inverse); selected.set(address.id, inverse);
    }

    for (const inverse of inverses) {
      const current = inverse.before, prior = inverse.after;
      if (current !== null && (prior === null || prior.$path !== current.$path)) {
        for (const descendant of await subtree(current.$path))
          if (!isDeepStrictEqual(selected.get(descendant.$id)?.before, descendant))
            throw new KernelError('CONFLICT', 'The inverse would change an unselected descendant');
      }
      if (prior !== null) {
        path(prior.$path);
        const occupied = await get(prior.$path);
        if (occupied !== null && !isDeepStrictEqual(selected.get(occupied.$id)?.before, occupied))
          throw new KernelError('CONFLICT', 'Inverse destination is occupied');
        if (current !== null && prior.$path !== current.$path)
          for (const descendant of await subtree(prior.$path))
            if (!isDeepStrictEqual(selected.get(descendant.$id)?.before, descendant))
              throw new KernelError('CONFLICT', 'Inverse destination subtree is occupied');
      }
    }

    for (const inverse of inverses) if (inverse.before !== null) states.set(inverse.before.$path, null);
    for (const inverse of inverses) {
      const prior = inverse.after;
      if (prior !== null && inverse.before === null) {
        await restoreParent(prior.$path);
      }
      touch(inverse.before, prior === null ? null : { ...migrator.migrate(prior), $pos: pos },
        prior?.$path ?? inverse.before!.$path);
    }
  }
  async function checkpoint(before: StoredNode): Promise<{ bytes: number; full: boolean }> {
    const known = cache.getJournalBytes(options.resolve?.(before.$path) ?? store, before);
    if (known !== undefined) return { bytes: known, full: false };
    // A full after-image and its reversible delta anchor a cold identity without older history.
    return { bytes: 0, full: true };
  }

  try {
    if (who.expect !== undefined) {
      if (options.preconditions === undefined)
        throw new KernelError('INVALID', 'The original read-set context is required');
      await checkPreconditions(who.expect, { ...options.preconditions, position: pos });
    }
    for (let index = 0; index < changes.length; index++) {
      const change = changes[index];
      if (change.op === 'undo') {
        const addresses = [change.record];
        while (changes[index + 1]?.op === 'undo') {
          const next = changes[++index];
          if (next.op === 'undo') addresses.push(next.record);
        }
        await undo(addresses);
        continue;
      }
      if (change.op === 'adopt') {
        path(change.from);
        path(change.to);
        if (options.mapping === undefined) throw new KernelError('INVALID', 'Publication requires an owning Store binding');
        options.mapping.adopt(change.from, change.to);
        const source = await get(change.from);
        if (source === null) throw new KernelError('NOT_FOUND', 'Publication source is absent');
        const destination = await get(change.to);
        if (destination !== null && registry.type(destination.$type).name !== registry.type(source.$type).name)
          throw new KernelError('CONFLICT', 'Publication destination has another type');
        if (destination !== null) touch(destination, null, change.to);
        states.set(change.from, null);
        touch(source, { ...source, $path: change.to, $pos: pos }, change.to);
        continue;
      }
      if (change.op === 'move') {
        await move(change.from, change.to);
        continue;
      }
      if (change.op === 'restore') {
        await restore(change.record);
        continue;
      }
      const at = change.op === 'put' ? change.node.$path : change.path;
      path(at);
      if (change.op === 'remove') {
        await remove(at);
        continue;
      }
      let before = await get(at);
      if (change.op === 'put') {
        const relocation = options.relocations?.get(at);
        if (relocation !== undefined) {
          const source = await original(relocation.source.$path);
          if (source === null || !isDeepStrictEqual(source, relocation.source))
            throw new KernelError('CONFLICT', 'Relocated identity source changed');
          if (before !== null && before.$id !== relocation.id) {
            if (registry.type(before.$type).name !== registry.type(change.node.$type).name)
              throw new KernelError('CONFLICT', 'Relocated identity destination has another type');
            touch(before, null, at);
            before = null;
          }
        }
        const stored = before === null ? null : (initial.get(before.$id) ?? before);
        touch(
          before,
          await guard.put(stored, normalize(structuredClone(change.node), before, pos, registry, relocation?.id)),
          at,
        );
      } else {
        if (before === null) throw new KernelError('NOT_FOUND', 'Patch target is absent');
        assertUpdateOps(change.ops);
        for (const fields of Object.values(change.ops))
          for (const field of Object.keys(fields)) {
            if (
              ['$id', '$rev', '$pos', '$path'].some(
                (meta) => field === meta || field.startsWith(`${meta}.`),
              )
            ) {
              throw new KernelError('INVALID', `Kernel metadata in patch: ${field}`);
            }
          }
        const { $id, $pos, ...input } = applyUpdateOps(migrator.migrate(before), change.ops);
        touch(before, normalize(input, before, pos, registry), at);
      }
    }
    for (const [at, accepted] of options.recreateBodies ?? []) {
      const source = await original(at);
      const current = await get(at);
      if (source === null || !isDeepStrictEqual(source, accepted) || current === null
        || current.$id !== source.$id || current.$type !== source.$type)
        throw new KernelError('CONFLICT', 'Recreated body lost its accepted physical source');
      const guarded = await guard.put(source, current);
      const { $id, $pos, ...input } = guarded;
      touch(source, null, at);
      touch(null, normalize(input, null, pos, registry), at);
    }
    const entries: JournalEntry[] = [],
      expanded: NodeChange[] = [];
    for (const [id, before] of initial) {
      const after = final.get(id)!;
      if (before === null && after === null) continue;
      await guard.transition(before, after);
      expanded.push({ id, before, after });
    }
    for (const [destination, relocation] of options.relocations ?? []) {
      const source = await get(relocation.source.$path);
      if (relocation.source.$path !== destination && source?.$id === relocation.id)
        throw new KernelError('INVALID', 'Relocated identity remains at its source');
      if ((await get(destination))?.$id !== relocation.id)
        throw new KernelError('INVALID', 'Relocated identity left its destination');
    }
    await guard.finish(expanded);
    const blobWork = await validateBlobReferences(
      expanded.map((change) => change.after),
      options.blobs,
      options.readCost?.budget() ?? budget,
    );
    options.readCost?.charge(0, 0, blobWork);
    const remaining = options.readCost?.budget() ?? { ...budget, nodes: budget.nodes - loaded.size,
      bytes: budget.bytes - readBytes, exprWork: budget.exprWork - blobWork };
    const mapped = await options.mapping?.prepare(expanded, remaining);
    if (mapped !== undefined) return mapped;
    for (const { before, after } of expanded) {
      const state = before === null || after === null ? { bytes: 0, full: false } : await checkpoint(before);
      entries.push(encodeJournalEntry(before, after, state.bytes, state.full).entry);
    }
    const paths = new Set(
      expanded.flatMap((change) => [
        ...(change.before === null ? [] : [change.before.$path]),
        ...(change.after === null ? [] : [change.after.$path]),
      ]),
    );
    const writes = [...paths].map((at) => ({ path: at, node: states.get(at)! }));
    let groups: PreparedCommit['groups'];
    const resolve = options.resolve;
    if (resolve !== undefined && writes.some(write => resolve(write.path) !== store)) {
      const handles = new Map<Store, typeof writes>([[store, []]]);
      for (const write of writes) {
        const local = resolve(write.path);
        path(write.path);
        const group = handles.get(local);
        if (group === undefined) handles.set(local, [write]);
        else group.push(write);
      }
      if (handles.size > 1) groups = [...handles].map(([store, writes]) => ({ store, writes }));
    }
    return {
      writes,
      ...(groups === undefined ? {} : { groups }),
      record: { pos, kind: 'commit', executor: who.executor, caller: who.caller, entries },
      transitions: expanded,
      budget: remaining,
    };
  } finally {
    options.mapping?.close();
    for (const lease of leases) lease.release();
  }
}

/** Describe every route a change can affect before acquiring its atomic writer. */
export function changeSelectors(changes: readonly ChangeMember[]): readonly Selector[] {
  return changes.flatMap<Selector>(change => change.op === 'restore' || change.op === 'undo' ? [{ history: '/' }]
    : change.op === 'move' || change.op === 'adopt' ? [{ node: change.from }, { node: change.to }]
    : [{ node: change.op === 'put' ? change.node.$path : change.path }])
}

/** Choose one actual Store and pin both move endpoints and retained journal ownership. */
export async function selectChangeStore(changes: readonly ChangeMember[], source: ReaderSource,
  ownership: Pick<ReturnType<typeof createReader>, 'pin' | 'journalTarget'>, fallback: Store): Promise<Store> {
  let store: Store | undefined
  for (const change of changes) {
    const path = change.op === 'put' ? change.node.$path : change.op === 'move' || change.op === 'adopt' ? change.from
      : change.op === 'restore' || change.op === 'undo' ? '/' : change.path
    if (change.op !== 'restore' && change.op !== 'undo') ownership.pin({ node: path })
    const target = change.op === 'restore' || change.op === 'undo' ? await ownership.journalTarget(change.record) : source.resolve(path)
    if (store !== undefined && !sameStoreOwner(store, target.store))
      throw new KernelError('CROSS_DOMAIN', 'ChangeSet spans atomic Store owners')
    store = target.store
    if (change.op === 'move' || change.op === 'adopt') {
      ownership.pin({ node: change.to })
      if (!sameStoreOwner(source.resolve(change.to).store, store))
        throw new KernelError('CROSS_DOMAIN', 'ChangeSet spans atomic Store owners')
    }
  }
  return store ?? fallback
}
