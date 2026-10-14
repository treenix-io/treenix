import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { it } from 'node:test';
import { MongoClient } from 'mongodb';
import { openNativeRuntime } from '@treenx/core/kernel/runtime';
import { scanBudget } from '@treenx/core/kernel/testing';
import type { ChangeMember } from '@treenx/core/kernel/types';
import { createMongoManifest } from '#native-mount';
import { openMongoTransactionOwner } from '#owner';

it('switches an actual native Session subtree into its owning Mongo transaction without copying history', async (t) => {
  const uri = process.env.NATIVE_MONGO_TEST_URI;
  assert.ok(uri);
  const suffix = randomUUID().replaceAll('-', '');
  const id = `mongo-transfer-${suffix}`;
  const db = `transfer_session_${suffix}`;
  const owner = await openMongoTransactionOwner({
    uri,
    instance: id,
    domain: db,
    journalDb: db,
    journalCollection: 'journal',
  });
  const client = new MongoClient(uri);
  const parent = resolve(import.meta.dirname, '../../../temp/native-mongo-transfers');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(`${parent}/run-`);
  const runtime = await openNativeRuntime({
    id,
    directory,
    rootExternal: 'none',
    credentialTtlMs: 60_000,
    firstAdmin: { path: '/admin', name: 'admin', password: 'owned-transfer-password' },
    modules: [createMongoManifest({ cluster: owner })],
  });
  assert.ok(runtime.instance.setupCredential);
  const admin = await runtime.instance.openSession(runtime.instance.setupCredential);
  const frames = (async () => {
    for await (const frame of admin.frames) void frame;
  })();
  t.after(async () => {
    await runtime.close();
    await frames;
    await owner.close();
    await client.close();
  });
  await client.connect();

  /** Consume both typed Pending channels through the real Session mutation door. */
  async function commit(changes: readonly ChangeMember[]) {
    const pending = admin.commit({
      opId: { epoch: runtime.instance.writer.intake.epoch, time: Date.now(), nonce: randomUUID() },
      changes,
    });
    const chunks = (async () => {
      for await (const chunk of pending.chunks) void chunk;
    })();
    const outcome = await pending.outcome;
    await chunks;
    return outcome;
  }

  await commit([
    {
      op: 'put',
      node: { $path: '/mount', $type: 't.dir', '#groups': { $type: 't.groups', list: ['admins'] } },
    },
    { op: 'put', node: { $path: '/mount/doc', $type: 't.dir', value: 'original' } },
  ]);
  const source = runtime.instance.root;
  const original = (await source.scan({ range: { node: '/mount/doc' }, budget: scanBudget() }))
    .items[0];
  const epoch = runtime.instance.writer.intake.epoch;
  await runtime.instance.transferSubtree({
    path: '/mount',
    component: '#mount',
    declaration: {
      $type: 't.mount.mongo',
      pattern: 'doc',
      cluster: 'cluster',
      db,
      collection: 'nodes',
    },
  });
  assert.notEqual(runtime.instance.writer.intake.epoch, epoch);
  const destination = runtime.instance.readerSource(scanBudget()).resolve('/mount/doc').store;
  const copied = (await destination.scan({ range: { node: '/mount/doc' }, budget: scanBudget() }))
    .items[0];
  assert.deepEqual(copied, original);
  assert.equal(
    (await source.scan({ range: { node: '/mount/doc' }, budget: scanBudget() })).items.length,
    0,
  );
  assert.equal(
    (await destination.scan({ range: { journal: '/mount/doc' }, budget: scanBudget() })).items
      .length,
    0,
  );
  assert.equal(
    await client.db(db).collection('nodes').countDocuments({ _path: '/doc', _tid: original.$id }),
    1,
  );
  await commit([
    { op: 'patch', path: '/mount/doc', ops: { $set: { value: 'authored after switch' } } },
  ]);
  const current = await admin.read({ node: '/mount/doc' });
  assert.ok('node' in current.copies[0]);
  assert.equal(current.copies[0].node.$id, original.$id);
  assert.equal(current.copies[0].node.value, 'authored after switch');
});
