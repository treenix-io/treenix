// Treenix Client SDK — e2e tests
// Tests createTrpcTransport + createRepathTree + t.mount.tree.trpc

import { registerType } from '#comp';
import { createNode, R, register, S, W } from '#core';
import { withMounts } from '#server/mount';
import { setAllowPrivateUrls } from '#server/mount-adapters';
import { createTreenixServer } from '#server/server';
import { createMemoryTree } from '#tree';
import { createRepathTree } from '#tree/repath';
import assert from 'node:assert/strict';
import type { Socket } from 'node:net';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { createTrpcTransport } from './trpc';

// ── Helpers ──

function listen(server: import('node:http').Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as { port: number }).port);
    });
  });
}

// ── Test type ──

class Counter {
  count = 0;
  increment() { this.count++; }
}

describe('Treenix Client SDK', () => {
  let ts: ReturnType<typeof createTreenixServer>;
  let url: string;
  const sockets = new Set<Socket>();

  before(() => {
    registerType('counter', Counter);
    register('counter', 'schema', () => ({
      $id: 'counter', title: 'Counter', type: 'object' as const,
      properties: { count: { type: 'number' } },
      methods: { increment: { arguments: [] } },
    }));
  });

  beforeEach(async () => {
    const bootstrap = createMemoryTree();
    await bootstrap.set({
      ...createNode('/', 'root'),
      $acl: [{ g: 'public', p: R | W | S }],
    });

    ts = createTreenixServer(bootstrap);
    ts.server.on('connection', (s: Socket) => {
      sockets.add(s);
      s.on('close', () => sockets.delete(s));
    });
    const port = await listen(ts.server);
    url = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    for (const s of sockets) s.destroy();
    sockets.clear();
    await new Promise<void>((r) => ts.server.close(() => r()));
  });

  // ── createTrpcTransport ──

  describe('createTrpcTransport', () => {
    it('tree.get + tree.set roundtrip', async () => {
      const { tree } = createTrpcTransport({ url });
      await tree.set(createNode('/hello', 'doc', { title: 'World' }));
      const node = await tree.get('/hello');

      assert.ok(node);
      assert.equal(node.$type, 't.doc');
      assert.equal((node as any).title, 'World');
    });

    it('tree.getChildren returns children', async () => {
      const { tree } = createTrpcTransport({ url });
      await tree.set(createNode('/items', 'dir'));
      await tree.set(createNode('/items/a', 'doc'));
      await tree.set(createNode('/items/b', 'doc'));

      const { items } = await tree.getChildren('/items');
      assert.equal(items.length, 2);
    });

    it('tree.remove deletes node', async () => {
      const { tree } = createTrpcTransport({ url });
      await tree.set(createNode('/tmp', 'doc'));
      await tree.remove('/tmp');

      assert.equal(await tree.get('/tmp'), undefined);
    });

    it('execute calls action', async () => {
      const { tree, execute } = createTrpcTransport({ url });
      await tree.set(createNode('/c', 'counter', { count: 0 }));

      await execute('/c', 'increment');

      const node = await tree.get('/c');
      assert.equal((node as any).count, 1);
    });
  });

  // ── createRepathTree over tRPC ──

  describe('createRepathTree + tRPC', () => {
    it('translates paths over the wire', async () => {
      const { tree: remote } = createTrpcTransport({ url });

      // Write via server at absolute path
      await remote.set(createNode('/data/item', 'doc', { v: 42 }));

      // Mount remote's /data at local /mnt
      const mounted = createRepathTree(remote, '/mnt', '/data');
      const node = await mounted.get('/mnt/item');

      assert.ok(node);
      assert.equal(node.$path, '/mnt/item');
      assert.equal((node as any).v, 42);
    });

    it('set through repath writes to correct remote path', async () => {
      const { tree: remote } = createTrpcTransport({ url });
      const mounted = createRepathTree(remote, '/mnt', '/tree');

      await mounted.set(createNode('/mnt/new', 'doc', { x: 1 }));

      // Verify via direct remote access
      const node = await remote.get('/tree/new');
      assert.ok(node);
      assert.equal(node.$path, '/tree/new');
    });
  });

  // ── t.mount.tree.trpc ──

  describe('t.mount.tree.trpc', () => {
    before(() => setAllowPrivateUrls(true));
    after(() => setAllowPrivateUrls(false));

    it('mounts remote tree with path translation', async () => {
      // Set up content on the remote server
      const { tree: remote } = createTrpcTransport({ url });
      await remote.set(createNode('/strategies/alpha', 'doc', { score: 99 }));

      // Create a local bootstrap with mount pointing to remote
      const local = createMemoryTree();
      await local.set({
        ...createNode('/', 'root'),
        $acl: [{ g: 'public', p: R | W | S }],
      });
      await local.set({
        $path: '/remote',
        $type: 'dir',
        mount: { $type: 't.mount.tree.trpc', url, path: '/strategies' },
      });

      const tree = withMounts(local);
      const node = await tree.get('/remote/alpha');

      assert.ok(node);
      assert.equal(node.$path, '/remote/alpha');
      assert.equal((node as any).score, 99);
    });

    it('getChildren through mount', async () => {
      const { tree: remote } = createTrpcTransport({ url });
      await remote.set(createNode('/items', 'dir'));
      await remote.set(createNode('/items/x', 'doc'));
      await remote.set(createNode('/items/y', 'doc'));

      const local = createMemoryTree();
      await local.set({
        ...createNode('/', 'root'),
        $acl: [{ g: 'public', p: R | W | S }],
      });
      await local.set({
        $path: '/fed',
        $type: 'dir',
        mount: { $type: 't.mount.tree.trpc', url, path: '/items' },
      });

      const tree = withMounts(local);
      const { items } = await tree.getChildren('/fed');

      assert.equal(items.length, 2);
      const paths = items.map(n => n.$path).sort();
      assert.deepEqual(paths, ['/fed/x', '/fed/y']);
    });
  });
});
