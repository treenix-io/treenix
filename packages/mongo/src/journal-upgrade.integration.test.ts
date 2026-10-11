import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { it } from 'node:test';
import { MongoClient, MongoOperationTimeoutError, type CommandStartedEvent } from 'mongodb';
import { scanBudget, storeCommit, storedNode } from '@treenx/core/kernel/testing';
import { encodeJournalEntry } from '@treenx/core/kernel/journal';
import { createMemoryStore } from '@treenx/core/kernel/store/memory';
import type { JournalCommit } from '@treenx/core/kernel/types';
import { createMongoStore } from '#store';
import type { MongoStore } from '#store';
import { KernelError } from '@treenx/core/errors';
import { stableJson } from '@treenx/core/util/stable-json';
import type { InlineJournalRoot, FragmentJournalRoot, JournalEntryIndex, JournalCollections } from '#journal-records';
import { upgradeJournal } from '#journal-upgrade';
import type { JournalChunk } from '#journal-units';

/** A real server failure must preserve one durable upgrade while following transaction retry semantics. */
async function verifyUpgradeRetry(command: 'insert' | 'commitTransaction', label: string): Promise<void> {
  const uri = process.env.NATIVE_MONGO_TEST_URI;
  assert.ok(uri);
  const db = `legacy_retry_${randomUUID().replaceAll('-', '')}`;
  const client = new MongoClient(uri, { monitorCommands: true });
  const attempts: CommandStartedEvent[] = [];
  client.on('commandStarted', event => {
    if (event.commandName === command) attempts.push(event);
  });
  await client.connect();
  try {
    const database = client.db(db);
    const collections: JournalCollections = {
      owner: db,
      roots: database.collection<InlineJournalRoot>('journal'),
      headers: database.collection<FragmentJournalRoot>('journal'),
      chunks: database.collection<JournalChunk>('chunks'),
      entries: database.collection<JournalEntryIndex>('entries'),
      physicalLimit: 64 * 1024 * 1024,
    };
    const record = storeCommit(1, [storedNode('/a')]).record;
    await collections.roots.insertOne({ ...record, _id: 'legacy:1' });
    attempts.length = 0;
    await client.db('admin').command({ configureFailPoint: 'failCommand', mode: { times: command === 'commitTransaction' ? 3 : 1 },
      data: { failCommands: [command], errorCode: command === 'insert' ? 112 : 91, errorLabels: [label] } });
    await upgradeJournal(collections, client, async () => {}, 5000);
    assert.equal(await collections.roots.countDocuments({ _position: { $exists: true } }), 1);
    assert.equal(await collections.entries.countDocuments({}), 1);
    assert.ok(attempts.length >= 2);
    if (command === 'commitTransaction') {
      assert.ok(attempts.length >= 4);
      for (const attempt of attempts) {
        assert.deepEqual(attempt.command.lsid, attempts[0].command.lsid);
        assert.deepEqual(attempt.command.txnNumber, attempts[0].command.txnNumber);
      }
    } else assert.notDeepEqual([attempts[0].command.lsid, attempts[0].command.txnNumber],
      [attempts[1].command.lsid, attempts[1].command.txnNumber]);
  } finally {
    await client.db('admin').command({ configureFailPoint: 'failCommand', mode: 'off' });
    await client.close();
  }
}

it('restarts a transient legacy upgrade transaction without partial records', async () => {
  await verifyUpgradeRetry('insert', 'TransientTransactionError');
});

it('retries an unknown legacy upgrade commit in the same session and transaction', async () => {
  await verifyUpgradeRetry('commitTransaction', 'UnknownTransactionCommitResult');
});

it('bounds an exhausted unknown commit window without reporting a durable partial upgrade', async context => {
  const uri = process.env.NATIVE_MONGO_TEST_URI;
  assert.ok(uri);
  const client = new MongoClient(uri, { monitorCommands: true });
  const attempts: CommandStartedEvent[] = [];
  let aborts = 0;
  client.on('commandStarted', event => {
    if (event.commandName === 'commitTransaction') attempts.push(event);
    if (event.commandName === 'abortTransaction') aborts++;
  });
  await client.connect();
  try {
    const database = client.db(`legacy_unknown_window_${randomUUID().replaceAll('-', '')}`);
    const collections: JournalCollections = {
      owner: 'owner', roots: database.collection<InlineJournalRoot>('journal'),
      headers: database.collection<FragmentJournalRoot>('journal'),
      chunks: database.collection<JournalChunk>('chunks'),
      entries: database.collection<JournalEntryIndex>('entries'), physicalLimit: 64 * 1024 * 1024,
    };
    const record = storeCommit(1, [storedNode('/a')]).record;
    await collections.roots.insertOne({ ...record, _id: stableJson(record.pos) });
    await client.db('admin').command({ configureFailPoint: 'failCommand', mode: 'alwaysOn',
      data: { failCommands: ['commitTransaction'], errorCode: 1,
        errorLabels: ['UnknownTransactionCommitResult'] } });
    const started = performance.now();
    await assert.rejects(upgradeJournal(collections, client, async () => {}, 100),
      (error: unknown) => error instanceof MongoOperationTimeoutError ||
        error instanceof KernelError && error.code === 'BUDGET');
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 500);
    assert.ok(attempts.length >= 2);
    for (const attempt of attempts) {
      assert.deepEqual(attempt.command.lsid, attempts[0].command.lsid);
      assert.deepEqual(attempt.command.txnNumber, attempts[0].command.txnNumber);
    }
    await client.db('admin').command({ configureFailPoint: 'failCommand', mode: 'off' });
    assert.equal(await collections.roots.countDocuments({ _position: { $exists: true } }), 0);
    assert.equal(await collections.entries.countDocuments({}), 0);
    assert.equal(await collections.chunks.countDocuments({}), 0);
    context.diagnostic(JSON.stringify({ elapsed, commitAttempts: attempts.length, abortCommands: aborts,
      outcome: 'no durable upgrade observed; ambiguous server transaction completion remains unproven' }));
  } finally {
    await client.db('admin').command({ configureFailPoint: 'failCommand', mode: 'off' });
    await client.close();
  }
});

