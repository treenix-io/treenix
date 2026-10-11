import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { it } from 'node:test';
import { MongoClient } from 'mongodb';
import { KernelError } from '@treenx/core/errors';
import { position, scanBudget, storeCommit, storedNode } from '@treenx/core/kernel/testing';
import type { StoreCommit, StoredNode } from '@treenx/core/kernel/types';
import { createMongoStore, type MongoStore } from '#store';
import { blobIds } from '@treenx/core/kernel/blob-references';
import { openMongoTransactionOwner } from '#owner';
import { createMemoryStore } from '@treenx/core/kernel/store/memory';
import { createMemoryBlobStore } from '@treenx/core/kernel/blob-store-memory';
import { createWriter } from '@treenx/core/kernel/writer';
import type { Position } from '@treenx/core/kernel/types';

/** Preserve the deleted image in the canonical inverse entry. */
function deletion(seq: number, before: StoredNode, time: number): StoreCommit {
  const pos = position(seq);
  return { pos, writerEpoch: 1, acceptedAt: time, journalRetentionMs: 100,
    writes: [{ path: before.$path, node: null }],
    record: { pos, kind: 'commit', executor: 'kernel', caller: 'kernel',
      entries: [{ id: before.$id, path: before.$path, change: { t: 'delete', before } }] } };
}

/** Drive actual canonical maintenance with a fresh bounded owning transaction per batch. */
function maintenance(seq: number, time: number, floor: number): StoreCommit {
  return { pos: position(seq), writerEpoch: 1, acceptedAt: time, journalRetentionMs: 100,
    maintenanceLimits: { changeSet: 1, budget: { ...scanBudget(), deadline: Date.now() + 5000 } },
    writes: [], record: { pos: position(seq), kind: 'kernel', executor: 'kernel', caller: 'kernel',
      entries: [], maintenance: { journalBefore: floor, decisionBefore: floor } } };
}

/** Await durable native continuation rather than polling wall time. */
async function maintain(store: MongoStore, seq: number, time: number, floor: number): Promise<number> {
  do {
    assert.ok(seq < 50);
    await store.commit(maintenance(seq++, time, floor));
  } while (store.maintenancePending === true);
  return seq;
}

it('publishes node and historical holds atomically and retires only exact canonical history', async () => {
  const uri = process.env.NATIVE_MONGO_TEST_URI;
  assert.ok(uri);
  const db = `blob_holds_${randomUUID().replaceAll('-', '')}`;
  let refuse = false;
  const options = { uri, db, collection: 'nodes', domain: 'mongo', journalRetentionMs: 100,
    beforeRecord() { if (refuse) throw new KernelError('UNAVAILABLE', 'Owned fixture refuses publication'); } };
  let store = await createMongoStore(options);
  try {
    const blob = { $blob: 'held-fixture', size: 4, type: 'text/plain' };
    const seed = { ...storeCommit(1, [storedNode('/a', { file: blob, value: 1 })]),
      acceptedAt: 1000, journalRetentionMs: 100 };
    await store.commit(seed);
    assert.equal((await store.blobHolds([blob.$blob], scanBudget())).items[0].live, 1);
    assert.equal((await store.blobJournal.blobHolds([blob.$blob], scanBudget())).items[0].history, 1);

    const before = seed.writes[0].node;
    assert.ok(before);
    const next = { ...storeCommit(2, [{ ...before, value: 2 }], [before]),
      acceptedAt: 1901, journalRetentionMs: 100 };
    const compact: StoreCommit = { ...next, record: { ...next.record,
      entries: next.record.entries.map(entry => entry.change.t === 'update'
        ? { ...entry, change: { t: 'update', delta: entry.change.delta } } : entry) } };
    await store.commit(compact);
    assert.equal((await store.blobJournal.blobHolds([blob.$blob], scanBudget())).items[0].history, 2);

    refuse = true;
    await assert.rejects(store.commit(deletion(3, next.writes[0].node, 1950)),
    (error: unknown) => error instanceof KernelError && error.code === 'UNAVAILABLE');
    refuse = false;
    assert.equal((await store.blobHolds([blob.$blob], scanBudget())).items[0].live, 1);
    assert.equal((await store.blobJournal.blobHolds([blob.$blob], scanBudget())).items[0].history, 2);

    await store.close();
    store = await createMongoStore(options);
    let seq = await maintain(store, 3, 2000, 1900);
    assert.equal((await store.blobHolds([blob.$blob], scanBudget())).items[0].live, 1);
    assert.equal((await store.blobJournal.blobHolds([blob.$blob], scanBudget())).items[0].history, 1);
    const current = (await store.scan({ range: { node: '/a' }, budget: scanBudget() })).items[0];
    assert.deepEqual(current.file, blob);
    assert.equal(current.value, 2);

    await store.commit(deletion(seq++, current, 2002));
    assert.equal((await store.blobHolds([blob.$blob], scanBudget())).items[0].live, 0);
    await maintain(store, seq, 2200, 2100);
    const retired = (await store.blobJournal.blobHolds([blob.$blob], scanBudget())).items[0];
    assert.equal(retired.history, 0);
    assert.equal(retired.releasedAt, 2200);
  } finally { await store.close(); }
});

