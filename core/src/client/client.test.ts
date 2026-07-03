// Treenix Client SDK — e2e tests
// Tests createTrpcTransport + createRepathTree + t.mount.tree.trpc

import { registerType } from '#comp';
import { A, createNode, R, register, S, W } from '#core';
import { withMounts } from '#mount';
import { setAllowPrivateUrls } from '#mount/adapters';
import { createHttpServer, createPipeline, type Pipeline } from '#server/server';
import { createMemoryTree, type Tree } from '#tree';
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

type TestServer = Pipeline & { server: import('node:http').Server };

function createTestServer(bootstrap: Tree): TestServer {
  const pipeline = createPipeline(bootstrap);
  return { ...pipeline, server: createHttpServer(pipeline) };
}

// ── Test type ──

class Counter {
  count = 0;
  increment() { this.count++; }
}

describe('Treenix Client SDK', () => {
  let ts: TestServer;
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
      // authenticated: registered users (opId-replay test) — authed principals
      // don't carry the 'public' claim (claims.ts:22).
      $acl: [{ g: 'public', p: R | W | S }, { g: 'authenticated', p: R | W | S }, { g: 'system', p: R | W | A | S }],
    });

    ts = createTestServer(bootstrap);
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
        $acl: [{ g: 'public', p: R | W | S }, { g: 'system', p: R | W | A | S }],
      });
      await local.set({
        $path: '/remote',
        $type: 'dir',
        '#mount': { $type: 't.mount.tree.trpc', url, path: '/strategies' },
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
        $acl: [{ g: 'public', p: R | W | S }, { g: 'system', p: R | W | A | S }],
      });
      await local.set({
        $path: '/fed',
        $type: 'dir',
        '#mount': { $type: 't.mount.tree.trpc', url, path: '/items' },
      });

      const tree = withMounts(local);
      const { items } = await tree.getChildren('/fed');

      assert.equal(items.length, 2);
      const paths = items.map(n => n.$path).sort();
      assert.deepEqual(paths, ['/fed/x', '/fed/y']);
    });
  });

  // ── Tree.execute federation (core-pxlu) ──
  // Two FULL servers: A mounts B via t.mount.tree.trpc; execute through A must
  // run on B (delegation), not in A's local executor. The observable proof is a
  // DYNAMIC action living only in B's /sys/types — the in-process registry is
  // shared between both servers in tests, so registry actions can't tell the
  // executors apart; /sys/types lookup can.

  describe('Tree.execute federation (core-pxlu)', () => {
    let tsB: TestServer;
    let urlB: string;
    const socketsB = new Set<Socket>();

    before(() => setAllowPrivateUrls(true));
    after(() => setAllowPrivateUrls(false));

    beforeEach(async () => {
      const bootstrapB = createMemoryTree();
      await bootstrapB.set({
        ...createNode('/', 'root'),
        $acl: [{ g: 'public', p: R | W | S }, { g: 'system', p: R | W | A | S }],
      });
      tsB = createTestServer(bootstrapB);
      tsB.server.on('connection', (s: Socket) => {
        socketsB.add(s);
        s.on('close', () => socketsB.delete(s));
      });
      const port = await listen(tsB.server);
      urlB = `http://127.0.0.1:${port}`;

      // B holds a dynamic action type + a widget instance.
      const clientB = createTrpcTransport({ url: urlB });
      await clientB.tree.set({
        $path: '/sys/types/fedtest/widget',
        $type: 'type',
        actions: {
          bump: 'var node = ctx.tree.get(ctx.node.$path); node.n = (node.n || 0) + 1; ctx.tree.set(node); return node.n;',
        },
        schema: { methods: { bump: { arguments: [] } } },
      });
      await clientB.tree.set(createNode('/w', 'fedtest.widget', { n: 0 }));

      // A mounts B's root at /fed.
      const clientA = createTrpcTransport({ url });
      await clientA.tree.set({
        $path: '/fed',
        $type: 'dir',
        '#mount': { $type: 't.mount.tree.trpc', url: urlB, path: '/' },
      });
    });

    afterEach(async () => {
      for (const s of socketsB) s.destroy();
      socketsB.clear();
      await new Promise<void>((r) => tsB.server.close(() => r()));
    });

    it('MAIN REGRESSION: remote dynamic action executes on B through the mount', async () => {
      const clientA = createTrpcTransport({ url });

      const result = await clientA.execute('/fed/w', 'bump');
      assert.equal(result, 1, 'B ran its dynamic action and returned the new count');

      // The mutation landed on B — verified via a direct B client.
      const clientB = createTrpcTransport({ url: urlB });
      const onB = await clientB.tree.get('/w');
      assert.ok(onB);
      assert.equal((onB as { n?: number }).n, 1);
      assert.ok(onB.$rev && onB.$rev >= 2, 'commit happened on B ($rev bumped there)');
    });

    it('dynamic type is NOT resolvable in A itself (delegation is the only path)', async () => {
      // Same dynamic type, but the node sits in A's own tree, outside the
      // mount — A's executor looks in A's /sys/types and finds nothing.
      const clientA = createTrpcTransport({ url });
      await clientA.tree.set(createNode('/local-w', 'fedtest.widget', { n: 0 }));

      await assert.rejects(
        () => clientA.execute('/local-w', 'bump'),
        (e: { message?: string }) => /No action "bump"/.test(e?.message ?? ''),
      );
    });

    it('path outside the mount executes locally on A (fall-through e2e)', async () => {
      const clientA = createTrpcTransport({ url });
      await clientA.tree.set(createNode('/c', 'counter', { count: 0 }));

      await clientA.execute('/c', 'increment');

      const node = await clientA.tree.get('/c');
      assert.equal((node as { count?: number }).count, 1);
    });

    it('opId replay through the wire: delegated action runs once', async () => {
      // opId dedupe is keyed per-user — a cookie-less node client gets a fresh
      // anon principal per request, so replay needs a stable identity (bearer).
      const reg = createTrpcTransport({ url });
      const r = await reg.trpc.register.mutate({ userId: 'fedu', password: 'pw12345' });
      assert.ok(r.token, 'first registered user is active and gets a token');
      const clientA = createTrpcTransport({ url, token: r.token });

      const a = await clientA.execute('/fed/w', 'bump', undefined, { opId: 'fed-op-1' });
      const b = await clientA.execute('/fed/w', 'bump', undefined, { opId: 'fed-op-1' });

      assert.equal(a, 1);
      assert.equal(b, 1, 'replay returned the first outcome');
      const clientB = createTrpcTransport({ url: urlB });
      assert.equal(((await clientB.tree.get('/w')) as { n?: number }).n, 1, 'B applied exactly once');
    });

    it("A's cache is invalidated after a delegated execute (get sees fresh state)", async () => {
      const clientA = createTrpcTransport({ url });

      const beforeExec = await clientA.tree.get('/fed/w');
      assert.equal((beforeExec as { n?: number }).n, 0);

      await clientA.execute('/fed/w', 'bump');

      const afterExec = await clientA.tree.get('/fed/w');
      assert.equal((afterExec as { n?: number }).n, 1, 'no stale cached copy on A');
    });

    it('client tree.execute — capability present on the transport tree, sugar matches', async () => {
      const clientA = createTrpcTransport({ url });
      assert.ok(clientA.tree.execute, 'transport tree carries the capability');

      const result = await clientA.tree.execute('/fed/w', 'bump');
      assert.equal(result, 1);
    });

    it('createPipeline execHooks reach the wire path: intent/settled fire around delegation, intent failure ABORTS (core-pa3m)', async () => {
      // Own A-server so the pipeline carries recorder hooks end-to-end
      // (createPipeline → WireDeps.exec → per-request withExecute).
      const events: string[] = [];
      let failIntent = false;
      const bootstrap = createMemoryTree();
      await bootstrap.set({
        ...createNode('/', 'root'),
        $acl: [{ g: 'public', p: R | W | S }, { g: 'system', p: R | W | A | S }],
      });
      const pipeline = createPipeline(bootstrap, undefined, undefined, () => ({
        onDelegating: (info) => {
          events.push(`intent:${info.path}:${info.action}:${info.userId ?? 'anon'}`);
          if (failIntent) throw new Error('journal down');
        },
        onDelegatedSettled: (info) => { events.push(`settled:${info.ok}`); },
      }));
      const server = createHttpServer(pipeline);
      const hookSockets = new Set<Socket>();
      server.on('connection', (s: Socket) => {
        hookSockets.add(s);
        s.on('close', () => hookSockets.delete(s));
      });
      const port = await listen(server);
      const clientH = createTrpcTransport({ url: `http://127.0.0.1:${port}` });

      try {
        await clientH.tree.set({
          $path: '/fed',
          $type: 'dir',
          '#mount': { $type: 't.mount.tree.trpc', url: urlB, path: '/' },
        });

        assert.equal(await clientH.execute('/fed/w', 'bump'), 1);
        assert.equal(events.length, 2);
        assert.match(events[0], /^intent:\/fed\/w:bump:/);
        assert.equal(events[1], 'settled:true');

        failIntent = true;
        await assert.rejects(() => clientH.execute('/fed/w', 'bump'));
        assert.match(events[2], /^intent:\/fed\/w:bump:/, 'intent attempted');
        assert.equal(events.length, 3, 'no settled row — remote never called (fail closed)');
        const clientB = createTrpcTransport({ url: urlB });
        assert.equal(((await clientB.tree.get('/w')) as { n?: number }).n, 1, 'B still at 1 — aborted before the remote call');
      } finally {
        for (const s of hookSockets) s.destroy();
        await new Promise<void>((r) => server.close(() => r()));
      }
    });
  });
});
