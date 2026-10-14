import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { it } from 'node:test';
import { MongoClient } from 'mongodb';
import { openNativeRuntime } from '@treenx/core/kernel/runtime';
import { createMongoManifest } from '#native-mount';
import { openMongoTransactionOwner } from '#owner';

it('routes actual main and named Mongo mounts separately and moves one issued identity across them', async (t) => {
  const uri = process.env.NATIVE_MONGO_TEST_URI;
  assert.ok(uri);
  const suffix = randomUUID().replaceAll('-', '');
  const id = `mongo-session-${suffix}`;
  const owner = await openMongoTransactionOwner({
    uri,
    domain: suffix,
    instance: id,
    journalDb: `native_${suffix}`,
    journalCollection: 'journal',
  });
  const client = new MongoClient(uri);
  const parent = resolve(import.meta.dirname, '../../../temp/native-mongo-sessions');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(`${parent}/run-`);
  const runtime = await openNativeRuntime({
    id,
    directory,
    credentialTtlMs: 60_000,
    firstAdmin: { path: '/admin', name: 'admin', password: 'native-mongo-password' },
    modules: [createMongoManifest({ cluster: owner })],
  });
  assert.ok(runtime.instance.setupCredential);
  const admin = await runtime.instance.openSession(runtime.instance.setupCredential);
  const draining = (async () => {
    for await (const frame of admin.frames) void frame;
  })();
  t.after(async () => {
    await runtime.close();
    await draining;
    await owner.close();
    await client.close();
  });
  await client.connect();
  const key = () => ({
    epoch: runtime.instance.writer.intake.epoch,
    time: Date.now(),
    nonce: randomUUID(),
  });
  await admin.commit({
    opId: key(),
    changes: [
      {
        op: 'put',
        node: {
          $path: '/dual',
          $type: 't.mount.mongo',
          pattern: 'left',
          cluster: 'cluster',
          db: `left_${suffix}`,
          collection: 'nodes',
          '#right': {
            $type: 't.mount.mongo',
            pattern: 'right',
            cluster: 'cluster',
            db: `right_${suffix}`,
            collection: 'nodes',
          },
          '#groups': { $type: 't.groups', list: ['admins'] },
        },
      },
    ],
  }).outcome;
  await admin.read({ children: '/dual/left' });
  await admin.read({ children: '/dual/right' });
  await admin.commit({
    opId: key(),
    changes: [
      { op: 'put', node: { $path: '/dual/left/a', $type: 't.dir', value: 1 } },
      { op: 'put', node: { $path: '/dual/right/b', $type: 't.dir', value: 2 } },
    ],
  }).outcome;
  const before = (await admin.read({ node: '/dual/left/a' })).copies[0];
  assert.ok('node' in before);
  assert.equal(
    await client.db(`left_${suffix}`).collection('nodes').countDocuments({ _path: '/left/a' }),
    1,
  );
  assert.equal(
    await client.db(`right_${suffix}`).collection('nodes').countDocuments({ _path: '/right/b' }),
    1,
  );
  await admin.commit({
    opId: key(),
    changes: [{ op: 'move', from: '/dual/left/a', to: '/dual/right/a' }],
  }).outcome;
  const after = (await admin.read({ node: '/dual/right/a' })).copies[0];
  assert.ok('node' in after);
  assert.equal(after.node.$id, before.node.$id);
  assert.equal(after.node.value, 1);
  assert.equal(
    await client.db(`left_${suffix}`).collection('nodes').countDocuments({ _path: '/left/a' }),
    0,
  );
  assert.equal(
    await client.db(`right_${suffix}`).collection('nodes').countDocuments({ _path: '/right/a' }),
    1,
  );
  const oldHistory = await admin.read({ history: '/dual/left' });
  const newHistory = await admin.read({ history: '/dual/right' });
  assert.ok(oldHistory.history !== undefined && newHistory.history !== undefined);
  const moved = (entry: NonNullable<typeof oldHistory.history>[number]) =>
    entry.address.id === before.node.$id &&
    entry.before !== null &&
    entry.before !== 'unknown' &&
    entry.before.$path === '/dual/left/a' &&
    entry.after?.$path === '/dual/right/a';
  assert.equal(oldHistory.history.filter(moved).length, 1);
  assert.equal(newHistory.history.filter(moved).length, 1);

  const other = (await admin.read({ node: '/dual/right/b' })).copies[0];
  assert.ok('node' in other);
  await admin.commit({
    opId: key(),
    changes: [
      { op: 'move', from: '/dual/right/a', to: '/dual/right/temporary' },
      { op: 'move', from: '/dual/right/b', to: '/dual/right/a' },
      { op: 'move', from: '/dual/right/temporary', to: '/dual/right/b' },
    ],
  }).outcome;
  const swappedA = (await admin.read({ node: '/dual/right/a' })).copies[0];
  const swappedB = (await admin.read({ node: '/dual/right/b' })).copies[0];
  assert.ok('node' in swappedA && 'node' in swappedB);
  assert.equal(swappedA.node.$id, other.node.$id);
  assert.equal(swappedB.node.$id, before.node.$id);
  assert.equal(
    await client
      .db(`right_${suffix}`)
      .collection('nodes')
      .countDocuments({ _path: '/right/temporary' }),
    0,
  );
});