it('keeps cold legacy coverage unavailable until bounded native adoption commits', async () => {
  const uri = process.env.NATIVE_MONGO_TEST_URI;
  assert.ok(uri);
  const db = `blob_adoption_${randomUUID().replaceAll('-', '')}`;
  const options = { uri, db, collection: 'nodes', domain: 'mongo', journalRetentionMs: 100 };
  const client = new MongoClient(uri);
  let store = await createMongoStore(options);
  try {
    const blob = { $blob: 'legacy-held-fixture', size: 4, type: 'text/plain' };
    await store.commit({ ...storeCommit(1, [storedNode('/a', { file: blob })]),
      acceptedAt: 1000, journalRetentionMs: 100 });
    await store.close();
    await client.connect();
    await client.db(db).collection('nodes.__journal.__blob_holds').rename('preserved_initial_holds');
    await client.db(db).collection('nodes.__journal.__blob_coverage').rename('preserved_initial_coverage');

    store = await createMongoStore(options);
    await assert.rejects(store.blobHolds([blob.$blob], scanBudget()),
      (error: unknown) => error instanceof KernelError && error.code === 'UNAVAILABLE');
    await assert.rejects(store.blobJournal.blobHolds([blob.$blob], scanBudget()),
      (error: unknown) => error instanceof KernelError && error.code === 'UNAVAILABLE');
    await maintain(store, 2, 1050, 950);
    assert.equal((await store.blobHolds([blob.$blob], scanBudget())).items[0].live, 1);
    assert.equal((await store.blobJournal.blobHolds([blob.$blob], scanBudget())).items[0].history, 1);
    assert.deepEqual(await client.db(db).collection('preserved_initial_holds').countDocuments(), 2);
  } finally { await store.close(); await client.close(); }
});

it('refuses aggregate reference work atomically across multiple native writes', async () => {
  const uri = process.env.NATIVE_MONGO_TEST_URI;
  assert.ok(uri);
  const options = { uri, db: `blob_work_${randomUUID().replaceAll('-', '')}`, collection: 'nodes', domain: 'mongo' };
  let store = await createMongoStore(options);
  const nodes = ['/one', '/two'].map(path => storedNode(path, {
    file: { $blob: path, size: 1, type: 'text/plain' }, values: [1, 2, 3],
  }));
  const budget = { ...scanBudget(), exprWork: 20 };
  for (const node of nodes) assert.deepEqual(blobIds(node, budget), [node.$path]);

  try {
    await assert.rejects(store.commit({ ...storeCommit(1, nodes),
      maintenanceLimits: { budget, changeSet: 100 } }),
    (error: unknown) => error instanceof KernelError && error.code === 'BUDGET');
    assert.deepEqual((await store.scan({ range: { subtree: '/' }, budget: scanBudget() })).items, []);
    assert.deepEqual((await store.blobHolds(['/one', '/two'], scanBudget())).items.map(row => row.live), [0, 0]);
    assert.deepEqual((await store.blobJournal.blobHolds(['/one', '/two'], scanBudget())).items.map(row => row.history), [0, 0]);
    await store.close();
    store = await createMongoStore(options);
    assert.deepEqual((await store.scan({ range: { subtree: '/' }, budget: scanBudget() })).items, []);
    assert.deepEqual((await store.blobJournal.blobHolds(['/one', '/two'], scanBudget())).items.map(row => row.history), [0, 0]);
  } finally { await store.close(); }
});

