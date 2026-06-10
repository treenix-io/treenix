// TWP-native client over loopback — TreenixClient surface + watch lifecycle (core-m77 class).

import { createNode, R, S } from '#core';
import { createMemoryTree } from '#tree';
import { createLoopback } from '#protocol/loopback';
import { createPeer, type PeerServe } from '#protocol/peer';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createClient } from './wire';

async function harness() {
  const tree = createMemoryTree();
  await tree.set(createNode('/a', 'dir', { title: 'A' }));

  const watched: string[][] = [];
  const unwatched: string[][] = [];
  const serve: PeerServe = {
    tree: Object.assign(Object.create(tree) as typeof tree, {
      getPerm: async () => (R | S),
    }),
    execute: async (req) => ({ ran: req.action, key: req.key, type: req.type }),
    hooks: {
      watch: (paths) => watched.push(paths),
      unwatch: (paths) => unwatched.push(paths),
    },
  };

  const [clientConn, serverConn] = createLoopback();
  const server = createPeer(() => serve);
  server.attach(serverConn);
  const client = createClient(clientConn);
  return { tree, client, server, watched, unwatched };
}

describe('TWP wire client', () => {
  it('TreenixClient surface: tree ops + execute', async () => {
    const { client } = await harness();

    const a = await client.tree.get('/a');
    assert.equal(a?.title, 'A');

    await client.tree.set({ $path: '/b', $type: 'dir', n: 1 });
    const page = await client.tree.getChildren('/', { limit: 10 });
    assert.ok(page.items.some((n) => n.$path === '/b'));

    await client.tree.patch('/b', [['r', 'n', 2]]);
    const b = await client.tree.get('/b');
    assert.equal(b?.n, 2);

    assert.equal(await client.tree.remove('/b'), true);

    const result = await client.execute('/a', 'ping', { x: 1 }, { key: 'k', type: 't' });
    assert.deepEqual(result, { ran: 'ping', key: 'k', type: 't' });
  });

  it('watchPath: registers watch, routes events by path, releases server watch once', async () => {
    const { client, server, watched, unwatched } = await harness();

    const got1: unknown[] = [];
    const got2: unknown[] = [];
    const w1 = await client.watchPath('/a', (e) => got1.push(e));
    const w2 = await client.watchPath('/a', (e) => got2.push(e));
    assert.equal((w1.node as { title: string }).title, 'A');
    assert.deepEqual(watched, [['/a'], ['/a']]); // each get{watch} registers; server dedups by watch-set

    const delivered = new Promise<void>((resolve) => {
      const w3 = client.watch(() => { resolve(); w3.unsubscribe(); });
    });
    server.emit({ seq: 1, ev: 'patch', path: '/a', ops: [['r', 'title', 'B']] });
    server.emit({ seq: 2, ev: 'patch', path: '/other', ops: [['r', 'x', 1]] });
    await delivered;

    assert.equal(got1.length, 1);
    assert.equal(got2.length, 1);
    assert.deepEqual(got1[0], { seq: 1, ev: 'patch', path: '/a', ops: [['r', 'title', 'B']] });

    // Release: unsub frame goes out exactly once, after the LAST consumer leaves.
    w1.unsubscribe();
    assert.deepEqual(unwatched, []);
    w2.unsubscribe();
    await new Promise<void>((r) => setImmediate(r)); // let the unsub frame cross the loopback
    assert.deepEqual(unwatched, [['/a']]);
  });

  it('global watch delivers all events; unsubscribe detaches', async () => {
    const { client, server } = await harness();
    const got: unknown[] = [];
    const sub = client.watch((e: unknown) => got.push(e));

    const delivered = new Promise<void>((resolve) => {
      const probe = client.watch(() => { resolve(); probe.unsubscribe(); });
    });
    server.emit({ ev: 'rm', path: '/x' });
    await delivered;
    assert.equal(got.length, 1);

    sub.unsubscribe();
    server.emit({ ev: 'rm', path: '/y' });
    await new Promise<void>((r) => setImmediate(r));
    assert.equal(got.length, 1);
  });

  it('destroy closes the connection — further requests reject', async () => {
    const { client } = await harness();
    client.destroy();
    await assert.rejects(client.tree.get('/a'), /not attached|closed/);
  });
});
