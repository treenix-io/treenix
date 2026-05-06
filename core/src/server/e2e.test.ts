// End-to-end tests — real HTTP server + tRPC client over the wire.
// Tests transport serialization, auth headers, subscriptions, patch streaming,
// ACL security (no leaked data), and action return values.

import { registerType } from '#comp';
import { createNode, R, register, S, W } from '#core';
import { createMemoryTree } from '#tree';
import assert from 'node:assert/strict';
import type { Socket } from 'node:net';
import './mount-adapters';
import { afterEach, before, beforeEach, describe, it } from 'node:test';
import { createClient } from './client';
import { createTreenixServer, type TreenixServer } from './server';
import { _resetRateLimits } from './rate-limit';
import { type NodeEvent } from './sub';

// ── Test components ──

class OrderStatus {
  status = 'new';
  cook() { this.status = 'kitchen'; }
  deliver() { this.status = 'delivered'; }
}

class Returner {
  getObject() { return { x: 1, nested: { y: 'hello' } }; }
  getArray() { return [1, 'two', { three: 3 }]; }
  getNull() { return null; }
  getNumber() { return 42; }
}

class Streamer {
  async *count(data: { n: number }) {
    for (let i = 1; i <= data.n; i++) yield { i, total: data.n };
  }
  async *objects() {
    yield { type: 'start' };
    yield { items: [1, 2, 3] };
    yield { type: 'end', summary: 'done' };
  }
}

class Secret {
  publicField = 'visible';
  secretField = 'hidden';
}

class Priority {
  level = 'low';
  escalate() { this.level = 'high'; }
  deescalate() { this.level = 'low'; }
}

// ── Helpers ──

type DataEvent = Exclude<NodeEvent, { type: 'reconnect' }>;

function listen(server: import('node:http').Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve(addr.port);
    });
  });
}

// Collect subscription events with timeout.
// Uses `any` for onData param to avoid mismatch between our NodeEvent and tRPC's inferred type.
function collectEvents<T>(
  subscribe: (callbacks: { onData: (d: any) => void; onComplete: () => void; onError: (e: unknown) => void }) => { unsubscribe: () => void },
  opts: { count?: number; timeoutMs?: number; onReady?: () => void } = {},
): Promise<T[]> {
  const { count = Infinity, timeoutMs = 3000 } = opts;
  return new Promise((resolve) => {
    const items: T[] = [];
    let timer: ReturnType<typeof setTimeout>;
    const sub = subscribe({
      onData(d: NodeEvent) {
        if (d.type === 'reconnect') { opts.onReady?.(); return; }
        items.push(d as T);
        if (items.length >= count) { clearTimeout(timer); sub.unsubscribe(); resolve(items); }
      },
      onComplete() { clearTimeout(timer); resolve(items); },
      onError() { clearTimeout(timer); resolve(items); },
    });
    timer = setTimeout(() => { sub.unsubscribe(); resolve(items); }, timeoutMs);
  });
}

/** Subscribe to SSE events, returning both the events promise and a ready signal.
 *  `ready` resolves on first `reconnect` event (SSE connected) or when collectEvents settles. */
function subscribeEvents<T = DataEvent>(
  client: ReturnType<typeof createClient>,
  opts: { count?: number; timeoutMs?: number } = {},
) {
  let resolveReady!: () => void;
  const ready = new Promise<void>(r => { resolveReady = r; });
  const events = collectEvents<T>(
    (cbs) => client.events.subscribe(undefined, cbs),
    { ...opts, onReady: () => resolveReady() },
  );
  // If collectEvents settles before reconnect arrives, unblock ready too
  events.then(() => resolveReady());
  return { events, ready };
}

/** Activate a pending user and return a login token (for 2nd+ registrations in tests) */
async function activateAndLogin(
  tree: TreenixServer['tree'],
  pub: ReturnType<typeof createClient>,
  userId: string,
  password: string,
): Promise<string> {
  const userPath = `/auth/users/${userId}`;
  const node = await tree.get(userPath);
  if (!node) throw new Error(`User ${userId} not found`);
  if (node.status !== 'active') {
    node.status = 'active';
    await tree.set(node);
  }
  const login = await pub.login.mutate({ userId, password });
  if (!login.token) throw new Error(`Login failed for ${userId}`);
  return login.token;
}

