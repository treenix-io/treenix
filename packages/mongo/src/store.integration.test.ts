import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, it } from 'node:test';
import { Long, MongoClient, type CommandStartedEvent, type CommandSucceededEvent } from 'mongodb';
import { getSharedClient } from './index';
import { KernelError } from '@treenx/core/errors';
import { runStoreContract, scanBudget, storeCommit, storedNode } from '@treenx/core/kernel/testing';
import type { DecisionRange, ScanQuery, Store, StoredNode } from '@treenx/core/kernel/types';

function testUri(): string {
  const value = process.env.NATIVE_MONGO_TEST_URI;
  if (value === undefined) throw new Error('NATIVE_MONGO_TEST_URI must identify the owned test replica set');
  return value;
}
const uri = testUri();
const client = new MongoClient(uri, { serverSelectionTimeoutMS: 3000 });
const db = `k43_${randomUUID().replaceAll('-', '')}`;
const opened: (() => Promise<void>)[] = [];
const owners = new Map<Store, () => Promise<void>>();
let collection: string, crash = false;

/** Command monitoring exposes the external Mongo reply as unknown. */
function observedBatch(event: CommandSucceededEvent) {
  const reply = event.reply;
  assert.ok(reply !== null && typeof reply === 'object' && 'cursor' in reply);
  const cursor = reply.cursor;
  assert.ok(cursor !== null && typeof cursor === 'object' && 'id' in cursor && 'firstBatch' in cursor);
  assert.ok(typeof cursor.id === 'number' || Long.isLong(cursor.id));
  assert.ok(Array.isArray(cursor.firstBatch));
  return { id: cursor.id.toString(), size: cursor.firstBatch.length };
}

before(async () => {
  await client.connect();
  const hello = await client.db('admin').command({ hello: 1 });
  assert.ok(hello.setName && hello.isWritablePrimary);
});
after(async () => {
  await Promise.all(opened.map(close => close()));
  await client.close();
});

async function open(name: string) {
  const { createMongoStore } = await import('./store');
  const store = await createMongoStore({ uri, db, collection: name, domain: 'test',
    beforeRecord() { if (crash) throw new KernelError('UNAVAILABLE', 'Injected transaction failure'); } });
  opened.push(() => store.close());
  owners.set(store, () => store.close());
  return store;
}

runStoreContract(async () => {
  collection = `contract_${randomUUID().replaceAll('-', '')}`;
  await client.db(db).createCollection(collection);
  return open(collection);
}, {
  name: 'actual owned Mongo replica set',
  async crash(run) { crash = true; try { await run(); } finally { crash = false; } },
  async recover(store: Store) { const close = owners.get(store); assert.ok(close); await close(); return open(collection); },
});

it('reads an exact node in one bounded database command', async () => {
  const monitoredUri = `${uri}&monitorCommands=true`;
  const pool = getSharedClient(monitoredUri);
  const { createMongoStore } = await import('./store');
  const name = `exact_${randomUUID().replaceAll('-', '')}`;
  const store = await createMongoStore({ uri: monitoredUri, db, collection: name, domain: 'test' });
  const pooledClient = await pool.ready;
  const calls: CommandStartedEvent[] = [];
  const started = (event: CommandStartedEvent) => { if (event.commandName === 'find') calls.push(event); };
  try {
    const commit = storeCommit(1, [storedNode('/exact')]);
    await store.commit(commit);
    pooledClient.on('commandStarted', started);
    assert.deepEqual((await store.scan({ range: { node: '/exact' }, budget: scanBudget() })).items, commit.writes.map(write => write.node));
    assert.equal(calls.length, 1);
    assert.ok(calls[0].command.maxTimeMS > 0);
    calls.length = 0;
    assert.deepEqual((await store.scan({ range: { node: '/missing' }, budget: scanBudget() })).items, []);
    assert.equal(calls.length, 1);
  } finally {
    pooledClient.off('commandStarted', started);
    await store.close();
    await pool.release();
  }
});

