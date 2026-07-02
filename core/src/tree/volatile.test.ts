import { register } from '#core';
import { clearRegistry } from '#testing';
import { OpError } from '#errors';
import { createMemoryTree } from '#tree';
import { mapSiftQuery } from '#tree/query';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { extractPaths, withVolatile } from './volatile';

describe('withVolatile', () => {
  let tree: ReturnType<typeof withVolatile>;
  let backing: ReturnType<typeof createMemoryTree>;

  beforeEach(() => {
    clearRegistry();
    backing = createMemoryTree();
    tree = withVolatile(backing);
  });

  it('node with $volatile lives in memory only', async () => {
    await tree.set({ $path: '/status', $type: 'stats', $volatile: true, msgs: 42 });
    assert.equal(await backing.get('/status'), undefined);
    const node = await tree.get('/status');
    assert.ok(node);
    assert.equal(node.msgs, 42);
  });

  it('node without $volatile goes to backing tree', async () => {
    await tree.set({ $path: '/bot1', $type: 'bot', name: 'mybot' });
    const raw = await backing.get('/bot1');
    assert.ok(raw);
    assert.equal(raw.name, 'mybot');
  });

  it('type registration makes node volatile', async () => {
    register('bot-status', 'volatile', () => true);
    await tree.set({ $path: '/s1', $type: 'bot-status', cpu: 50 });
    assert.equal(await backing.get('/s1'), undefined);
    const node = await tree.get('/s1');
    assert.ok(node);
    assert.equal(node.cpu, 50);
  });

  it('type registration can explicitly return non-volatile', async () => {
    register('bot-status', 'volatile', () => false);
    await tree.set({ $path: '/s1', $type: 'bot-status', cpu: 50 });

    const raw = await backing.get('/s1');
    assert.ok(raw);
    assert.equal(raw.cpu, 50);
  });

  it('$volatile: false overrides type registration', async () => {
    register('stats', 'volatile', () => true);
    await tree.set({ $path: '/s1', $type: 'stats', $volatile: false, v: 99 });
    const raw = await backing.get('/s1');
    assert.ok(raw);
    assert.equal(raw.v, 99);
  });

  it('$volatile: true overrides non-volatile type', async () => {
    await tree.set({ $path: '/bot1', $type: 'bot', $volatile: true, name: 'x' });
    assert.equal(await backing.get('/bot1'), undefined);
    const node = await tree.get('/bot1');
    assert.ok(node);
    assert.equal(node.name, 'x');
  });

  it('getChildren merges volatile and persistent nodes', async () => {
    await tree.set({ $path: '/bots', $type: 'dir' });
    await tree.set({ $path: '/bots/b1', $type: 'bot', name: 'one' });
    await tree.set({ $path: '/bots/b2', $type: 'bot', $volatile: true, name: 'two' });
    const { items } = await tree.getChildren('/bots');
    assert.equal(items.length, 2);
    const names = items.map((n) => n.name).sort();
    assert.deepEqual(names, ['one', 'two']);
  });

  it('remove clears volatile node', async () => {
    await tree.set({ $path: '/s1', $type: 'stats', $volatile: true, v: 1 });
    await tree.remove('/s1');
    assert.equal(await tree.get('/s1'), undefined);
  });

  it('remove works for both volatile and persistent', async () => {
    await tree.set({ $path: '/b1', $type: 'bot', name: 'x' });
    await tree.set({ $path: '/s1', $type: 'stats', $volatile: true, v: 1 });
    await tree.remove('/b1');
    await tree.remove('/s1');
    assert.equal(await tree.get('/b1'), undefined);
    assert.equal(await tree.get('/s1'), undefined);
  });

  it('getChildren passes sift query through to backing tree', async () => {
    await tree.set({ $path: '/tasks', $type: 'dir' });
    await tree.set({ $path: '/tasks/t1', $type: 'task', status: 'pending' });
    await tree.set({ $path: '/tasks/t2', $type: 'task', status: 'done' });
    await tree.set({ $path: '/tasks/t3', $type: 'task', status: 'pending' });
    await tree.set({ $path: '/tasks/mp', $type: 'mount-point' });

    const pending = await tree.getChildren('/tasks', {
      query: mapSiftQuery({ $type: 'task', status: 'pending' }) as Record<string, unknown>,
    });
    assert.equal(pending.items.length, 2);
    assert.ok(pending.items.every(n => n.$type === 'task' && n.status === 'pending'));
  });

  it('getChildren query filters across both volatile and persistent', async () => {
    register('live', 'volatile', () => true);
    await tree.set({ $path: '/mix', $type: 'dir' });
    await tree.set({ $path: '/mix/a', $type: 'task', status: 'done' });
    await tree.set({ $path: '/mix/b', $type: 'live', status: 'done', $volatile: true });
    await tree.set({ $path: '/mix/c', $type: 'task', status: 'pending' });

    const done = await tree.getChildren('/mix', {
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

  it('throws on item missing $path', () => {
    const result = { items: [{ $path: '/a', $type: 't' }, { name: 'no path' }], total: 2 };
    assert.throws(
      () => extractPaths(result),
      (e: unknown) => e instanceof OpError && e.code === 'BAD_REQUEST',
    );
  });

  it('throws on item with non-string $path', () => {
    const result = { items: [{ $path: 123, $type: 't' }], total: 1 };
    assert.throws(
      () => extractPaths(result),
      (e: unknown) => e instanceof OpError && e.code === 'BAD_REQUEST',
    );
  });

  it('throws on null item inside items array', () => {
    const result = { items: [{ $path: '/a', $type: 't' }, null], total: 2 };
    assert.throws(
      () => extractPaths(result),
      (e: unknown) => e instanceof OpError && e.code === 'BAD_REQUEST',
    );
  });
});