describe('e2e: tRPC over HTTP', () => {
  let ts: TreenixServer;
  let url: string;
  const sockets = new Set<Socket>();

  before(async () => {
    registerType('order.status', OrderStatus);
    register('order.status', 'schema', () => ({
      $id: 'order.status', title: 'OrderStatus', type: 'object' as const,
      properties: { status: { type: 'string' } },
      methods: { cook: { arguments: [] }, deliver: { arguments: [] } },
    }));

    registerType('returner', Returner);
    register('returner', 'schema', () => ({
      $id: 'returner', title: 'Returner', type: 'object' as const, properties: {},
      methods: { getObject: { arguments: [] }, getArray: { arguments: [] }, getNull: { arguments: [] }, getNumber: { arguments: [] } },
    }));

    registerType('streamer', Streamer);
    register('streamer', 'schema', () => ({
      $id: 'streamer', title: 'Streamer', type: 'object' as const, properties: {},
      methods: {
        count: { arguments: [{ name: 'data', type: 'object', properties: { n: { type: 'number' } }, required: ['n'] }], streaming: true },
        objects: { arguments: [], streaming: true },
      },
    }));

    registerType('secret', Secret);
    registerType('task.priority', Priority);
    register('task.priority', 'schema', () => ({
      $id: 'task.priority', title: 'Priority', type: 'object' as const,
      properties: { level: { type: 'string' } },
      methods: { escalate: { arguments: [] }, deescalate: { arguments: [] } },
    }));

    register('test.task', 'schema', () => ({ type: 'object' as const, title: 'Test Task', properties: {} }));
  });

  beforeEach(async () => {
    _resetRateLimits();
    const bootstrap = createMemoryTree();
    await bootstrap.set({
      ...createNode('/', 'root'),
      $acl: [{ g: 'public', p: R | W | S }, { g: 'authenticated', p: R | W | S }],
    });

    ts = createTreenixServer(bootstrap);
    ts.server.on('connection', (socket: Socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    const port = await listen(ts.server);
    url = `http://127.0.0.1:${port}/`;
  });

  afterEach(async () => {
    for (const s of sockets) s.destroy();
    sockets.clear();
    await new Promise<void>((resolve) => ts.server.close(() => resolve()));
  });

  // ── CRUD over HTTP ──

  describe('CRUD', () => {
    it('set + get roundtrip', async () => {
      const client = createClient(url);
      await client.set.mutate({ node: { $path: '/a', $type: 'doc', title: 'Hello' } });
      const node = await client.get.query({ path: '/a' });
      assert.equal(node?.$type, 'doc');
      assert.equal((node as any).title, 'Hello');
    });

    it('getChildren with pagination', async () => {
      const client = createClient(url);
      await client.set.mutate({ node: { $path: '/p', $type: 'folder' } });
      for (let i = 0; i < 5; i++)
        await client.set.mutate({ node: { $path: `/p/${i}`, $type: 'doc' } });

      const page = await client.getChildren.query({ path: '/p', limit: 2 });
      assert.equal(page.items.length, 2);
      assert.equal(page.total, 5);
    });

    it('remove works', async () => {
      const client = createClient(url);
      await client.set.mutate({ node: { $path: '/del', $type: 'doc' } });
      assert.ok(await client.get.query({ path: '/del' }));
      await client.remove.mutate({ path: '/del' });
      assert.equal(await client.get.query({ path: '/del' }), undefined);
    });
  });

  // ── Auth over HTTP ──

  describe('auth', () => {
    it('register → login → me (full auth flow)', async () => {
      const pub = createClient(url);
      const reg = await pub.register.mutate({ userId: 'bob', password: 'secret' });
      assert.ok(reg.token);

      const login = await pub.login.mutate({ userId: 'bob', password: 'secret' });
      assert.ok(login.token);

      const authed = createClient(url, login.token);
      const me = await authed.me.query();
      assert.equal(me?.userId, 'bob');
    });

    it('wrong password returns UNAUTHORIZED', async () => {
      const client = createClient(url);
      await client.register.mutate({ userId: 'u1', password: 'correct' });
      await assert.rejects(
        () => client.login.mutate({ userId: 'u1', password: 'wrong' }),
        (e: any) => e.data?.httpStatus === 401 || e.data?.code === 'UNAUTHORIZED',
      );
    });

    it('me returns null for unauthenticated', async () => {
      const client = createClient(url);
      const me = await client.me.query();
      assert.equal(me, null);
    });

  });

  // ── Error codes over HTTP ──

  describe('error codes', () => {
    it('NOT_FOUND serialized correctly', async () => {
      const client = createClient(url);
      await assert.rejects(
        () => client.execute.mutate({ path: '/nope', action: 'x' }),
        (e: any) => e.data?.code === 'NOT_FOUND',
      );
    });

    it('BAD_REQUEST for unknown action', async () => {
      const client = createClient(url);
      await client.set.mutate({ node: { $path: '/n', $type: 'page', ret: { $type: 'returner' } } });
      await assert.rejects(
        () => client.execute.mutate({ path: '/n', key: 'ret', action: 'nonexistent' }),
        (e: any) => e.data?.code === 'BAD_REQUEST',
      );
    });

    it('CONFLICT on stale $rev', async () => {
      const client = createClient(url);
      await client.set.mutate({ node: { $path: '/rev', $type: 'doc', x: { $type: 'returner' } } });
      await assert.rejects(
        () => client.setComponent.mutate({ path: '/rev', name: 'x', data: { $type: 'returner' }, rev: 99 }),
        (e: any) => e.data?.code === 'CONFLICT',
      );
    });
  });

  // ── Action return values ──

  describe('action return values', () => {
    it('execute returns object', async () => {
      const client = createClient(url);
      await client.set.mutate({ node: { $path: '/r', $type: 'page', ret: { $type: 'returner' } } });
      const result = await client.execute.mutate({ path: '/r', key: 'ret', action: 'getObject' });
      assert.deepEqual(result, { x: 1, nested: { y: 'hello' } });
    });

    it('execute returns array', async () => {
      const client = createClient(url);
      await client.set.mutate({ node: { $path: '/r2', $type: 'page', ret: { $type: 'returner' } } });
      const result = await client.execute.mutate({ path: '/r2', key: 'ret', action: 'getArray' });
      assert.deepEqual(result, [1, 'two', { three: 3 }]);
    });

    it('execute returns null', async () => {
      const client = createClient(url);
      await client.set.mutate({ node: { $path: '/r3', $type: 'page', ret: { $type: 'returner' } } });
      const result = await client.execute.mutate({ path: '/r3', key: 'ret', action: 'getNull' });
      assert.equal(result, null);
    });

    it('execute returns number', async () => {
      const client = createClient(url);
      await client.set.mutate({ node: { $path: '/r4', $type: 'page', ret: { $type: 'returner' } } });
      const result = await client.execute.mutate({ path: '/r4', key: 'ret', action: 'getNumber' });
      assert.equal(result, 42);
    });
  });

  // ── Subscriptions ──

  describe('subscriptions', () => {
    it('events stream delivers set/patch/remove', async () => {
      const pub = createClient(url);
      const reg = await pub.register.mutate({ userId: 'watcher', password: 'pass' });
      const client = createClient(url, reg.token);

      await pub.set.mutate({ node: { $path: '/w', $type: 'page', meta: { $type: 'order.status', status: 'new' } } });

      // Start subscription first (triggers watcher.connect on server)
      const events = collectEvents<DataEvent>(
        (cbs) => client.events.subscribe(undefined, cbs),
        { count: 2, timeoutMs: 3000 },
      );
      await new Promise(r => setTimeout(r, 300));

      // Now register watches
      await client.get.query({ path: '/w', watch: true });

      // Trigger events
      await pub.execute.mutate({ path: '/w', key: 'meta', action: 'cook' });
      await pub.remove.mutate({ path: '/w' });

      const received = await events;
      assert.ok(received.length >= 1, `Expected >=1 events, got ${received.length}`);
      assert.ok(received.some(e => e.path === '/w'));
    });

    it('patch events include Immer patches', async () => {
      const pub = createClient(url);
      const reg = await pub.register.mutate({ userId: 'patcher', password: 'pass' });
      const client = createClient(url, reg.token);

      await pub.set.mutate({ node: { $path: '/pe', $type: 'page', meta: { $type: 'order.status', status: 'new' } } });

      const events = collectEvents<DataEvent>(
        (cbs) => client.events.subscribe(undefined, cbs),
        { count: 1, timeoutMs: 3000 },
      );
      await new Promise(r => setTimeout(r, 300));

      await client.get.query({ path: '/pe', watch: true });
      await pub.execute.mutate({ path: '/pe', key: 'meta', action: 'cook' });
      const received = await events;

      const patchEvent = received.find(e => e.path === '/pe' && e.type === 'patch');
      assert.ok(patchEvent, 'Should receive patch event');
      assert.ok('patches' in patchEvent! && Array.isArray(patchEvent.patches));
      assert.ok(patchEvent.patches.length > 0, 'Patches should be non-empty');
    });

    it('streamAction streams generator results', async () => {
      const pub = createClient(url);
      const reg = await pub.register.mutate({ userId: 'streamer', password: 'pass' });
      const client = createClient(url, reg.token);

      await pub.set.mutate({ node: { $path: '/s', $type: 'page', str: { $type: 'streamer' } } });

      const items = await collectEvents<unknown>(
        (cbs) => client.streamAction.subscribe({ path: '/s', key: 'str', action: 'count', data: { n: 3 } }, cbs),
        { count: 3, timeoutMs: 3000 },
      );

      assert.equal(items.length, 3);
      assert.deepEqual(items, [
        { i: 1, total: 3 },
        { i: 2, total: 3 },
        { i: 3, total: 3 },
      ]);
    });

    it('streamAction streams objects', async () => {
      const pub = createClient(url);
      const reg = await pub.register.mutate({ userId: 'streamer2', password: 'pass' });
      const client = createClient(url, reg.token);

      await pub.set.mutate({ node: { $path: '/s2', $type: 'page', str: { $type: 'streamer' } } });

      const items = await collectEvents<unknown>(
        (cbs) => client.streamAction.subscribe({ path: '/s2', key: 'str', action: 'objects' }, cbs),
        { count: 3, timeoutMs: 3000 },
      );

      assert.equal(items.length, 3);
      assert.deepEqual(items[0], { type: 'start' });
      assert.deepEqual(items[1], { items: [1, 2, 3] });
      assert.deepEqual(items[2], { type: 'end', summary: 'done' });
    });
  });

  // ── ACL security ──

  describe('ACL security', () => {
    it('unauthenticated cannot read private nodes', async () => {
      const pub = createClient(url);
      await ts.tree.set({
        ...createNode('/secret', 'folder'),
        $acl: [{ g: 'admins', p: R | W }, { g: 'public', p: 0 }],
      });
      await ts.tree.set(createNode('/secret/data', 'doc'));

      await assert.rejects(
        pub.get.query({ path: '/secret/data' }),
        (e: any) => e.data?.code === 'FORBIDDEN',
        'Public should be told FORBIDDEN, not silent undefined',
      );
    });

    it('unauthenticated cannot write to private paths', async () => {
      const pub = createClient(url);
      await ts.tree.set({
        ...createNode('/private', 'folder'),
        $acl: [{ g: 'admins', p: R | W }, { g: 'public', p: 0 }],
      });

      await assert.rejects(
        () => pub.set.mutate({ node: { $path: '/private/hack', $type: 'doc' } }),
        (e: any) => e.data?.code === 'FORBIDDEN',
      );
    });

    it('getChildren does not leak private children', async () => {
      const pub = createClient(url);
      await ts.tree.set(createNode('/mix', 'folder'));
      await ts.tree.set(createNode('/mix/public', 'doc'));
      await ts.tree.set({
        ...createNode('/mix/private', 'doc'),
        $acl: [{ g: 'admins', p: R | W }, { g: 'public', p: 0 }],
      });

      const result = await pub.getChildren.query({ path: '/mix' });
      const paths = result.items.map(n => n.$path);
      assert.ok(paths.includes('/mix/public'), 'Public child should be visible');
      assert.ok(!paths.includes('/mix/private'), 'Private child should be hidden');
    });

    it('events do not leak to unauthorized subscribers', async () => {
      const pub = createClient(url);
      await pub.register.mutate({ userId: 'alice-sec', password: 'pass' });
      await pub.register.mutate({ userId: 'bob-sec', password: 'pass' });
      const bobToken = await activateAndLogin(ts.tree, pub, 'bob-sec', 'pass');

      // Make alice an admin
      await ts.tree.set({
        ...createNode('/auth/groups/admins', 'group'),
        members: { $type: 'members', list: ['alice-sec'] },
      });

      // Create a private node only admins can see
      await ts.tree.set({
        ...createNode('/classified', 'doc'),
        $acl: [{ g: 'admins', p: R | W | S }, { g: 'public', p: 0 }],
      });

      const bobClient = createClient(url, bobToken);

      // Bob subscribes first
      const bobEvents = collectEvents<DataEvent>(
        (cbs) => bobClient.events.subscribe(undefined, cbs),
        { timeoutMs: 1500 },
      );
      await new Promise(r => setTimeout(r, 300));

      // Bob watches root (public)
      await bobClient.get.query({ path: '/', watch: true });

      // Mutate classified — bob should NOT see this
      await ts.tree.set({ ...createNode('/classified', 'doc'), updated: true });
      await new Promise(r => setTimeout(r, 200));

      const received = await bobEvents;
      const leaked = received.filter(e => e.path === '/classified');
      assert.equal(leaked.length, 0, 'Bob should NOT receive events for /classified');
    });

    it('$acl and $owner stripped for non-admin users', async () => {
      const pub = createClient(url);
      const reg = await pub.register.mutate({ userId: 'viewer', password: 'pass' });
      const viewer = createClient(url, reg.token);

      await ts.tree.set({
        ...createNode('/owned', 'doc'),
        $owner: 'someadmin',
        $acl: [{ g: 'authenticated', p: R | S }],
      });

      const node = await viewer.get.query({ path: '/owned' });
      assert.ok(node, 'Node should be readable');
      assert.equal((node as any).$acl, undefined, '$acl should be stripped');
      assert.equal((node as any).$owner, undefined, '$owner should be stripped');
    });
  });

  // ── CDC over HTTP ──

  describe('CDC Matrix over HTTP', () => {
    it('query mount + action transition works over wire', async () => {
      const client = createClient(url);

      await client.set.mutate({ node: { $path: '/orders', $type: 'folder' } });
      await client.set.mutate({ node: { $path: '/orders/data', $type: 'folder' } });
      await client.set.mutate({ node: {
        $path: '/orders/data/1', $type: 'page',
        status: { $type: 'order.status', status: 'new' },
      } });
      await client.set.mutate({ node: {
        $path: '/orders/new', $type: 'folder',
        mount: { $type: 't.mount.query', source: '/orders/data', match: { 'status.status': 'new' } },
      } });
      await client.set.mutate({ node: {
        $path: '/orders/kitchen', $type: 'folder',
        mount: { $type: 't.mount.query', source: '/orders/data', match: { 'status.status': 'kitchen' } },
      } });

      let newOrders = await client.getChildren.query({ path: '/orders/new' });
      assert.equal(newOrders.items.length, 1);

      await client.execute.mutate({ path: '/orders/data/1', key: 'status', action: 'cook' });

      newOrders = await client.getChildren.query({ path: '/orders/new' });
      const kitchen = await client.getChildren.query({ path: '/orders/kitchen' });
      assert.equal(newOrders.items.length, 0, 'Left /orders/new');
      assert.equal(kitchen.items.length, 1, 'Entered /orders/kitchen');
    });
  });

  // ── Helper: set up a query mount ──

  async function setupQueryMount(
    client: ReturnType<typeof createClient>,
    vpPath: string,
    sourcePath: string,
    match: Record<string, unknown>,
  ) {
    await client.set.mutate({ node: {
      $path: vpPath, $type: 'folder',
      mount: { $type: 't.mount.query', source: sourcePath, match },
    } });
  }

  // ── CDC Matrix live events ──

  describe('CDC Matrix live events', () => {
    it('action transition emits addVps/rmVps in live event', async () => {
      const pub = createClient(url);
      const reg = await pub.register.mutate({ userId: 'cdc-live1', password: 'pass' });
      const client = createClient(url, reg.token);

      // Data
      await pub.set.mutate({ node: { $path: '/d1', $type: 'folder' } });
      await pub.set.mutate({ node: {
        $path: '/d1/o1', $type: 'page',
        status: { $type: 'order.status', status: 'new' },
      } });

      // Query mounts
      await pub.set.mutate({ node: { $path: '/qm1', $type: 'folder' } });
      await setupQueryMount(pub, '/qm1/new', '/d1', { 'status.status': 'new' });
      await setupQueryMount(pub, '/qm1/kitchen', '/d1', { 'status.status': 'kitchen' });

      // Subscribe + register watches
      const events = collectEvents<DataEvent>(
        (cbs) => client.events.subscribe(undefined, cbs),
        { count: 1, timeoutMs: 3000 },
      );
      await new Promise(r => setTimeout(r, 300));

      await client.getChildren.query({ path: '/qm1/new', watchNew: true, watch: true });
      await client.getChildren.query({ path: '/qm1/kitchen', watchNew: true, watch: true });

      // Trigger transition
      await pub.execute.mutate({ path: '/d1/o1', key: 'status', action: 'cook' });

      const received = await events;
      assert.ok(received.length >= 1, `Expected >=1 events, got ${received.length}`);
      const ev = received.find(e => e.path === '/d1/o1')!;
      assert.ok(ev, 'Should receive event for /d1/o1');
      assert.ok((ev as any).rmVps?.includes('/qm1/new'), 'rmVps should contain /qm1/new');
      assert.ok((ev as any).addVps?.includes('/qm1/kitchen'), 'addVps should contain /qm1/kitchen');
    });

    it('new node creation triggers addVps event', async () => {
      const pub = createClient(url);
      const reg = await pub.register.mutate({ userId: 'cdc-live2', password: 'pass' });
      const client = createClient(url, reg.token);

      await pub.set.mutate({ node: { $path: '/items2', $type: 'folder' } });
      await pub.set.mutate({ node: { $path: '/qm2', $type: 'folder' } });
      await setupQueryMount(pub, '/qm2/hot', '/items2', { 'pri.level': 'high' });

      const events = collectEvents<DataEvent>(
        (cbs) => client.events.subscribe(undefined, cbs),
        { count: 1, timeoutMs: 3000 },
      );
      await new Promise(r => setTimeout(r, 300));

      await client.getChildren.query({ path: '/qm2/hot', watchNew: true, watch: true });

      // Create matching node
      await pub.set.mutate({ node: {
        $path: '/items2/t1', $type: 'task',
        pri: { $type: 'task.priority', level: 'high' },
      } });

      const received = await events;
      assert.ok(received.length >= 1, `Expected >=1 events, got ${received.length}`);
      const ev = received.find(e => e.path === '/items2/t1')!;
      assert.ok(ev, 'Should receive event for /items2/t1');
      assert.ok((ev as any).addVps?.includes('/qm2/hot'), 'addVps should contain /qm2/hot');
    });

    it('node deletion triggers rmVps event', async () => {
      const pub = createClient(url);
      const reg = await pub.register.mutate({ userId: 'cdc-live3', password: 'pass' });
      const client = createClient(url, reg.token);

      await pub.set.mutate({ node: { $path: '/items3', $type: 'folder' } });
      await pub.set.mutate({ node: {
        $path: '/items3/t1', $type: 'task',
        pri: { $type: 'task.priority', level: 'high' },
      } });
      await pub.set.mutate({ node: { $path: '/qm3', $type: 'folder' } });
      await setupQueryMount(pub, '/qm3/hot', '/items3', { 'pri.level': 'high' });

      const events = collectEvents<DataEvent>(
        (cbs) => client.events.subscribe(undefined, cbs),
        { count: 1, timeoutMs: 3000 },
      );
      await new Promise(r => setTimeout(r, 300));

      await client.getChildren.query({ path: '/qm3/hot', watchNew: true, watch: true });

      // Delete the matching node
      await pub.remove.mutate({ path: '/items3/t1' });

      const received = await events;
      assert.ok(received.length >= 1, `Expected >=1 events, got ${received.length}`);
      const ev = received.find(e => e.path === '/items3/t1')!;
      assert.ok(ev, 'Should receive remove event for /items3/t1');
      assert.equal(ev.type, 'remove');
      assert.ok((ev as any).rmVps?.includes('/qm3/hot'), 'rmVps should contain /qm3/hot');
    });

    it('non-matching mutation produces no VP event', async () => {
      const pub = createClient(url);
      const reg = await pub.register.mutate({ userId: 'cdc-live4', password: 'pass' });
      const client = createClient(url, reg.token);

      await pub.set.mutate({ node: { $path: '/items4', $type: 'folder' } });
      await pub.set.mutate({ node: {
        $path: '/items4/t1', $type: 'task',
        pri: { $type: 'task.priority', level: 'low' },
      } });
      await pub.set.mutate({ node: { $path: '/qm4', $type: 'folder' } });
      await setupQueryMount(pub, '/qm4/hot', '/items4', { 'pri.level': 'high' });

      const events = collectEvents<DataEvent>(
        (cbs) => client.events.subscribe(undefined, cbs),
        { timeoutMs: 800 },
      );
      await new Promise(r => setTimeout(r, 300));

      await client.getChildren.query({ path: '/qm4/hot', watchNew: true, watch: true });

      // Update non-matching node (still low priority)
      await pub.set.mutate({ node: {
        $path: '/items4/t1', $type: 'task',
        pri: { $type: 'task.priority', level: 'low' },
        extra: 'data',
      } });

      const received = await events;
      const vpEvents = received.filter(e => e.path === '/items4/t1');
      assert.equal(vpEvents.length, 0, 'Should receive no events for non-matching mutation');
    });

    it('in-vp mutation (membership unchanged) notifies vp watcher', async () => {
      // Regression: when a field NOT in the query predicate changes, the node stays
      // in the same virtual parent. Previously cdcEval emitted empty addVps/rmVps and
      // watch.ts routed nothing to vp watchers — the card went stale. Fix: stayVps.
      const pub = createClient(url);
      const reg = await pub.register.mutate({ userId: 'cdc-live5', password: 'pass' });
      const client = createClient(url, reg.token);

      await pub.set.mutate({ node: { $path: '/items5', $type: 'folder' } });
      await pub.set.mutate({ node: {
        $path: '/items5/t1', $type: 'task',
        pri: { $type: 'task.priority', level: 'high' },
        assignee: 'alice',
      } });
      await pub.set.mutate({ node: { $path: '/qm5', $type: 'folder' } });
      await setupQueryMount(pub, '/qm5/hot', '/items5', { 'pri.level': 'high' });

      const events = collectEvents<DataEvent>(
        (cbs) => client.events.subscribe(undefined, cbs),
        { count: 1, timeoutMs: 3000 },
      );
      await new Promise(r => setTimeout(r, 300));

      // Subscribe ONLY to /qm5/hot — NOT to /items5. The only way this client
      // can learn about the mutation is through VP routing.
      await client.getChildren.query({ path: '/qm5/hot', watchNew: true, watch: true });

      // Change a field that is NOT part of the query predicate.
      // pri.level stays 'high' → membership in /qm5/hot unchanged → stayVps.
      await pub.set.mutate({ node: {
        $path: '/items5/t1', $type: 'task',
        pri: { $type: 'task.priority', level: 'high' },
        assignee: 'bob',
      } });

      const received = await events;
      const ev = received.find(e => e.path === '/items5/t1');
      assert.ok(ev, 'VP watcher must receive event for in-vp mutation');
      assert.ok((ev as any).stayVps?.includes('/qm5/hot'), 'stayVps should contain /qm5/hot');
      assert.ok(!(ev as any).addVps, 'addVps should be absent (no membership delta)');
      assert.ok(!(ev as any).rmVps, 'rmVps should be absent (no membership delta)');
    });
  });

  // ── Query mount virtual API ──

  describe('query mount virtual API', () => {
    it('getChildren through query mount returns only matching nodes', async () => {
      const client = createClient(url);

      await client.set.mutate({ node: { $path: '/src5', $type: 'folder' } });
      await client.set.mutate({ node: {
        $path: '/src5/a', $type: 'page',
        status: { $type: 'order.status', status: 'new' },
      } });
      await client.set.mutate({ node: {
        $path: '/src5/b', $type: 'page',
        status: { $type: 'order.status', status: 'kitchen' },
      } });
      await client.set.mutate({ node: {
        $path: '/src5/c', $type: 'page',
        status: { $type: 'order.status', status: 'new' },
      } });

      await client.set.mutate({ node: { $path: '/vm5', $type: 'folder' } });
      await setupQueryMount(client, '/vm5/new', '/src5', { 'status.status': 'new' });

      const result = await client.getChildren.query({ path: '/vm5/new' });
      assert.equal(result.items.length, 2, 'Only 2 of 3 match status=new');

      // All items have real paths from /src5/
      for (const item of result.items) {
        assert.ok(item.$path.startsWith('/src5/'), `Real path expected, got ${item.$path}`);
        assert.equal((item as any).status.status, 'new');
      }
    });

    it('execute action on node discovered via query mount', async () => {
      const client = createClient(url);

      await client.set.mutate({ node: { $path: '/src6', $type: 'folder' } });
      await client.set.mutate({ node: {
        $path: '/src6/o1', $type: 'page',
        status: { $type: 'order.status', status: 'new' },
      } });

      await client.set.mutate({ node: { $path: '/vm6', $type: 'folder' } });
      await setupQueryMount(client, '/vm6/new', '/src6', { 'status.status': 'new' });
      await setupQueryMount(client, '/vm6/kitchen', '/src6', { 'status.status': 'kitchen' });

      // Discover via query mount
      const newOrders = await client.getChildren.query({ path: '/vm6/new' });
      assert.equal(newOrders.items.length, 1);
      const orderPath = newOrders.items[0].$path;

      // Execute action on discovered path
      await client.execute.mutate({ path: orderPath, key: 'status', action: 'cook' });

      // Verify transition
      const afterNew = await client.getChildren.query({ path: '/vm6/new' });
      const afterKitchen = await client.getChildren.query({ path: '/vm6/kitchen' });
      assert.equal(afterNew.items.length, 0, 'Node left /vm6/new');
      assert.equal(afterKitchen.items.length, 1, 'Node entered /vm6/kitchen');
      assert.equal(afterKitchen.items[0].$path, orderPath);
    });

    it('execute works on query mount children', async () => {
      const client = createClient(url);

      await client.set.mutate({ node: { $path: '/src7', $type: 'folder' } });
      await client.set.mutate({ node: {
        $path: '/src7/n1', $type: 'returner',
        status: { $type: 'order.status', status: 'new' },
      } });

      await client.set.mutate({ node: { $path: '/vm7', $type: 'folder' } });
      await setupQueryMount(client, '/vm7/new', '/src7', { 'status.status': 'new' });

      // Discover via mount
      const items = await client.getChildren.query({ path: '/vm7/new' });
      assert.equal(items.items.length, 1);

      // execute on the real path
      const result = await client.execute.mutate({ path: items.items[0].$path, action: 'getObject' });
      assert.deepEqual(result, { x: 1, nested: { y: 'hello' } });
    });
  });

  // ── Order lifecycle with live watchers ──

  describe('order lifecycle with live watchers', () => {
    it('full lifecycle: new → kitchen → delivered with live events', async () => {
      const pub = createClient(url);
      const reg = await pub.register.mutate({ userId: 'lifecycle1', password: 'pass' });
      const client = createClient(url, reg.token);

      // Data
      await pub.set.mutate({ node: { $path: '/lc', $type: 'folder' } });
      await pub.set.mutate({ node: { $path: '/lc/data', $type: 'folder' } });
      await pub.set.mutate({ node: {
        $path: '/lc/data/o1', $type: 'page',
        status: { $type: 'order.status', status: 'new' },
      } });

      // 3 query mounts
      await setupQueryMount(pub, '/lc/new', '/lc/data', { 'status.status': 'new' });
      await setupQueryMount(pub, '/lc/kitchen', '/lc/data', { 'status.status': 'kitchen' });
      await setupQueryMount(pub, '/lc/delivered', '/lc/data', { 'status.status': 'delivered' });

      // Subscribe
      const events = collectEvents<DataEvent>(
        (cbs) => client.events.subscribe(undefined, cbs),
        { count: 2, timeoutMs: 5000 },
      );
      await new Promise(r => setTimeout(r, 300));

      // Watch all 3 VPs
      await client.getChildren.query({ path: '/lc/new', watchNew: true, watch: true });
      await client.getChildren.query({ path: '/lc/kitchen', watchNew: true, watch: true });
      await client.getChildren.query({ path: '/lc/delivered', watchNew: true, watch: true });

      // Transition 1: new → kitchen
      await pub.execute.mutate({ path: '/lc/data/o1', key: 'status', action: 'cook' });
      // Small delay so events arrive separately
      await new Promise(r => setTimeout(r, 100));

      // Transition 2: kitchen → delivered
      await pub.execute.mutate({ path: '/lc/data/o1', key: 'status', action: 'deliver' });

      const received = await events;
      assert.ok(received.length >= 2, `Expected >=2 events, got ${received.length}`);

      // First event: new→kitchen
      const ev1 = received[0];
      assert.equal(ev1.path, '/lc/data/o1');
      assert.ok((ev1 as any).rmVps?.includes('/lc/new'), 'ev1 rmVps should have /lc/new');
      assert.ok((ev1 as any).addVps?.includes('/lc/kitchen'), 'ev1 addVps should have /lc/kitchen');

      // Second event: kitchen→delivered
      const ev2 = received[1];
      assert.equal(ev2.path, '/lc/data/o1');
      assert.ok((ev2 as any).rmVps?.includes('/lc/kitchen'), 'ev2 rmVps should have /lc/kitchen');
      assert.ok((ev2 as any).addVps?.includes('/lc/delivered'), 'ev2 addVps should have /lc/delivered');

      // Final state check
      const finalNew = await pub.getChildren.query({ path: '/lc/new' });
      const finalKitchen = await pub.getChildren.query({ path: '/lc/kitchen' });
      const finalDelivered = await pub.getChildren.query({ path: '/lc/delivered' });
      assert.equal(finalNew.items.length, 0);
      assert.equal(finalKitchen.items.length, 0);
      assert.equal(finalDelivered.items.length, 1);
    });
  });

  // ── CDC edge cases ──

  describe('CDC edge cases', () => {
    it('node matching two query mounts gets both VPs in event', async () => {
      const pub = createClient(url);
      const reg = await pub.register.mutate({ userId: 'cdc-edge1', password: 'pass' });
      const client = createClient(url, reg.token);

      await pub.set.mutate({ node: { $path: '/multi', $type: 'folder' } });
      await pub.set.mutate({ node: { $path: '/qme', $type: 'folder' } });
      // VP1: matches high priority
      await setupQueryMount(pub, '/qme/high', '/multi', { 'pri.level': 'high' });
      // VP2: matches any node with pri component (level exists)
      await setupQueryMount(pub, '/qme/all', '/multi', { 'pri.level': { $exists: true } });

      const { events, ready } = subscribeEvents(client, { count: 1, timeoutMs: 3000 });
      await ready;

      await client.getChildren.query({ path: '/qme/high', watchNew: true, watch: true });
      await client.getChildren.query({ path: '/qme/all', watchNew: true, watch: true });

      // Create node matching both
      await pub.set.mutate({ node: {
        $path: '/multi/t1', $type: 'task',
        pri: { $type: 'task.priority', level: 'high' },
      } });

      const received = await events;
      assert.ok(received.length >= 1);
      const ev = received.find(e => e.path === '/multi/t1')!;
      assert.ok(ev, 'Should receive event');
      assert.ok((ev as any).addVps?.includes('/qme/high'), 'addVps should contain /qme/high');
      assert.ok((ev as any).addVps?.includes('/qme/all'), 'addVps should contain /qme/all');
    });

    it('autoWatch: VP entry followed by exact-path update', async () => {
      const pub = createClient(url);
      const reg = await pub.register.mutate({ userId: 'cdc-edge2', password: 'pass' });
      const client = createClient(url, reg.token);

      await pub.set.mutate({ node: { $path: '/aw', $type: 'folder' } });
      await pub.set.mutate({ node: { $path: '/qmaw', $type: 'folder' } });
      await setupQueryMount(pub, '/qmaw/hot', '/aw', { 'pri.level': 'high' });

      const { events, ready } = subscribeEvents(client, { count: 2, timeoutMs: 4000 });
      await ready;

      // watchNew + watch = autoWatch enabled
      await client.getChildren.query({ path: '/qmaw/hot', watchNew: true, watch: true });

      // Event 1: create matching node → addVps (autoWatch registers exact-path watch)
      await pub.set.mutate({ node: {
        $path: '/aw/t1', $type: 'task',
        pri: { $type: 'task.priority', level: 'high' },
      } });
      await new Promise(r => setTimeout(r, 200));

      // Event 2: update same node (still matches) → exact-path watch delivers
      await pub.set.mutate({ node: {
        $path: '/aw/t1', $type: 'task',
        pri: { $type: 'task.priority', level: 'high' },
        extra: 'updated',
      } });

      const received = await events;
      assert.equal(received.length, 2, 'Should receive 2 events');

      // First: VP entry
      assert.ok((received[0] as any).addVps?.includes('/qmaw/hot'), 'First event should have addVps');

      // Second: exact-path update (no VP change since still matches)
      assert.equal(received[1].path, '/aw/t1');
    });

    it('two users watching same VP both receive events', async () => {
      const pub = createClient(url);
      const reg1 = await pub.register.mutate({ userId: 'multi-u1', password: 'pass' });
      await pub.register.mutate({ userId: 'multi-u2', password: 'pass' });
      const token2 = await activateAndLogin(ts.tree, pub, 'multi-u2', 'pass');
      const c1 = createClient(url, reg1.token);
      const c2 = createClient(url, token2);

      await pub.set.mutate({ node: { $path: '/mu', $type: 'folder' } });
      await pub.set.mutate({ node: { $path: '/qmu', $type: 'folder' } });
      await setupQueryMount(pub, '/qmu/hot', '/mu', { 'pri.level': 'high' });

      // Both users subscribe
      const sub1 = subscribeEvents(c1, { count: 1, timeoutMs: 5000 });
      const sub2 = subscribeEvents(c2, { count: 1, timeoutMs: 5000 });
      await Promise.all([sub1.ready, sub2.ready]);

      // Both watch the same VP
      await c1.getChildren.query({ path: '/qmu/hot', watchNew: true, watch: true });
      await c2.getChildren.query({ path: '/qmu/hot', watchNew: true, watch: true });

      // Create matching node
      await pub.set.mutate({ node: {
        $path: '/mu/t1', $type: 'task',
        pri: { $type: 'task.priority', level: 'high' },
      } });

      const [r1, r2] = await Promise.all([sub1.events, sub2.events]);
      assert.ok(r1.length >= 1, 'User 1 should receive event');
      assert.ok(r2.length >= 1, 'User 2 should receive event');
      assert.ok((r1[0] as any).addVps?.includes('/qmu/hot'));
      assert.ok((r2[0] as any).addVps?.includes('/qmu/hot'));
    });
  });

  // ── Regular children watch (non-query-mount) ──

  describe('regular children watch', () => {
    it('new child triggers event via prefix watch (agent pattern)', async () => {
      const pub = createClient(url);
      const reg = await pub.register.mutate({ userId: 'child-watcher', password: 'pass' });
      const client = createClient(url, reg.token);

      // Seed parent
      await pub.set.mutate({ node: { $path: '/agent-test', $type: 'config' } });
      await pub.set.mutate({ node: { $path: '/agent-test/tasks', $type: 'dir' } });

      // Start SSE subscription
      const events = collectEvents<DataEvent>(
        (cbs) => client.events.subscribe(undefined, cbs),
        { count: 1, timeoutMs: 3000 },
      );
      await new Promise(r => setTimeout(r, 300));

      // Register prefix watch via getChildren (same as useChildren with watchNew)
      await client.getChildren.query({ path: '/agent-test/tasks', watchNew: true, watch: true });

      // Create new child (simulates action:task creating a task node)
      await pub.set.mutate({ node: {
        $path: '/agent-test/tasks/t-1', $type: 'test.task',
        prompt: 'test task', status: 'pending', createdAt: 12345,
      } });

      const received = await events;
      assert.equal(received.length, 1, 'Should receive exactly 1 event');
      assert.equal(received[0].type, 'set', 'Event type should be "set"');
      assert.equal(received[0].path, '/agent-test/tasks/t-1');
      const node = (received[0] as any).node;
      assert.equal(node.$type, 'test.task');
      assert.equal(node.prompt, 'test task');
      assert.equal(node.status, 'pending');
    });

    it('action creating child triggers event via prefix watch', async () => {
      const pub = createClient(url);
      const reg = await pub.register.mutate({ userId: 'action-watcher', password: 'pass' });
      const client = createClient(url, reg.token);

      // Seed parent with an action that creates children
      await pub.set.mutate({ node: { $path: '/act-test', $type: 'dir' } });

      // Start SSE + watch children
      const events = collectEvents<DataEvent>(
        (cbs) => client.events.subscribe(undefined, cbs),
        { count: 1, timeoutMs: 3000 },
      );
      await new Promise(r => setTimeout(r, 300));

      await client.getChildren.query({ path: '/act-test', watchNew: true, watch: true });

      // Direct child creation
      await pub.set.mutate({ node: { $path: '/act-test/child-1', $type: 'doc', title: 'hello' } });

      const received = await events;
      assert.equal(received.length, 1, 'Should receive event for new child');
      assert.equal(received[0].path, '/act-test/child-1');
    });
  });
});