it('persists exact node identity, positions, indexes and fencing across close/reopen', async () => {
  const name = `persist_${randomUUID().replaceAll('-', '')}`;
  const first = await open(name);
  const commit = storeCommit(1, [storedNode('/a', { value: 1 })], [], 7);
  await first.commit(commit);
  const doc = await client.db(db).collection(name).findOne({ _path: '/a' });
  assert.ok(doc);
  assert.equal(doc._tid, commit.writes[0].node.$id);
  assert.deepEqual(doc._pos, commit.pos);
  assert.equal(doc._rev, undefined);
  const indexes = await client.db(db).collection(name).listIndexes().toArray();
  assert.ok(indexes.some(index => index.unique && index.key._path === 1));
  assert.ok(indexes.some(index => index.unique && index.key._tid === 1));
  await first.close();
  const second = await open(name);
  await assert.rejects(second.commit(storeCommit(2, [storedNode('/b')], [], 6)),
    (error: unknown) => error instanceof KernelError && error.code === 'CONFLICT');
  assert.deepEqual((await second.scan({ range: { subtree: '/' }, budget: scanBudget() })).items, commit.writes.map(write => write.node));
});

it('aborts actual written data and its journal and reopens the previous accepted state', async () => {
  const name = `abort_${randomUUID().replaceAll('-', '')}`;
  const store = await open(name);
  const first = storeCommit(1, [storedNode('/a', { value: 1 })]);
  await store.commit(first);
  crash = true;
  try {
    await assert.rejects(store.commit(storeCommit(2, [storedNode('/a', { value: 2 }), storedNode('/b')], [first.writes[0].node])),
      (error: unknown) => error instanceof KernelError && error.code === 'UNAVAILABLE');
  } finally { crash = false; }
  await store.close();
  const reopened = await open(name);
  assert.deepEqual((await reopened.scan({ range: { subtree: '/' }, budget: scanBudget() })).items, first.writes.map(write => write.node));
  assert.deepEqual((await reopened.scan({ range: { journal: '/' }, budget: scanBudget() })).items, [first.record]);
});

it('uses an indexed exclusive database path cursor and refuses expired database deadlines', async () => {
  const name = `cursor_${randomUUID().replaceAll('-', '')}`;
  const store = await open(name);
  await store.commit(storeCommit(1, [storedNode('/a'), storedNode('/b'), storedNode('/c')]));
  const query = { range: { children: '/' }, budget: scanBudget(), limit: 1 };
  const first = await store.scan(query);
  assert.ok(first.next);
  await client.db(db).command({ profile: 2 });
  const second = await store.scan({ ...query, after: first.next });
  await client.db(db).command({ profile: 0 });
  assert.deepEqual(second.items.map(node => node.$path), ['/b']);
  const profile = await client.db(db).collection<{ command: { filter: { $and: readonly { _path: { $gt: string } }[] }; maxTimeMS: number }; planSummary: string }>('system.profile')
    .findOne({ 'command.find': name });
  assert.ok(profile);
  assert.equal(profile.command.filter.$and[1]._path.$gt, '/a');
  assert.ok(profile.command.maxTimeMS > 0 && profile.command.maxTimeMS <= query.budget.deadline - Date.now() + 1000);
  assert.ok(profile.planSummary.includes('IXSCAN'));
  assert.ok((await client.db(db).collection(name).listIndexes().toArray()).some(index => index.key._path === 1));
  await assert.rejects(store.scan({ ...query, budget: { ...scanBudget(), deadline: 0 } }),
    (error: unknown) => error instanceof KernelError && error.code === 'BUDGET');
});

it('maps an actual server query timeout to the native budget error', async () => {
  const name = `timeout_${randomUUID().replaceAll('-', '')}`;
  const store = await open(name);
  const admin = client.db('admin');
  await admin.command({ configureFailPoint: 'failCommand', mode: { times: 1 }, data: { failCommands: ['find'], errorCode: 50 } });
  try {
    await assert.rejects(store.scan({ range: { subtree: '/' }, budget: scanBudget() }),
      (error: unknown) => error instanceof KernelError && error.code === 'BUDGET');
  } finally {
    await admin.command({ configureFailPoint: 'failCommand', mode: 'off' });
  }
});

it('finds durable decisions and anchor decisions regardless of legal operation-id field order', async () => {
  const store = await open(`decision_${randomUUID().replaceAll('-', '')}`);
  const opId = { nonce: 'nonce', time: 1, epoch: 'epoch' };
  const first = storeCommit(1, []);
  const caller = 'u:alice';
  const decision = { opId, requestHash: 'hash' };
  await store.commit({ ...first, record: { ...first.record, caller, decision } });
  const query: ScanQuery<DecisionRange> = { range: { decision: { caller, opId: { epoch: 'epoch', time: 1, nonce: 'nonce' } } }, budget: scanBudget() };
  assert.deepEqual((await store.scan(query)).items.map(record => record.pos), [first.pos]);
  const second = storeCommit(2, []);
  const stream = { executor: 'u:alice' as const, target: 'target' };
  const outcome = { value: 'done', pos: second.pos };
  await store.commit({ ...second, record: { ...second.record, caller,
    decision: { opId: { nonce: 'continuation', time: 2, epoch: 'epoch' }, requestHash: 'continuation', stream, outcome },
    anchorDecision: { ...decision, stream, outcome },
  } });
  assert.deepEqual((await store.scan(query)).items.map(record => record.pos), [second.pos]);
});

