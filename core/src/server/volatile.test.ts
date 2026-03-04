import { register } from '#core';
import { clearRegistry } from '#core/index.test';
import { createMemoryTree } from '#tree';
import { mapSiftQuery } from '#tree/query';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { extractPaths, withVolatile } from './volatile';

describe('withVolatile', () => {
  let store: ReturnType<typeof withVolatile>;
  let backing: ReturnType<typeof createMemoryTree>;

  beforeEach(() => {
    clearRegistry();
    backing = createMemoryTree();
    store = withVolatile(backing);
  });

  it('node with $volatile lives in memory only', async () => {
    await store.set({ $path: '/status', $type: 'stats', $volatile: true, msgs: 42 });
    assert.equal(await backing.get('/status'), undefined);
    const node = await store.get('/status');
    assert.ok(node);
    assert.equal(node.msgs, 42);
  });

  it('node without $volatile goes to backing store', async () => {
    await store.set({ $path: '/bot1', $type: 'bot', name: 'mybot' });
    const raw = await backing.get('/bot1');
    assert.ok(raw);
    assert.equal(raw.name, 'mybot');
  });

  it('type registration makes node volatile', async () => {
    register('bot-status', 'volatile', () => true);
    await store.set({ $path: '/s1', $type: 'bot-status', cpu: 50 });
    assert.equal(await backing.get('/s1'), undefined);
    const node = await store.get('/s1');
    assert.ok(node);
    assert.equal(node.cpu, 50);
  });

  it('$volatile: false overrides type registration', async () => {
    register('stats', 'volatile', () => true);
    await store.set({ $path: '/s1', $type: 'stats', $volatile: false, v: 99 });
    const raw = await backing.get('/s1');
    assert.ok(raw);
    assert.equal(raw.v, 99);
  });

  it('$volatile: true overrides non-volatile type', async () => {
    await store.set({ $path: '/bot1', $type: 'bot', $volatile: true, name: 'x' });
    assert.equal(await backing.get('/bot1'), undefined);
    const node = await store.get('/bot1');
    assert.ok(node);
    assert.equal(node.name, 'x');
  });

  it('getChildren merges volatile and persistent nodes', async () => {
    await store.set({ $path: '/bots', $type: 'dir' });
    await store.set({ $path: '/bots/b1', $type: 'bot', name: 'one' });
    await store.set({ $path: '/bots/b2', $type: 'bot', $volatile: true, name: 'two' });
    const { items } = await store.getChildren('/bots');
    assert.equal(items.length, 2);
    const names = items.map((n) => n.name).sort();
    assert.deepEqual(names, ['one', 'two']);
  });

  it('remove clears volatile node', async () => {
    await store.set({ $path: '/s1', $type: 'stats', $volatile: true, v: 1 });
    await store.remove('/s1');
    assert.equal(await store.get('/s1'), undefined);
  });

  it('remove works for both volatile and persistent', async () => {
    await store.set({ $path: '/b1', $type: 'bot', name: 'x' });
    await store.set({ $path: '/s1', $type: 'stats', $volatile: true, v: 1 });
    await store.remove('/b1');
    await store.remove('/s1');
    assert.equal(await store.get('/b1'), undefined);
    assert.equal(await store.get('/s1'), undefined);
  });

  it('getChildren passes sift query through to backing store', async () => {
    await store.set({ $path: '/tasks', $type: 'dir' });
    await store.set({ $path: '/tasks/t1', $type: 'task', status: 'pending' });
    await store.set({ $path: '/tasks/t2', $type: 'task', status: 'done' });
    await store.set({ $path: '/tasks/t3', $type: 'task', status: 'pending' });
    await store.set({ $path: '/tasks/mp', $type: 'mount-point' });

    const pending = await store.getChildren('/tasks', {
      query: mapSiftQuery({ $type: 'task', status: 'pending' }) as Record<string, unknown>,
    });
    assert.equal(pending.items.length, 2);
    assert.ok(pending.items.every(n => n.$type === 'task' && n.status === 'pending'));
  });

  it('getChildren query filters across both volatile and persistent', async () => {
    register('live', 'volatile', () => true);
    await store.set({ $path: '/mix', $type: 'dir' });
    await store.set({ $path: '/mix/a', $type: 'task', status: 'done' });
    await store.set({ $path: '/mix/b', $type: 'live', status: 'done', $volatile: true });
    await store.set({ $path: '/mix/c', $type: 'task', status: 'pending' });

    const done = await store.getChildren('/mix', {
      query: mapSiftQuery({ status: 'done' }) as Record<string, unknown>,
    });
    assert.equal(done.items.length, 2);
    assert.ok(done.items.every(n => n.status === 'done'));
  });
});

describe('extractPaths', () => {
  it('extracts from Page (items array)', () => {
    const result = {
      items: [
        { $path: '/a', $type: 't' },
        { $path: '/b', $type: 't' },
      ],
      total: 2,
    };
    assert.deepEqual(extractPaths(result), ['/a', '/b']);
  });

  it('extracts from single node', () => {
    assert.deepEqual(extractPaths({ $path: '/a', $type: 't' }), ['/a']);
  });

  it('returns empty for plain data', () => {
    assert.deepEqual(extractPaths({ count: 42 }), []);
    assert.deepEqual(extractPaths(null), []);
    assert.deepEqual(extractPaths(42), []);
    assert.deepEqual(extractPaths('hello'), []);
  });

  it('filters items without $path', () => {
    const result = { items: [{ $path: '/a', $type: 't' }, { name: 'no path' }], total: 2 };
    assert.deepEqual(extractPaths(result), ['/a']);
  });
});
