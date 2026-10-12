import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';
import { MongoClient } from 'mongodb';
import { openNativeDeployment } from '../../../core/src/server/native-deployment';
import { drainSession } from '@treenx/core/kernel/session-delivery';
import { A, R, W, type Node, type Session } from '@treenx/core/kernel/types';
import type { MongoClosedBinding } from '#closed-provider';
import './kernel';

/** Read the accepted identity through the actual administrator session. */
async function read(session: Session, path: string): Promise<Node> {
  const copy = (await session.read({ node: path })).copies[0];
  assert.ok('node' in copy);
  return copy.node;
}

it(
  'boots a closed Mongo package capability and retains its native node across restart',
  { timeout: 20000 },
  async (test) => {
    const uri = process.env.NATIVE_MONGO_TEST_URI;
    assert.ok(uri);
    const suffix = randomUUID().replaceAll('-', '');
    const database = `native_boot_${suffix}`;
    const id = `mongo-boot-${suffix}`;
    const parent = fileURLToPath(
      new URL('../../../../temp/native-mongo-boot-first-pass/', import.meta.url),
    );
    await mkdir(parent, { recursive: true });
    const directory = await mkdtemp(`${parent}instance-`);
    const connection: MongoClosedBinding = {
      connection: '/connection',
      instance: id,
      domain: `${id}:mongo`,
      journalDb: database,
      journalCollection: 'journal',
    };
    const config = {
      runtime: {
        id,
        directory,
        credentialTtlMs: 60000,
        firstAdmin: { path: '/admin', name: 'admin', password: 'fixture-password' },
      },
      modules: [],
      additionalModules: [
        { id: '@treenx/mongo', entry: new URL('./kernel.ts', import.meta.url).href },
      ],
      host: { mongo: { main: connection } },
    };
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 3000 });
    const runtimes: Awaited<ReturnType<typeof openNativeDeployment>>[] = [];
    const deliveries: Promise<void>[] = [];
    test.after(async () => {
      for (const runtime of runtimes.reverse()) await runtime.close();
      await Promise.all(deliveries);
      await client.close();
    });

    const first = await openNativeDeployment(config);
    runtimes.push(first);
    const credential = await first.instance.auth.login({
      account: '/admin',
      password: 'fixture-password',
    });
    const admin = await first.instance.openSession(credential);
    deliveries.push(drainSession(admin));
    const key = () => ({
      epoch: first.instance.writer.intake.epoch,
      time: Date.now(),
      nonce: randomUUID(),
    });
    await admin.commit({
      opId: key(),
      changes: [
        {
          op: 'put',
          node: {
            $path: '/products',
            $type: 't.mount.mongo',
            pattern: '',
            cluster: 'main',
            db: database,
            collection: 'products',
            '#groups': { $type: 't.groups', list: ['admins'] },
          },
        },
        {
          op: 'put',
          node: {
            $path: '/connection',
            $type: 't.mongo.connection',
            uri,
            $acl: [{ subject: { group: 'admins' }, grant: R | W | A }],
          },
        },
      ],
    }).outcome;
    const mount = await read(admin, '/products');
    await admin.commit({
      opId: key(),
      expect: { nodes: [{ path: mount.$path, rev: mount.$rev }] },
      changes: [
        {
          op: 'patch',
          path: '/connection',
          ops: {
            $set: {
              $acl: [
                { subject: { group: 'admins' }, grant: R | W | A },
                { subject: { group: `n:${mount.$id}` }, grant: R },
              ],
            },
          },
        },
      ],
    }).outcome;
    await admin.read({ children: '/products' });
    await admin.commit({
      opId: key(),
      changes: [
        {
          op: 'put',
          node: {
            $path: '/products/item',
            $type: 't.dir',
            name: 'Native product',
          },
        },
      ],
    }).outcome;
    const saved = await read(admin, '/products/item');
    await client.connect();
    assert.equal(
      await client.db(database).collection('products').countDocuments({ _path: '/item' }),
      1,
    );
    await first.close();

    const reopened = await openNativeDeployment(config);
    runtimes.push(reopened);
    const login = await reopened.instance.auth.login({
      account: '/admin',
      password: 'fixture-password',
    });
    const reader = await reopened.instance.openSession(login);
    deliveries.push(drainSession(reader));
    const restored = await read(reader, '/products/item');
    assert.equal(restored.$id, saved.$id);
    assert.equal(restored.name, 'Native product');
  },
);