it('upgrades more than one legacy page atomically before applying history acceptance', async () => {
  const uri = process.env.NATIVE_MONGO_TEST_URI; assert.ok(uri);
  const db = `legacy_${randomUUID().replaceAll('-', '')}`;
  const client = new MongoClient(uri);
  await client.connect();
  try {
    const records = Array.from({ length: 103 }, (_, index) => storeCommit(index + 1,
      [storedNode(`/item${index}`)]).record);
    await client.db(db).collection<InlineJournalRoot>('nodes.__journal').insertMany(records.map((record, index) => ({ ...record, _id: `legacy:${index}` })));
    const store = await createMongoStore({ uri, db, collection: 'nodes', domain: 'mongo' });
    try {
      assert.equal(await client.db(db).collection('nodes.__journal').countDocuments({ _position: { $exists: true } }), 103);
      assert.equal(await client.db(db).collection('nodes.__journal.__entries').countDocuments({}), 103);
      assert.deepEqual((await store.scan({ range: { journal: '/', accept: () => false },
        budget: scanBudget() })).items, []);
      assert.deepEqual((await store.scan({ range: { journal: '/' }, budget: scanBudget() })).items, records);
    } finally { await store.close(); }
    const reopened = await createMongoStore({ uri, db, collection: 'nodes', domain: 'mongo' });
    try {
      assert.deepEqual((await reopened.scan({ range: { journalHead: 'position' }, budget: scanBudget() })).items,
        [{ pos: records[102].pos }]);
    } finally { await reopened.close(); }
  } finally { await client.close(); }
});

it('bounds a blocked legacy upgrade command within its configured host resource window', async () => {
  const uri = process.env.NATIVE_MONGO_TEST_URI; assert.ok(uri);
  const db = `legacy_timeout_${randomUUID().replaceAll('-', '')}`;
  const admin = new MongoClient(uri);
  let opened: MongoStore | undefined;
  await admin.connect();
  try {
    const record = storeCommit(1, [storedNode('/a')]).record;
    await admin.db(db).collection<InlineJournalRoot>('nodes.__journal').insertOne({ ...record, _id: 'legacy:1' });
    await admin.db('admin').command({ configureFailPoint: 'failCommand', mode: { times: 1 },
      data: { failCommands: ['insert'], blockConnection: true, blockTimeMS: 200 } });
    const options = { uri, db, collection: 'nodes', domain: 'mongo', journalUpgradeMs: 100 };
    await assert.rejects(async () => { opened = await createMongoStore(options); },
      (error: unknown) => error instanceof KernelError && error.code === 'BUDGET');
    assert.equal(await admin.db(db).collection('nodes.__journal').countDocuments({ _position: { $exists: true } }), 0);
    assert.equal(await admin.db(db).collection('nodes.__journal.__entries').countDocuments({}), 0);
    assert.equal(await admin.db(db).collection('nodes.__journal.__fragments').countDocuments({}), 0);
  } finally {
    await admin.db('admin').command({ configureFailPoint: 'failCommand', mode: 'off' });
    await opened?.close(); await admin.close();
  }
});

it('reconstructs a compact legacy target whose full anchor precedes more than one hundred records', async () => {
  const uri = process.env.NATIVE_MONGO_TEST_URI; assert.ok(uri);
  const db = `legacy_compact_${randomUUID().replaceAll('-', '')}`;
  const client = new MongoClient(uri);
  const memory = createMemoryStore({ domain: 'memory' });
  let before = storedNode('/a', { payload: 'x'.repeat(1024), count: 0 });
  const seed = storeCommit(1, [before]);
  await memory.commit(seed);
  const records: JournalCommit[] = [seed.record];
  for (let seq = 2; seq <= 104; seq++) {
    const next = storeCommit(seq, []);
    const after = { ...before, $pos: next.pos, count: seq - 1 };
    const entry = encodeJournalEntry(before, after).entry;
    assert.equal(entry.change.t, 'update');
    if (entry.change.t !== 'update') throw new Error('Expected an update');
    assert.equal(entry.change.after, undefined);
    const record = { ...next.record, entries: [entry] };
    await memory.commit({ ...next, writes: [{ path: '/a', node: after }], record });
    records.push(record); before = after;
  }
  await client.connect();
  try {
    await client.db(db).collection<InlineJournalRoot>('nodes.__journal').insertMany(
      records.map((record, index) => ({ ...record, _id: `legacy:${index}` })));
    const store = await createMongoStore({ uri, db, collection: 'nodes', domain: 'mongo' });
    try {
      const range = { journal: '/a', after: records[102].pos, accept: () => true, take: 1 };
      const expected = await memory.scan({ range, budget: scanBudget() });
      const actual = await store.scan({ range, budget: scanBudget() });
      assert.deepEqual(actual.items, expected.items);
      assert.equal(actual.cost?.bytes, expected.cost?.bytes);
      assert.equal(actual.items[0].entries.length, 1);
      assert.deepEqual((await store.scan({ range: { journal: '/a', accept: () => false }, budget: scanBudget() })).items, []);
    } finally { await store.close(); }
  } finally { await client.close(); }
});
