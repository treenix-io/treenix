import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { it } from 'node:test';
import { MongoClient } from 'mongodb';
import { openNativeRuntime } from '@treenx/core/kernel/runtime';
import { storedNode } from '@treenx/core/kernel/testing';
import type { JournalCommit, StoreCommit } from '@treenx/core/kernel/types';
import { createMongoManifest } from '#native-mount';
import { openMongoTransactionOwner } from '#owner';
import { getSharedClient } from '#index';

it('recovers an owning observation loss with unchanged physical position while other domains remain readable', async (t) => {
  const uri = process.env.NATIVE_MONGO_TEST_URI;
  assert.ok(uri);
  const suffix = randomUUID().replaceAll('-', ''),
    id = `native-observer-${suffix}`,
    database = `observer_${suffix}`;
  const owner = await openMongoTransactionOwner({
    uri,
    domain: suffix,
    instance: id,
    journalDb: database,
    journalCollection: 'journal',
  });
  const seeded = await owner.openCollection({
    db: database,
    collection: 'nodes',
    logicalBase: '/dual',
  });
  const pos = { instance: id, epoch: 1, seq: 1 };
  const parent = { ...storedNode('/dual/left'), $type: 't.dir', $pos: pos };
  const node = { ...storedNode('/dual/left/a'), $type: 't.dir', $pos: pos, value: 1 };
  const nodes = [parent, node];
  const initial: StoreCommit = {
    pos,
    writerEpoch: owner.resources.writerEpoch,
    writes: nodes.map((node) => ({ path: node.$path, node })),
    record: {
      pos,
      kind: 'commit',
      executor: 'kernel',
      caller: 'kernel',
      entries: nodes.map((node) => ({
        id: node.$id,
        path: node.$path,
        change: { t: 'create', after: node },
      })),
    },
  };
  await seeded.commit(initial);
  await seeded.close();
  const client = new MongoClient(uri);
  await client.connect();
  let lossExpected = false,
    recoveryRead = false;
  let readUnrelated: (() => Promise<void>) | undefined;
  const openCollection = owner.openCollection.bind(owner);
  t.mock.method(
    owner,
    'openCollection',
    async (options: Parameters<typeof owner.openCollection>[0]) => {
      const store = await openCollection(options);
      if (options.external === 'trusted') {
        const readExternal = store.readExternal!;
        store.readExternal = async (paths, budget) => {
          if (lossExpected && !recoveryRead) {
            recoveryRead = true;
            assert.ok(readUnrelated);
            await readUnrelated();
          }
          return readExternal(paths, budget);
        };
      }
      return store;
    },
  );
  const datasets = resolve(import.meta.dirname, '../../../temp/native-mongo-observers');
  await mkdir(datasets, { recursive: true });
  const directory = await mkdtemp(`${datasets}/run-`);
  const runtime = await openNativeRuntime({
    id,
    directory,
    credentialTtlMs: 60_000,
    firstAdmin: { path: '/admin', name: 'admin', password: randomUUID() },
    modules: [createMongoManifest({ cluster: owner })],
  });
  assert.ok(runtime.instance.setupCredential);
  const admin = await runtime.instance.openSession(runtime.instance.setupCredential);
  readUnrelated = async () => {
    const unrelated = await admin.read({ node: '/admin' });
    assert.ok(unrelated.copies.length > 0);
  };
  const draining = (async () => {
    for await (const frame of admin.frames) void frame;
  })();
  t.after(async () => {
    try {
      await runtime.close();
    } finally {
      await owner.close();
      await client.close();
      await draining;
    }
  });
  const result = await admin.commit({
    opId: { epoch: runtime.instance.writer.intake.epoch, time: Date.now(), nonce: randomUUID() },
    changes: [
      {
        op: 'put',
        node: {
          $path: '/dual',
          $type: 't.mount.mongo',
          pattern: 'left',
          cluster: 'cluster',
          db: database,
          collection: 'nodes',
          external: 'trusted',
          '#groups': { $type: 't.groups', list: ['admins'] },
        },
      },
    ],
  }).outcome;
  assert.ok(result.pos);
  await admin.read({ node: node.$path });
  const intakeEpoch = runtime.instance.writer.intake.epoch;
  const control = client.db(database).collection<{
    readonly _id: string;
    readonly writerEpoch: number;
    readonly epoch: string;
  }>('journal.__control');
  const durableBefore = await control.findOne(
    { _id: 'writer' },
    { projection: { _id: 0, writerEpoch: 1, epoch: 1 } },
  );
  assert.ok(durableBefore);
  const pool = getSharedClient(uri, true);
  await pool.ready;
  t.after(pool.release);
  const accepted = new Promise<JournalCommit>((done) => {
    const remove = runtime.instance.writer.stream.observe((event) => {
      if (
        event.t === 'commit' &&
        event.record.kind === 'reconcile' &&
        event.record.entries.some((entry) => entry.path === node.$path)
      ) {
        remove();
        done(event.record);
      }
    });
    t.after(remove);
  });
  const reset = new Promise<void>((done) => {
    const remove = runtime.instance.writer.stream.observe((event) => {
      if (event.t === 'reset' && event.domain === suffix) {
        remove();
        done();
      }
    });
    t.after(remove);
  });
  const edited = new Promise<void>((done, reject) => {
    const listener = async (event: import('mongodb').CommandStartedEvent) => {
      if (
        event.commandName !== 'getMore' ||
        event.databaseName !== database ||
        event.command.collection !== 'nodes'
      )
        return;
      pool.client.off('commandStarted', listener);
      try {
        const collection = client.db(database).collection('nodes');
        const before = await collection.findOne(
          { _path: '/left/a' },
          { projection: { _id: 0, _pos: 1 } },
        );
        await collection.updateOne({ _path: '/left/a' }, { $set: { value: 9 } });
        const after = await collection.findOne(
          { _path: '/left/a' },
          { projection: { _id: 0, _pos: 1 } },
        );
        assert.deepEqual(after?._pos, before?._pos);
        done();
      } catch (error) {
        reject(error);
      }
    };
    pool.client.on('commandStarted', listener);
    t.after(() => pool.client.off('commandStarted', listener));
  });
  lossExpected = true;
  await client.db('admin').command({
    configureFailPoint: 'failCommand',
    mode: { times: 1 },
    data: { failCommands: ['getMore'], blockConnection: true, blockTimeMS: 250, errorCode: 286 },
  });
  await edited;
  await reset;
  await client.db('admin').command({ configureFailPoint: 'failCommand', mode: 'off' });
  const copy = (await admin.read({ node: node.$path })).copies[0];
  assert.ok('node' in copy);
  assert.equal(copy.node.value, 9);
  assert.equal(recoveryRead, true);
  const record = await accepted;
  assert.ok(record.pos.seq > initial.pos.seq);
  const entry = record.entries.find((entry) => entry.path === node.$path);
  assert.ok(entry);
  assert.equal(entry.change.t, 'reconcile');
  assert.ok(!('before' in entry.change));
  if (entry.change.t !== 'reconcile') throw new Error('Expected external reconciliation');
  assert.ok(entry.change.after);
  assert.deepEqual(entry.change.after.$pos, record.pos);
  assert.equal(runtime.instance.writer.intake.epoch, intakeEpoch);
  const durableAfter = await control.findOne(
    { _id: 'writer' },
    { projection: { _id: 0, writerEpoch: 1, epoch: 1 } },
  );
  assert.deepEqual(durableAfter, durableBefore);
});
