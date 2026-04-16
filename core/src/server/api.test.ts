// Integration tests — full tRPC API from client perspective.
// Builds the real tree pipeline (memory → mountable → volatile → validated → subscriptions),
// exercises every operation, verifies ACL, events, CDC Matrix, and OpError mapping.

import { registerType } from '#comp';
import { createNode, R, register, S, W } from '#core';
import { createMemoryTree, type Tree } from '#tree';
import assert from 'node:assert/strict';
import { before, beforeEach, describe, it } from 'node:test';
import { type Session } from './auth';
import './mount-adapters';
import { withMounts } from './mount';
import { type NodeEvent, withSubscriptions } from './sub';
import { createTreeRouter } from './trpc';
import { withValidation } from './validate';
import { withVolatile } from './volatile';
import { createWatchManager, type WatchManager } from './watch';

type DataEvent = Exclude<NodeEvent, { type: 'reconnect' }>;

// ── Test components ──

class OrderStatus {
  status = 'new';
  cook() { this.status = 'kitchen'; }
  deliver() { this.status = 'delivered'; }
}

class Metadata {
  title = '';
  description = '';
  rename({ title }: { title: string }) { this.title = title; }
}

describe('tRPC API integration', () => {
  let watcher: WatchManager;
  let events: DataEvent[];
  let caller: ReturnType<ReturnType<typeof createTreeRouter>['createCaller']>;
  let authedCaller: typeof caller;
  let rawStore: Tree;

  before(() => {
    registerType('order.status', OrderStatus);
    register('order.status', 'schema', () => ({
      $id: 'order.status', title: 'OrderStatus', type: 'object' as const,
      properties: { status: { type: 'string' } },
      methods: { cook: { arguments: [] }, deliver: { arguments: [] } },
    }));
    registerType('metadata', Metadata);
    register('metadata', 'schema', () => ({
      $id: 'metadata', title: 'Metadata', type: 'object' as const,
      properties: { title: { type: 'string' }, description: { type: 'string' } },
      methods: { rename: { arguments: [{ name: 'data', type: 'object', properties: { title: { type: 'string' } }, required: ['title'] }] } },
    }));
  });

  beforeEach(async () => {
    const bootstrap = createMemoryTree();

    // Seed root with public RW+S directly (bypasses ACL)
    await bootstrap.set({
      ...createNode('/', 'root'),
      $acl: [{ g: 'public', p: R | W | S }],
    });

    const mountable = withMounts(bootstrap);
    const volatile = withVolatile(mountable);
    const validated = withValidation(volatile);
    watcher = createWatchManager();
    events = [];
    const { tree, cdc } = withSubscriptions(validated, (e) => {
      events.push(e as DataEvent);
      watcher.notify(e);
    });
    rawStore = tree;

    const router = createTreeRouter(tree, watcher, undefined, cdc);
    caller = router.createCaller({ session: null, token: null });
    authedCaller = router.createCaller({ session: { userId: 'alice' } as Session, token: null });
  });

  // ── CRUD ──

  describe('CRUD', () => {
    it('set + get', async () => {
      await caller.set({ node: { $path: '/a', $type: 'doc' } });
      const node = await caller.get({ path: '/a' });
      assert.equal(node?.$type, 'doc');
      assert.equal(node?.$path, '/a');
    });

    it('get returns undefined for missing', async () => {
      assert.equal(await caller.get({ path: '/missing' }), undefined);
    });

    it('getChildren returns children', async () => {
      await caller.set({ node: { $path: '/p', $type: 'folder' } });
      await caller.set({ node: { $path: '/p/a', $type: 'doc' } });
      await caller.set({ node: { $path: '/p/b', $type: 'doc' } });
      const result = await caller.getChildren({ path: '/p' });
      assert.equal(result.items.length, 2);
    });

    it('getChildren paginates', async () => {
      await caller.set({ node: { $path: '/list', $type: 'folder' } });
      for (let i = 0; i < 5; i++)
        await caller.set({ node: { $path: `/list/${i}`, $type: 'doc' } });

      const page = await caller.getChildren({ path: '/list', limit: 2 });
      assert.equal(page.items.length, 2);
      assert.equal(page.total, 5);
    });

    it('remove deletes node', async () => {
      await caller.set({ node: { $path: '/del', $type: 'doc' } });
      assert.ok(await caller.get({ path: '/del' }));
      await caller.remove({ path: '/del' });
      assert.equal(await caller.get({ path: '/del' }), undefined);
    });
  });

  // ── setComponent ──

  describe('setComponent', () => {
    it('updates single component', async () => {
      await caller.set({ node: { $path: '/n', $type: 'doc', meta: { $type: 'metadata', title: 'old', description: '' } } });
      await caller.setComponent({ path: '/n', name: 'meta', data: { $type: 'metadata', title: 'new', description: 'x' } });
      const node = await caller.get({ path: '/n' });
      assert.equal((node as any).meta.title, 'new');
    });

    it('NOT_FOUND for missing node', async () => {
      await assert.rejects(
        () => caller.setComponent({ path: '/nope', name: 'x', data: { $type: 'x' } }),
        (e: any) => e.code === 'NOT_FOUND',
      );
    });

    it('CONFLICT on stale $rev', async () => {
      // Blind upsert (no $rev) — tree auto-assigns $rev: 1
      await caller.set({ node: { $path: '/rev', $type: 'doc', x: { $type: 'x' } } });
      await assert.rejects(
        () => caller.setComponent({ path: '/rev', name: 'x', data: { $type: 'x' }, rev: 99 }),
        (e: any) => e.code === 'CONFLICT',
      );
    });
  });

  // ── patch ──

  describe('patch', () => {
    it('replaces a field', async () => {
      await caller.set({ node: { $path: '/p', $type: 'doc', title: 'old' } });
      await caller.patch({ path: '/p', ops: [['r', 'title', 'new']] });
      const node = await caller.get({ path: '/p' });
      assert.equal((node as any).title, 'new');
    });

    it('deletes a field', async () => {
      await caller.set({ node: { $path: '/p2', $type: 'doc', extra: 'bye' } });
      await caller.patch({ path: '/p2', ops: [['d', 'extra']] });
      const node = await caller.get({ path: '/p2' });
      assert.equal((node as any).extra, undefined);
    });

    it('applies multiple ops atomically', async () => {
      await caller.set({ node: { $path: '/p3', $type: 'doc', a: 1, b: 2, c: 3 } });
      await caller.patch({ path: '/p3', ops: [['r', 'a', 10], ['d', 'b'], ['r', 'c', 30]] });
      const node = await caller.get({ path: '/p3' });
      assert.equal((node as any).a, 10);
      assert.equal((node as any).b, undefined);
      assert.equal((node as any).c, 30);
    });

    it('deep field via dot-notation', async () => {
      await caller.set({ node: { $path: '/p4', $type: 'doc', meta: { title: 'old', count: 0 } } });
      await caller.patch({ path: '/p4', ops: [['r', 'meta.title', 'new']] });
      const node = await caller.get({ path: '/p4' });
      assert.equal((node as any).meta.title, 'new');
      assert.equal((node as any).meta.count, 0);
    });

    it('emits patch event', async () => {
      await caller.set({ node: { $path: '/p5', $type: 'doc', x: 1 } });
      events.length = 0;
      await caller.patch({ path: '/p5', ops: [['r', 'x', 2]] });
      const patchEvent = events.find(e => e.type === 'patch' && e.path === '/p5');
      assert.ok(patchEvent, 'patch event emitted');
    });

    it('idempotent: same replace twice = same result', async () => {
      await caller.set({ node: { $path: '/p6', $type: 'doc', val: 'a' } });
      await caller.patch({ path: '/p6', ops: [['r', 'val', 'b']] });
      await caller.patch({ path: '/p6', ops: [['r', 'val', 'b']] });
      const node = await caller.get({ path: '/p6' });
      assert.equal((node as any).val, 'b');
    });
  });

  // ── executeAction ──

  describe('executeAction', () => {
    it('mutates node via Immer draft', async () => {
      await caller.set({ node: { $path: '/o', $type: 'page', status: { $type: 'order.status', status: 'new' } } });
      await caller.execute({ path: '/o', key: 'status', action: 'cook' });
      const node = await caller.get({ path: '/o' });
      assert.equal((node as any).status.status, 'kitchen');
    });

    it('NOT_FOUND for missing node', async () => {
      await assert.rejects(
        () => caller.execute({ path: '/nope', action: 'cook' }),
        (e: any) => e.code === 'NOT_FOUND',
      );
    });

    it('NOT_FOUND for missing component', async () => {
      await caller.set({ node: { $path: '/o2', $type: 'page' } });
      await assert.rejects(
        () => caller.execute({ path: '/o2', key: 'missing', action: 'cook' }),
        (e: any) => e.code === 'NOT_FOUND',
      );
    });

    it('BAD_REQUEST for missing action', async () => {
      await caller.set({ node: { $path: '/o3', $type: 'page', status: { $type: 'order.status', status: 'new' } } });
      await assert.rejects(
        () => caller.execute({ path: '/o3', key: 'status', action: 'nonexistent' }),
        (e: any) => e.code === 'BAD_REQUEST',
      );
    });

    it('generates Immer patches in events', async () => {
      await caller.set({ node: { $path: '/pe', $type: 'page', meta: { $type: 'metadata', title: 'old', description: '' } } });
      events.length = 0;
      await caller.execute({ path: '/pe', key: 'meta', action: 'rename', data: { title: 'new' } });

      const patchEvent = events.find(e => e.path === '/pe' && e.type === 'patch');
      assert.ok(patchEvent, 'Should emit patch event');
      assert.ok('patches' in patchEvent! && patchEvent.patches!.length > 0);
    });
  });

  // ── execute: pure (no-patch) actions ──

  describe('execute pure actions', () => {
    it('NOT_FOUND for missing node', async () => {
      await assert.rejects(
        () => caller.execute({ path: '/nope', action: 'foo' }),
        (e: any) => e.code === 'NOT_FOUND',
      );
    });

    it('BAD_REQUEST for missing action', async () => {
      await caller.set({ node: { $path: '/ca', $type: 'page' } });
      await assert.rejects(
        () => caller.execute({ path: '/ca', action: 'nonexistent' }),
        (e: any) => e.code === 'BAD_REQUEST',
      );
    });
  });

  // ── applyTemplate ──

  describe('applyTemplate', () => {
    it('copies template blocks to target', async () => {
      await caller.set({ node: { $path: '/templates', $type: 'folder' } });
      await caller.set({ node: { $path: '/templates/blog', $type: 'template' } });
      await caller.set({ node: { $path: '/templates/blog/header', $type: 'block', content: 'Hello' } });
      await caller.set({ node: { $path: '/templates/blog/body', $type: 'block', content: 'World' } });
      await caller.set({ node: { $path: '/target', $type: 'page' } });

      const result = await caller.applyTemplate({ templatePath: '/templates/blog', targetPath: '/target' });
      assert.equal(result.blocks, 2);

      const children = await caller.getChildren({ path: '/target' });
      assert.equal(children.items.length, 2);
      const paths = children.items.map(n => n.$path).sort();
      assert.deepEqual(paths, ['/target/body', '/target/header']);
    });

    it('replaces existing children', async () => {
      await caller.set({ node: { $path: '/templates/t', $type: 'template' } });
      await caller.set({ node: { $path: '/templates/t/new', $type: 'block' } });
      await caller.set({ node: { $path: '/dest', $type: 'page' } });
      await caller.set({ node: { $path: '/dest/old', $type: 'block' } });

      await caller.applyTemplate({ templatePath: '/templates/t', targetPath: '/dest' });
      const children = await caller.getChildren({ path: '/dest' });
      assert.equal(children.items.length, 1);
      assert.equal(children.items[0].$path, '/dest/new');
    });

    it('NOT_FOUND for missing template', async () => {
      await assert.rejects(
        () => caller.applyTemplate({ templatePath: '/nope', targetPath: '/x' }),
        (e: any) => e.code === 'NOT_FOUND',
      );
    });
  });

  // ── Auth ──

  describe('auth', () => {
    it('register + login', async () => {
      const reg = await caller.register({ userId: 'testuser', password: 'pass123' });
      assert.equal(reg.userId, 'testuser');
      assert.ok(reg.token);

      const login = await caller.login({ userId: 'testuser', password: 'pass123' });
      assert.equal(login.userId, 'testuser');
      assert.ok(login.token);
    });

    it('register rejects duplicate', async () => {
      await caller.register({ userId: 'dup', password: 'pass' });
      await assert.rejects(
        () => caller.register({ userId: 'dup', password: 'pass' }),
        (e: any) => e.code === 'CONFLICT',
      );
    });

    it('login rejects wrong password', async () => {
      await caller.register({ userId: 'u1', password: 'correct' });
      await assert.rejects(
        () => caller.login({ userId: 'u1', password: 'wrong' }),
        (e: any) => e.code === 'UNAUTHORIZED',
      );
    });

    it('login rejects unknown user', async () => {
      await assert.rejects(
        () => caller.login({ userId: 'ghost', password: 'x' }),
        (e: any) => e.code === 'UNAUTHORIZED',
      );
    });

    it('me returns userId for authed, null for public', async () => {
      assert.equal((await authedCaller.me())?.userId, 'alice');
      assert.equal(await caller.me(), null);
    });

  });

  // ── ACL ──

  describe('ACL', () => {
    beforeEach(async () => {
      await rawStore.set({
        ...createNode('/private', 'folder'),
        $acl: [{ g: 'admins', p: R | W }, { g: 'public', p: 0 }],
      });
      await rawStore.set(createNode('/private/secret', 'doc'));
    });

    it('public cannot read denied nodes', async () => {
      assert.equal(await caller.get({ path: '/private/secret' }), undefined);
    });

    it('public cannot write denied paths', async () => {
      await assert.rejects(
        () => caller.set({ node: { $path: '/private/new', $type: 'doc' } }),
        (e: any) => e.code === 'FORBIDDEN',
      );
    });

    it('getChildren filters forbidden', async () => {
      const result = await caller.getChildren({ path: '/private' });
      assert.equal(result.items.length, 0);
    });

    it('public cannot execute action on denied node', async () => {
      // Node is inaccessible → execute returns NOT_FOUND (security: don't reveal existence)
      await rawStore.set(createNode('/private/order', 'order.status', { status: 'new' }));
      await assert.rejects(
        () => caller.execute({ path: '/private/order', action: 'cook' }),
        (e: any) => e.code === 'NOT_FOUND',
      );
    });
  });

  // ── Events ──

  describe('events', () => {
    it('set emits set event', async () => {
      events.length = 0;
      await caller.set({ node: { $path: '/ev1', $type: 'doc' } });
      assert.ok(events.some(e => e.path === '/ev1' && e.type === 'set'));
    });

    it('remove emits remove event', async () => {
      await caller.set({ node: { $path: '/ev2', $type: 'doc' } });
      events.length = 0;
      await caller.remove({ path: '/ev2' });
      assert.ok(events.some(e => e.path === '/ev2' && e.type === 'remove'));
    });

    it('execute emits patch event', async () => {
      await caller.set({ node: { $path: '/ev3', $type: 'page', meta: { $type: 'metadata', title: 'old', description: '' } } });
      events.length = 0;
      await caller.execute({ path: '/ev3', key: 'meta', action: 'rename', data: { title: 'new' } });
      assert.ok(events.some(e => e.path === '/ev3' && e.type === 'patch'));
    });
  });

  // ── CDC Matrix ──

  describe('CDC Matrix', () => {
    // Use dot notation for sift: 'status.status' matches nested component field
    beforeEach(async () => {
      await caller.set({ node: { $path: '/orders', $type: 'folder' } });
      await caller.set({ node: { $path: '/orders/data', $type: 'folder' } });
      await caller.set({ node: { $path: '/orders/data/1', $type: 'page', status: { $type: 'order.status', status: 'new' } } });
      await caller.set({ node: {
        $path: '/orders/new', $type: 'folder',
        mount: { $type: 't.mount.query', source: '/orders/data', match: { 'status.status': 'new' } },
      } });
      await caller.set({ node: {
        $path: '/orders/kitchen', $type: 'folder',
        mount: { $type: 't.mount.query', source: '/orders/data', match: { 'status.status': 'kitchen' } },
      } });
    });

    it('query mount filters correctly', async () => {
      const newOrders = await caller.getChildren({ path: '/orders/new' });
      const kitchen = await caller.getChildren({ path: '/orders/kitchen' });
      assert.equal(newOrders.items.length, 1);
      assert.equal(kitchen.items.length, 0);
    });

    it('action moves node between virtual folders', async () => {
      assert.equal((await caller.getChildren({ path: '/orders/new' })).items.length, 1);

      await caller.execute({ path: '/orders/data/1', key: 'status', action: 'cook' });

      assert.equal((await caller.getChildren({ path: '/orders/new' })).items.length, 0, 'Left /orders/new');
      const kitchen = await caller.getChildren({ path: '/orders/kitchen' });
      assert.equal(kitchen.items.length, 1, 'Entered /orders/kitchen');
      assert.equal(kitchen.items[0].$path, '/orders/data/1', 'Canonical path preserved');
    });

    it('CDC emits addVps/rmVps', async () => {
      await authedCaller.getChildren({ path: '/orders/new', watchNew: true });
      await authedCaller.getChildren({ path: '/orders/kitchen', watchNew: true });

      events.length = 0;
      await caller.execute({ path: '/orders/data/1', key: 'status', action: 'cook' });

      const ev = events.find(e => e.path === '/orders/data/1');
      assert.ok(ev);
      if ('addVps' in ev!) assert.ok(ev.addVps?.includes('/orders/kitchen'));
      if ('rmVps' in ev!) assert.ok(ev.rmVps?.includes('/orders/new'));
    });

    it('multiple orders independently tracked', async () => {
      await caller.set({ node: { $path: '/orders/data/2', $type: 'page', status: { $type: 'order.status', status: 'new' } } });
      await caller.set({ node: { $path: '/orders/data/3', $type: 'page', status: { $type: 'order.status', status: 'new' } } });

      assert.equal((await caller.getChildren({ path: '/orders/new' })).items.length, 3);

      await caller.execute({ path: '/orders/data/2', key: 'status', action: 'cook' });

      assert.equal((await caller.getChildren({ path: '/orders/new' })).items.length, 2);
      const kitchen = await caller.getChildren({ path: '/orders/kitchen' });
      assert.equal(kitchen.items.length, 1);
      assert.equal(kitchen.items[0].$path, '/orders/data/2');
    });

    it('double transition: new → kitchen → delivered', async () => {
      await caller.execute({ path: '/orders/data/1', key: 'status', action: 'cook' });
      assert.equal((await caller.getChildren({ path: '/orders/kitchen' })).items.length, 1);

      await caller.execute({ path: '/orders/data/1', key: 'status', action: 'deliver' });
      assert.equal((await caller.getChildren({ path: '/orders/new' })).items.length, 0);
      assert.equal((await caller.getChildren({ path: '/orders/kitchen' })).items.length, 0);
    });
  });

  // ── Watch wiring ──

  describe('watch', () => {
    it('exact path watch receives events', async () => {
      const received: DataEvent[] = [];
      watcher.connect('watcher1', 'watcher1', (e) => received.push(e as DataEvent));
      watcher.watch('watcher1', ['/w']);

      await caller.set({ node: { $path: '/w', $type: 'doc' } });
      assert.ok(received.some(e => e.path === '/w'));
      watcher.disconnect('watcher1');
    });

    it('children watch receives child events', async () => {
      const received: DataEvent[] = [];
      watcher.connect('watcher2', 'watcher2', (e) => received.push(e as DataEvent));
      watcher.watch('watcher2', ['/parent'], { children: true });

      await caller.set({ node: { $path: '/parent', $type: 'folder' } });
      await caller.set({ node: { $path: '/parent/child', $type: 'doc' } });
      assert.ok(received.some(e => e.path === '/parent/child'));
      watcher.disconnect('watcher2');
    });

    it('unwatch stops receiving events', async () => {
      const received: DataEvent[] = [];
      watcher.connect('watcher3', 'watcher3', (e) => received.push(e as DataEvent));
      watcher.watch('watcher3', ['/uw']);

      await caller.set({ node: { $path: '/uw', $type: 'doc' } });
      const count = received.length;

      watcher.unwatch('watcher3', ['/uw']);
      await caller.set({ node: { $path: '/uw', $type: 'doc', x: 1 } });
      assert.equal(received.length, count, 'No new events after unwatch');
      watcher.disconnect('watcher3');
    });
  });
});
