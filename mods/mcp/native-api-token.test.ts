import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createNodeClient, createTwpClient, openTwpHttp } from '@treenx/core/client';
import { createInstance } from '../../core/src/kernel/instance';
import { createMemoryStore } from '@treenx/core/kernel/store/memory';
import { createMemoryBlobStore } from '@treenx/core/kernel/blob-store-memory';
import { R, type Position } from '@treenx/core/kernel/types';
import { createTwpHttpServer } from '@treenx/core/server/http-twp';
import { nativeApiTokenManifest } from './native-api-token';
import { ApiToken, ApiTokenManager } from './types';

test(
  'the typed token UI contract creates a scoped credential and revokes its descriptor',
  { timeout: 10_000 },
  async (t) => {
    const id = randomUUID(),
      root = createMemoryStore({ domain: id });
    let saved: Position | undefined;
    const instance = await createInstance({
      id,
      root: { kind: 'store', store: root },
      blobs: createMemoryBlobStore(),
      modules: [nativeApiTokenManifest()],
      provisioning: {
        writerEpoch: 1,
        domains: [{ store: root, epoch: id, persistent: false }],
        counter: {
          /** Read the accepted counter position. */
          async load() {
            return saved;
          },
          /** Persist the fixture writer position. */
          async save(position) {
            saved = position;
          },
          /** Allocate an epoch above the durable floor. */
          async freshEpoch(floor) {
            return floor + 1;
          },
        },
        credentialTtlMs: 60_000,
        bootstrap: {
          kind: 'fresh',
          admin: { path: '/admin', name: 'admin', password: randomUUID() },
        },
      },
    });
    t.after(() => instance.close());
    const credential = instance.setupCredential;
    assert.ok(credential);
    const admin = await instance.openSession(credential);
    const delivery = (async () => {
      for await (const frame of admin.lane) if (frame.t === 'end') throw frame.error;
    })();
    await admin.commit({
      opId: { epoch: instance.writer.intake.epoch, time: Date.now(), nonce: randomUUID() },
      changes: [
        { op: 'put', node: { $path: '/tokens', $type: 't.api.tokens' } },
        {
          op: 'put',
          node: {
            $path: '/work',
            $type: 't.dir',
            $acl: [{ subject: { group: 'agent' }, grant: R }],
          },
        },
      ],
    }).outcome;
    admin.close();
    await delivery;

    const http = createTwpHttpServer({ instance, allowedOrigins: [], credentialTtlMs: 60_000 });
    t.after(() => http.close());
    http.server.listen(0, '127.0.0.1');
    await once(http.server, 'listening');
    const address = http.server.address();
    assert.ok(address !== null && typeof address === 'object');
    const url = `http://127.0.0.1:${address.port}`;
    const connection = await openTwpHttp({ url, credential });
    const client = createTwpClient(connection, { credential, close: connection.close });
    t.after(() => client.close());
    await client.ready;

    const nodes = createNodeClient(client);
    const actions = nodes('/tokens').get(ApiTokenManager);
    const issued = await actions.create({ name: 'worker', groups: ['agent'], scope: ['/work'] });
    const token = await nodes(`/tokens/${issued.id}`).fetch(ApiToken);
    assert.equal(token.name, 'worker');
    assert.equal(token.principal, issued.userId);
    assert.ok(token.accountPath.startsWith('/auth/users/api-'));

    const workerCredential = { token: issued.token };
    const workerConnection = await openTwpHttp({ url, credential: workerCredential });
    const worker = createTwpClient(workerConnection, {
      credential: workerCredential,
      close: workerConnection.close,
    });
    t.after(() => worker.close());
    await worker.ready;
    const work = (await worker.read({ node: '/work' })).copies[0];
    assert.ok('node' in work);
    assert.equal(work.node.$path, '/work');

    assert.deepEqual(await actions.revoke({ id: issued.id }), { revoked: true });
    assert.equal((await client.read({ children: '/tokens' })).copies.length, 0);
  },
);