it('preserves canonical identity on an existing case-insensitive collection', async () => {
  const name = `collation_${randomUUID().replaceAll('-', '')}`;
  await client.db(db).createCollection(name, { collation: { locale: 'en', strength: 2 } });
  await client.db(db).createCollection(`${name}.__journal`, { collation: { locale: 'en', strength: 2 } });
  await client.db(db).createCollection(`${name}.__control`, { collation: { locale: 'en', strength: 2 } });
  const store = await open(name);
  await store.commit(storeCommit(1, [storedNode('/a')]));
  await store.commit(storeCommit(2, [storedNode('/A')]));
  assert.deepEqual((await store.scan({ range: { subtree: '/' }, budget: scanBudget() })).items.map(node => node.$path), ['/A', '/a']);
  const upper = (await store.scan({ range: { node: '/A' }, budget: scanBudget() })).items[0];
  const lower = (await store.scan({ range: { node: '/a' }, budget: scanBudget() })).items[0];
  assert.notEqual(upper.$id, lower.$id);
  const accepted = storeCommit(3, []);
  const opId = { epoch: 'epoch', time: 1, nonce: 'nonce' };
  await store.commit({ ...accepted, record: { ...accepted.record, caller: 'u:alice', decision: { opId, requestHash: 'hash' } } });
  assert.equal((await store.scan({ range: { decision: { caller: 'u:alice', opId } }, budget: scanBudget() })).items.length, 1);
  assert.equal((await store.scan({ range: { decision: { caller: 'u:Alice', opId } }, budget: scanBudget() })).items.length, 0);
  assert.equal((await store.scan({ range: { decision: { caller: 'u:alice', opId: { ...opId, nonce: 'Nonce' } } }, budget: scanBudget() })).items.length, 0);
  const deleted = storeCommit(4, []);
  await store.commit({ ...deleted, writes: [{ path: '/A', node: null }], record: { ...deleted.record,
    entries: [{ id: upper.$id, path: '/A', change: { t: 'delete', before: upper } }],
  } });
  assert.deepEqual((await store.scan({ range: { subtree: '/' }, budget: scanBudget() })).items.map(node => node.$path), ['/a']);
});

it('keeps live-cursor cleanup inside the absolute scan deadline', async test => {
  const name = `cleanup_${randomUUID().replaceAll('-', '')}`;
  const store = await open(name);
  const expected = [...Array.from({ length: 250 }, (_, index) => `/item${index.toString().padStart(3, '0')}`), '/\ue000', '/😀'];
  await store.commit(storeCommit(1, expected.map(path => storedNode(path))));
  const pool = getSharedClient(`${uri}&monitorCommands=true`);
  const { createMongoStore } = await import('./store');
  const monitored = await createMongoStore({ uri: `${uri}&monitorCommands=true`, db, collection: name, domain: 'test' });
  opened.push(() => monitored.close());
  const pooledClient = await pool.ready;
  let getMore = 0, killCursors = 0, liveCursors = 0;
  const started = (event: CommandStartedEvent) => {
    if (event.commandName === 'getMore') getMore++;
    if (event.commandName === 'killCursors') killCursors++;
  };
  const succeeded = (event: CommandSucceededEvent) => {
    if (event.commandName === 'find' && observedBatch(event).id !== '0') liveCursors++;
  };
  pooledClient.on('commandStarted', started);
  pooledClient.on('commandSucceeded', succeeded);
  const admin = client.db('admin');
  await admin.command({ configureFailPoint: 'failCommand', mode: { times: 2 },
    data: { failCommands: ['getMore', 'killCursors'], blockConnection: true, blockTimeMS: 600, errorCode: 50 } });
  const start = performance.now();
  try {
    await assert.rejects(monitored.scan({ range: { subtree: '/' }, budget: { ...scanBudget(), nodes: 102, deadline: Date.now() + 700 } }),
      (error: unknown) => error instanceof KernelError && error.code === 'BUDGET');
    const elapsed = performance.now() - start;
    test.diagnostic(JSON.stringify({ elapsed, getMore, killCursors, liveCursors }));
    assert.ok(elapsed < 900);
    assert.equal(getMore, 0);
    assert.equal(killCursors, 0);
    assert.equal(liveCursors, 0);
    await admin.command({ configureFailPoint: 'failCommand', mode: 'off' });
    const complete = await monitored.scan({ range: { subtree: '/' }, budget: scanBudget() });
    assert.deepEqual(complete.items.map(node => node.$path), expected.sort());
    assert.equal(complete.cost?.nodes, expected.length);
    assert.equal(liveCursors, 0);
  } finally {
    await admin.command({ configureFailPoint: 'failCommand', mode: 'off' });
    await pool.release();
    pooledClient.off('commandStarted', started);
    pooledClient.off('commandSucceeded', succeeded);
  }
});

