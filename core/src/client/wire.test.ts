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

    // Transport receipt is opaque (changes: null = committed, contents on the
    // authority); a known no-op would be changes: [].
    assert.equal((await client.tree.remove('/b')).changes, null);
    assert.equal(await client.tree.get('/b'), undefined);

    const result = await client.execute('/a', 'ping', { x: 1 }, { key: 'k', type: 't' });
    assert.deepEqual(result, { ran: 'ping', key: 'k', type: 't' });
  });

  it('getChildren forwards the cursor when requesting the next page', async () => {
    const tree = createMemoryTree();
    const firstNode = createNode('/a', 'dir', { title: 'A' });
    const secondNode = createNode('/b', 'dir', { title: 'B' });
    const seenCursors: Array<string | undefined> = [];
    const pagedTree = Object.assign(Object.create(tree) as typeof tree, {
      getPerm: async () => (R | S),
      getChildren: async (
        _path: string,
        opts?: Parameters<typeof tree.getChildren>[1],
      ) => {
        seenCursors.push(opts?.cursor);
        return opts?.cursor === 'page-2'
          ? { items: [secondNode], total: 1 }
          : { items: [firstNode], total: 1, nextCursor: 'page-2' };
      },
    });
    const serve: PeerServe = {
      tree: pagedTree,
      hooks: { watch: () => {}, unwatch: () => {} },
    };
    const [clientConn, serverConn] = createLoopback();
    createPeer(() => serve).attach(serverConn);
    const client = createClient(clientConn);

    const first = await client.tree.getChildren('/', { limit: 1 });
    const second = await client.tree.getChildren('/', { limit: 1, cursor: first.nextCursor });

    assert.equal(first.items[0].$path, '/a');
    assert.equal(second.items[0].$path, '/b');
    assert.deepEqual(seenCursors, [undefined, 'page-2']);
  });

  it('tree.execute capability: act frame crosses loopback, opId passes, client.execute is sugar (core-pxlu)', async () => {
    const tree = createMemoryTree();
    const acts: { action: string; opId?: string; path: string }[] = [];
    const serve: PeerServe = {
      tree,
      execute: async (req) => { acts.push({ action: req.action, opId: req.opId, path: req.path }); return 'ok'; },
      hooks: { watch: () => {}, unwatch: () => {} },
    };
    const [clientConn, serverConn] = createLoopback();
    createPeer(() => serve).attach(serverConn);
    const client = createClient(clientConn);

    assert.ok(client.tree.execute, 'transport tree carries the capability');
    assert.equal(await client.tree.execute('/a', 'bump', undefined, { opId: 'wire-op' }), 'ok');
    assert.equal(await client.execute('/a', 'bump', undefined, { opId: 'wire-op-2' }), 'ok');

    assert.deepEqual(acts, [
      { action: 'bump', opId: 'wire-op', path: '/a' },
      { action: 'bump', opId: 'wire-op-2', path: '/a' },
    ]);
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

  it('cursor: seq watermark from stamped frames; reset adopts its cursor and fans out to watchPath consumers (anz4.10/11)', async () => {
    const { client, server } = await harness();
    const got: { ev?: string }[] = [];
    await client.watchPath('/a', (e) => got.push(e));

    server.emit({ seq: 3, ev: 'patch', path: '/a', ops: [['r', 'title', 'B']] });
    await new Promise<void>((r) => setImmediate(r));
    assert.deepEqual(client.cursor(), { seq: 3 });

    // Stamped break: adopt the break-point watermark + post-break epoch, and
    // every watchPath consumer is told to refetch (the reset has no path —
    // the path router alone would silently drop it).
    server.emit({ ev: 'reset', reason: 'resume', seq: 7, epoch: 'E2' });
    await new Promise<void>((r) => setImmediate(r));
    assert.deepEqual(client.cursor(), { seq: 7, epoch: 'E2' });
    assert.equal(got.filter((f) => f.ev === 'reset').length, 1);

    // Plain verdict reset (no cursor): epoch drops — a later resume without an
    // epoch is refused server-side, which is the fail-closed default.
    server.emit({ ev: 'reset', reason: 'resume' });
    await new Promise<void>((r) => setImmediate(r));
    assert.deepEqual(client.cursor(), { seq: 0 });
    assert.equal(got.filter((f) => f.ev === 'reset').length, 2);
  });
});