it('atomically reactivates both archived physical carriers with their canonical writes', async () => {
  const uri = process.env.NATIVE_MONGO_TEST_URI;
  assert.ok(uri);
  let refuse = false;
  const store = await createMongoStore({ uri, db: `blob_archives_${randomUUID().replaceAll('-', '')}`,
    collection: 'nodes', domain: 'mongo',
    beforeRecord() { if (refuse) throw new KernelError('UNAVAILABLE', 'Owned fixture refuses publication'); } });
  const generation = position(1);
  const owners = [store.blobOwner, store.blobJournal.blobOwner];
  assert.notEqual(owners[0], owners[1]);
  const node = storedNode('/a', { file: { $blob: 'archived-fixture', size: 1, type: 'text/plain' } });
  try {
    await store.commit({ ...storeCommit(1, []), blobArchive: owners.flatMap(owner => [
      { t: 'page' as const, owner, generation, page: 0, clock: 100,
        rows: [{ t: 'live' as const, key: '/a', ids: ['archived-fixture'] }] },
      { t: 'seal' as const, owner, generation, pages: 1 },
    ]) });
    assert.equal((await store.archivedBlobHolds(['archived-fixture'], 200, scanBudget())).items[0].live, 2);
    const activation: StoreCommit = { ...storeCommit(2, [node]), blobArchive: owners.flatMap(owner => [
      { t: 'removePage' as const, owner, generation, page: 0 },
      { t: 'remove' as const, owner, generation },
    ]) };
    refuse = true;
    await assert.rejects(store.commit(activation),
      (error: unknown) => error instanceof KernelError && error.code === 'UNAVAILABLE');
    refuse = false;
    assert.equal((await store.archivedBlobHolds(['archived-fixture'], 200, scanBudget())).items[0].live, 2);
    assert.deepEqual((await store.scan({ range: { subtree: '/' }, budget: scanBudget() })).items, []);
    await store.commit(activation);
    assert.equal((await store.archivedBlobHolds(['archived-fixture'], 200, scanBudget())).items[0].live, 0);
    assert.equal((await store.blobHolds(['archived-fixture'], scanBudget())).items[0].live, 1);
    assert.equal((await store.blobJournal.blobHolds(['archived-fixture'], scanBudget())).items[0].history, 1);
  } finally { await store.close(); }
});

it('identifies aliased node carriers separately from their shared canonical journal', async () => {
  const uri = process.env.NATIVE_MONGO_TEST_URI;
  assert.ok(uri);
  const db = `blob_carriers_${randomUUID().replaceAll('-', '')}`;
  const owner = await openMongoTransactionOwner({ uri, domain: 'mongo', instance: 'test',
    journalDb: db, journalCollection: 'journal' });
  const left = await owner.openCollection({ db, collection: 'left', logicalBase: '/left' });
  const alias = await owner.openCollection({ db, collection: 'left', logicalBase: '/left' });
  const right = await owner.openCollection({ db, collection: 'right', logicalBase: '/right' });
  try {
    assert.equal(left.blobOwner, alias.blobOwner);
    assert.notEqual(left.blobOwner, right.blobOwner);
    assert.equal(left.blobJournal.blobOwner, right.blobJournal.blobOwner);
    const nodes = ['/left/a', '/right/b'].map(path => storedNode(path, {
      file: { $blob: 'shared-fixture', size: 1, type: 'text/plain' },
    }));
    const commit = storeCommit(1, nodes, [], owner.resources.writerEpoch);
    await owner.commit(commit, [
      { store: left, writes: [commit.writes[0]] },
      { store: right, writes: [commit.writes[1]] },
    ]);
    assert.equal((await alias.blobHolds(['shared-fixture'], scanBudget())).items[0].live, 1);
    assert.equal((await right.blobHolds(['shared-fixture'], scanBudget())).items[0].live, 1);
    assert.equal((await left.blobJournal.blobHolds(['shared-fixture'], scanBudget())).items[0].history, 2);
    await left.close();
    assert.equal((await alias.blobHolds(['shared-fixture'], scanBudget())).items[0].live, 1);
    assert.equal((await right.blobJournal.blobHolds(['shared-fixture'], scanBudget())).items[0].history, 2);
  } finally { await left.close(); await alias.close(); await right.close(); await owner.close(); }
});