it('continues a short 16 MiB wire batch until an empty indexed page', async test => {
  const name = `wire_${randomUUID().replaceAll('-', '')}`;
  const store = await open(name);
  const authored = Array.from({ length: 70 }, (_, index) => storedNode(`/item${index.toString().padStart(3, '0')}`, { payload: 'x'.repeat(250_000) }));
  await store.commit(storeCommit(1, authored.slice(0, 35)));
  await store.commit(storeCommit(2, authored.slice(35)));
  const monitoredUri = `${uri}&monitorCommands=true`;
  const pool = getSharedClient(monitoredUri);
  const { createMongoStore } = await import('./store');
  const monitored = await createMongoStore({ uri: monitoredUri, db, collection: name, domain: 'test' });
  opened.push(() => monitored.close());
  const pooledClient = await pool.ready;
  const sizes: number[] = [];
  const succeeded = (event: CommandSucceededEvent) => {
    if (event.commandName === 'find') {
      const batch = observedBatch(event);
      assert.equal(batch.id, '0');
      sizes.push(batch.size);
    }
  };
  pooledClient.on('commandSucceeded', succeeded);
  try {
    const result = await monitored.scan({ range: { subtree: '/' }, budget: { ...scanBudget(), bytes: 32 * 1024 * 1024 } });
    assert.deepEqual(result.items.map(node => node.$path), authored.map(node => node.$path));
    assert.ok(result.items.every(node => node.payload === authored[0].payload));
    assert.equal(result.cost?.nodes, authored.length);
    assert.ok(sizes[0] > 0 && sizes[0] < authored.length);
    assert.equal(sizes.at(-1), 0);
    test.diagnostic(JSON.stringify({ wireBatchSizes: sizes, chargedNodes: result.cost?.nodes }));
  } finally {
    pooledClient.off('commandSucceeded', succeeded);
    await pool.release();
  }
});

it('uses the remaining absolute deadline on a later physical page', async test => {
  const name = `later_${randomUUID().replaceAll('-', '')}`;
  const store = await open(name);
  await store.commit(storeCommit(1, Array.from({ length: 150 }, (_, index) => storedNode(`/item${index.toString().padStart(3, '0')}`))));
  const monitoredUri = `${uri}&monitorCommands=true`;
  const pool = getSharedClient(monitoredUri);
  const { createMongoStore } = await import('./store');
  const monitored = await createMongoStore({ uri: monitoredUri, db, collection: name, domain: 'test' });
  opened.push(() => monitored.close());
  const pooledClient = await pool.ready;
  const remaining: number[] = [];
  const started = (event: CommandStartedEvent) => { if (event.commandName === 'find') remaining.push(event.command.maxTimeMS); };
  pooledClient.on('commandStarted', started);
  const admin = client.db('admin');
  await admin.command({ configureFailPoint: 'failCommand', mode: { times: 2 }, data: { failCommands: ['find'], blockConnection: true, blockTimeMS: 400 } });
  const start = performance.now();
  try {
    await assert.rejects(monitored.scan({ range: { subtree: '/' }, budget: { ...scanBudget(), deadline: Date.now() + 600 } }),
      (error: unknown) => error instanceof KernelError && error.code === 'BUDGET');
    assert.equal(remaining.length, 2);
    assert.ok(remaining[1] < remaining[0] - 300);
    const elapsed = performance.now() - start;
    assert.ok(elapsed < 800);
    test.diagnostic(JSON.stringify({ elapsed, commandDeadlines: remaining }));
  } finally {
    await admin.command({ configureFailPoint: 'failCommand', mode: 'off' });
    pooledClient.off('commandStarted', started);
    await pool.release();
  }
});

