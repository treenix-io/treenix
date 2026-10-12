import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { once } from 'node:events';
import { openNativeRuntime } from '@treenx/core/kernel/runtime';
import { createTwpHttpServer } from '@treenx/core/server/http-twp';
import { openTwpHttp } from '@treenx/core/client/http-twp';
import { createTwpClient } from '@treenx/core/client/twp';
import { createAgentClient, createNodeClient } from '#index';
import { KernelError } from '@treenx/core/errors';
import { R, W, A } from '@treenx/core/kernel';

class Item {
  static $type = 't.dir';
  value = 0;
}

/** Exercise SDK pairing and scope through the deployed native HTTP owner. */
test('native agent pairing issues scoped account credentials and revokes them', async () => {
  const temporary = new URL('../../../../temp/', import.meta.url);
  await mkdir(temporary, { recursive: true });
  const directory = await mkdtemp(new URL('native-agent-data-', temporary));
  const runtime = await openNativeRuntime({
    id: 'native-agent-smoke',
    directory,
    credentialTtlMs: 60_000,
    firstAdmin: { path: '/admin', name: 'admin', password: 'smoke-password' },
    modules: [],
  });
  const http = createTwpHttpServer({
    instance: runtime.instance,
    allowedOrigins: [],
    credentialTtlMs: 60_000,
  });
  http.server.listen(0, '127.0.0.1');
  await once(http.server, 'listening');
  const address = http.server.address();
  if (address === null || typeof address === 'string') throw Error('Missing address');
  const url = `http://127.0.0.1:${address.port}`;
  const credential = runtime.instance.setupCredential;
  if (credential === undefined) throw Error('Missing admin credential');
  const connection = await openTwpHttp({ url, credential });
  const admin = createTwpClient(connection, { credential, close: connection.close });
  let agent: ReturnType<typeof createTwpClient> | undefined;
  try {
    await admin.ready;
    await admin.commit({
      changes: [
        {
          op: 'put',
          node: { $path: '/agents/bot', $type: 't.agent.port', status: 'idle', label: 'bot' },
        },
        { op: 'put', node: { $path: '/agents/bot/data', $type: 't.dir' } },
        { op: 'put', node: { $path: '/agents/bot/other', $type: 't.dir' } },
      ],
    }).outcome;
    const port = (await admin.read({ node: '/agents/bot' })).copies[0];
    if ('error' in port) throw port.error;
    await admin.commit({
      expect: { nodes: [{ path: port.node.$path, rev: port.node.$rev }] },
      changes: [
        {
          op: 'patch',
          path: port.node.$path,
          ops: {
            $set: {
              $acl: [
                { subject: { group: 'public' }, grant: R },
                { subject: { group: `n:${port.node.$id}` }, grant: R | W | A },
              ],
            },
          },
        },
      ],
    }).outcome;
    await admin.act({
      path: port.node.$path,
      action: 'initPair',
      args: { key: 'agent-key', scope: ['/agents/bot/data'] },
    }).outcome;
    const sdk = createAgentClient({ url, path: port.node.$path, key: 'agent-key' });
    assert.deepEqual(await sdk.connect(), { status: 'pending' });
    const approved = sdk.waitForApproval({ timeout: 5000 });
    await admin.act({ path: port.node.$path, action: 'approve', args: {} }).outcome;
    agent = await approved;
    const welcome = await agent.ready;
    const account = (await admin.read({ node: `/auth/users/agent-${port.node.$id}` })).copies[0];
    if ('error' in account) throw account.error;
    assert.equal(welcome.principal, `u:${account.node.$id}`);
    const direct = await createAgentClient({ url, credential }).connect();
    assert.equal(direct.status, 'approved');
    if (direct.status !== 'approved') throw Error('Admin connection stayed pending');
    try {
      assert.equal((await direct.client.read({ node: '/admin' })).copies.length, 1);
    } finally {
      direct.client.close();
    }
    const relative = (await agent.read({ node: './data' })).copies[0];
    if ('error' in relative) throw relative.error;
    assert.equal(relative.node.$path, '/agents/bot/data');
    await agent.commit({
      changes: [{ op: 'put', node: { $path: 'data/item', $type: 't.dir', value: 7 } }],
      expect: { absent: ['data/item'] },
    }).outcome;
    const written = (await agent.read({ node: 'data/item' })).copies[0];
    if ('error' in written) throw written.error;
    assert.equal(written.node.value, 7);
    await agent.commit({
      changes: [{ op: 'patch', path: 'data/item', ops: { $set: { value: 8 } } }],
      expect: { nodes: [{ path: 'data/item', rev: written.node.$rev }] },
    }).outcome;
    const included = await agent.read({ children: 'data', include: [{ path: './data' }] });
    assert.equal(included.list.length, 1);
    assert.equal(included.copies.length, 2);
    const subscription = agent.sub({ node: 'data/item' }, () => {});
    await subscription.ready;
    const cached = agent.cache.at('/agents/bot/data/item');
    assert.ok(cached !== undefined && 'node' in cached);
    assert.equal(cached.node.value, 8);
    subscription.close();
    const handle = createNodeClient(agent)('data/item');
    assert.equal((await handle.fetch(Item)).value, 8);
    const values: number[] = [];
    const typed = await handle.sub(Item, (value) => values.push(value.value));
    assert.deepEqual(values, [8]);
    typed.unsubscribe();
    await assert.rejects(
      agent.read({ node: '/agents/bot/other' }),
      (error) => error instanceof KernelError && error.code === 'NOT_FOUND',
    );
    await admin.act({ path: port.node.$path, action: 'revoke', args: {} }).outcome;
    await assert.rejects(
      async () => {
        if (agent === undefined) throw Error('Missing agent');
        return agent.read({ node: '/agents/bot/data' });
      },
      (error) => error instanceof KernelError,
    );
    await assert.rejects(
      sdk.connect(),
      (error) => error instanceof KernelError && error.code === 'FORBIDDEN',
    );
  } finally {
    agent?.close();
    admin.close();
    await http.close();
    await runtime.close();
  }
});