it('archives a shared journal only after its last Writer target retires and reactivates it once', async () => {
  const uri = process.env.NATIVE_MONGO_TEST_URI;
  assert.ok(uri);
  const db = `blob_writer_${randomUUID().replaceAll('-', '')}`;
  const owner = await openMongoTransactionOwner({ uri, domain: 'mongo', instance: 'test',
    journalDb: db, journalCollection: 'journal' });
  const root = createMemoryStore({ domain: 'blob-archive-root' });
  const blobs = createMemoryBlobStore();
  const ref = await blobs.put('c'.repeat(64), (async function* () { yield new Uint8Array([4]); })(), 'text/plain');
  let saved: Position | undefined;
  let clock = Date.now();
  const writer = await createWriter({ instance: 'test', root, blobs, writerEpoch: 1, budget: scanBudget,
    domains: [{ store: root, epoch: 'root', persistent: false }],
    counter: { async load() { return saved; }, async save(pos) { saved = pos; }, async freshEpoch(floor) { return floor + 1; } },
    targetLifecycle: { validate() {}, publish() {} },
    maintenance: { now: () => clock, retentionMs: () => 100_000, orphanMs: () => 0, changeSet: () => 100 } });
  async function target(key: string, collection: string, logicalBase: string) {
    const store = await owner.openCollection({ db, collection, logicalBase });
    const registration = { key, revision: 'current', target: { kind: 'store' as const,
      store, resources: owner.resources, close: () => store.close() } };
    await writer.activateTarget(registration);
    return registration;
  }
  try {
    const left = await target('left', 'left', '/left');
    const alias = await target('alias', 'left', '/left');
    const right = await target('right', 'right', '/right');
    for (const [registration, path] of [[left, '/left/a'], [right, '/right/b']] as const)
      await writer.commit(registration.target.store, [], pos => {
        const node = { ...storedNode(path, { file: ref }), $pos: pos };
        return { writes: [{ path, node }], record: { pos, kind: 'commit', caller: 'kernel', executor: 'kernel',
          entries: [{ id: node.$id, path, change: { t: 'create', after: node } }] } };
      });
    await writer.retireTarget(left.key, left.revision);
    assert.equal((await root.archivedBlobHolds([ref.$blob], Date.now(), scanBudget())).items[0].live, 0);
    await writer.retireTarget(alias.key, alias.revision);
    const one = (await root.archivedBlobHolds([ref.$blob], Date.now(), scanBudget())).items[0];
    assert.equal(one.live, 1);
    assert.equal(one.history, 0);
    await writer.retireTarget(right.key, right.revision);
    const all = (await root.archivedBlobHolds([ref.$blob], Date.now(), scanBudget())).items[0];
    assert.equal(all.live, 2);
    assert.equal(all.history, 2);
    clock += 200_000;
    await writer.maintain();
    assert.deepEqual(await blobs.stat(ref.$blob), ref);
    const leftAgain = await target('left-again', 'left', '/left');
    const rightAgain = await target('right-again', 'right', '/right');
    const active = (await root.archivedBlobHolds([ref.$blob], Date.now(), scanBudget())).items[0];
    assert.equal(active.live + active.history, 0);
    assert.deepEqual(await blobs.stat(ref.$blob), ref);
    for (const registration of [leftAgain, rightAgain]) {
      const before = (await registration.target.store.scan({ range: { subtree: '/' }, budget: scanBudget() })).items[0];
      await writer.commit(registration.target.store, [], pos => ({
        writes: [{ path: before.$path, node: null }], record: { pos, kind: 'commit', caller: 'kernel', executor: 'kernel',
          entries: [{ id: before.$id, path: before.$path, change: { t: 'delete', before } }] },
      }));
      await writer.retireTarget(registration.key, registration.revision);
    }
    assert.deepEqual(await blobs.stat(ref.$blob), ref);
    clock += 200_000;
    await writer.maintain();
    await assert.rejects(blobs.stat(ref.$blob),
      (error: unknown) => error instanceof KernelError && error.code === 'NOT_FOUND');
  } finally { await writer.closeTargets(); await owner.close(); root.close(); }
});

it('bounds native archive identities within one row and reports consumed read work', async () => {
  const uri = process.env.NATIVE_MONGO_TEST_URI;
  assert.ok(uri);
  const store = await createMongoStore({ uri, db: `blob_archive_work_${randomUUID().replaceAll('-', '')}`,
    collection: 'nodes', domain: 'mongo' });
  const generation = position(1);
  const page = { t: 'page' as const, owner: store.blobOwner, generation, page: 0, clock: 100,
    rows: [{ t: 'live' as const, key: 'node', ids: Array.from({ length: 100 }, (_, index) => `blob-${index}`) }] };
  const commit: StoreCommit = { ...storeCommit(1, []), blobArchive: [page,
    { t: 'seal', owner: page.owner, generation, pages: 1 }] };
  try {
    await assert.rejects(store.commit({ ...commit,
      maintenanceLimits: { budget: { ...scanBudget(), exprWork: 2 }, changeSet: 100 } }),
    (error: unknown) => error instanceof KernelError && error.code === 'BUDGET');
    const absent = [];
    for await (const unit of store.blobArchiveCensus()) absent.push(unit);
    assert.deepEqual(absent, []);
    await store.commit({ ...commit,
      maintenanceLimits: { budget: { ...scanBudget(), exprWork: 1000 }, changeSet: 100 } });
    await assert.rejects(store.archivedBlobHolds(['blob-0'], 200, { ...scanBudget(), exprWork: 2 }),
      (error: unknown) => error instanceof KernelError && error.code === 'BUDGET');
    const result = await store.archivedBlobHolds(['blob-0'], 200, scanBudget());
    assert.equal(result.items[0].live, 1);
    assert.ok(result.cost.exprWork > 0);
  } finally { await store.close(); }
});