it('reconstructs the complete chronological journal across indexed physical pages', async () => {
  const store = await open(`journal_pages_${randomUUID().replaceAll('-', '')}`);
  let previous: StoredNode | undefined;
  for (let seq = 1; seq <= 130; seq++) {
    const commit = storeCommit(seq, [storedNode('/a', { value: seq })], previous === undefined ? [] : [previous]);
    await store.commit(commit);
    previous = commit.writes[0].node;
  }
  const result = await store.scan({ range: { journal: '/' }, budget: scanBudget() });
  assert.deepEqual(result.items.map(record => record.pos.seq), Array.from({ length: 130 }, (_, index) => index + 1));
  assert.equal(result.items.at(-1)?.entries[0].change.t, 'update');
  assert.equal((await store.scan({ range: { node: '/a' }, budget: scanBudget() })).items[0].value, 130);
});

it('bounds actual server selection while the owned replica set has no primary', async () => {
  const selectionUri = `${uri}&heartbeatFrequencyMS=500`;
  const pool = getSharedClient(selectionUri);
  const { createMongoStore } = await import('./store');
  const store = await createMongoStore({ uri: selectionUri, db, collection: `selection_${randomUUID().replaceAll('-', '')}`, domain: 'test' });
  opened.push(() => store.close());
  const pooledClient = await pool.ready;
  const unavailable = new Promise<void>(resolve => {
    const changed = (event: import('mongodb').ServerDescriptionChangedEvent) => {
      if (event.newDescription.type !== 'RSPrimary') {
        pooledClient.off('serverDescriptionChanged', changed);
        resolve();
      }
    };
    pooledClient.on('serverDescriptionChanged', changed);
  });
  const recovered = new Promise<void>(resolve => {
    const changed = (event: import('mongodb').ServerDescriptionChangedEvent) => {
      if (event.previousDescription.type !== 'RSPrimary' && event.newDescription.type === 'RSPrimary') {
        pooledClient.off('serverDescriptionChanged', changed);
        resolve();
      }
    };
    pooledClient.on('serverDescriptionChanged', changed);
  });
  try {
    await client.db('admin').command({ replSetStepDown: 2, force: true });
    await unavailable;
    const start = performance.now();
    await assert.rejects(store.scan({ range: { subtree: '/' }, budget: { ...scanBudget(), deadline: Date.now() + 100 } }),
      (error: unknown) => error instanceof KernelError && error.code === 'BUDGET');
    assert.ok(performance.now() - start < 800);
  } finally {
    await recovered;
    await pool.release();
  }
});

it('bounds actual socket wait and connection-pool checkout by the scan deadline', async () => {
  const limitedUri = `${uri}&maxPoolSize=1&monitorCommands=true`;
  const pool = getSharedClient(limitedUri);
  const { createMongoStore } = await import('./store');
  const store = await createMongoStore({ uri: limitedUri, db, collection: `wait_${randomUUID().replaceAll('-', '')}`, domain: 'test' });
  opened.push(() => store.close());
  const pooledClient = await pool.ready;
  const admin = client.db('admin');
  try {
    await admin.command({ configureFailPoint: 'failCommand', mode: { times: 1 }, data: { failCommands: ['find'], blockConnection: true, blockTimeMS: 1000 } });
    const socketStart = performance.now();
    await assert.rejects(store.scan({ range: { subtree: '/' }, budget: { ...scanBudget(), deadline: Date.now() + 100 } }),
      (error: unknown) => error instanceof KernelError && error.code === 'BUDGET');
    assert.ok(performance.now() - socketStart < 800);
    await admin.command({ configureFailPoint: 'failCommand', mode: { times: 1 }, data: { failCommands: ['find'], blockConnection: true, blockTimeMS: 1000 } });
    const started = new Promise<void>(resolve => {
      pooledClient.once('commandStarted', () => resolve());
    });
    const holding = pooledClient.db(db).collection('pool_holder').findOne({});
    await started;
    const poolStart = performance.now();
    try {
      await assert.rejects(store.scan({ range: { subtree: '/' }, budget: { ...scanBudget(), deadline: Date.now() + 100 } }),
        (error: unknown) => error instanceof KernelError && error.code === 'BUDGET');
      assert.ok(performance.now() - poolStart < 800);
    } finally { await holding; }
  } finally {
    await admin.command({ configureFailPoint: 'failCommand', mode: 'off' });
    await pool.release();
  }
});
