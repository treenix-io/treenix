import { createNode } from '#core';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createMemoryTree, createOverlayTree } from './index';

describe('MemoryStore', () => {
  it('set and get', async () => {
    const store = createMemoryTree();
    const node = createNode('/tasks/1', 'task');
    await store.set(node);
    assert.deepEqual(await store.get('/tasks/1'), node);
  });

  it('get returns undefined for missing', async () => {
    const store = createMemoryTree();
    assert.equal(await store.get('/nope'), undefined);
  });

  it('getChildren returns direct children only', async () => {
    const store = createMemoryTree();
    await store.set(createNode('/bot', 'bot'));
    await store.set(createNode('/bot/commands', 'dir'));
    await store.set(createNode('/bot/commands/start', 'page'));
    await store.set(createNode('/bot/commands/help', 'page'));
    await store.set(createNode('/bot/config', 'config'));

    const { items: botChildren } = await store.getChildren('/bot');
    assert.equal(botChildren.length, 2);
    assert.deepEqual(botChildren.map((n) => n.$path).sort(), ['/bot/commands', '/bot/config']);

    const { items: commands } = await store.getChildren('/bot/commands');
    assert.equal(commands.length, 2);
    assert.deepEqual(commands.map((n) => n.$path).sort(), [
      '/bot/commands/help',
      '/bot/commands/start',
    ]);
  });

  it('getChildren with depth=2 returns two levels', async () => {
    const store = createMemoryTree();
    await store.set(createNode('/a', 'dir'));
    await store.set(createNode('/a/b', 'dir'));
    await store.set(createNode('/a/b/c', 'item'));
    await store.set(createNode('/a/b/c/d', 'item'));
    await store.set(createNode('/a/x', 'item'));

    const { items } = await store.getChildren('/a', { depth: 2 });
    assert.equal(items.length, 3);
    assert.deepEqual(items.map((n) => n.$path).sort(), ['/a/b', '/a/b/c', '/a/x']);
  });

  it('getChildren with depth=Infinity returns all descendants', async () => {
    const store = createMemoryTree();
    await store.set(createNode('/r', 'root'));
    await store.set(createNode('/r/a', 'dir'));
    await store.set(createNode('/r/a/b', 'dir'));
    await store.set(createNode('/r/a/b/c', 'item'));

    const result = await store.getChildren('/r', { depth: Infinity });
    assert.equal(result.items.length, 3);
    assert.deepEqual(result.items.map((n) => n.$path).sort(), ['/r/a', '/r/a/b', '/r/a/b/c']);
  });

  it('remove', async () => {
    const store = createMemoryTree();
    await store.set(createNode('/x', 'x'));
    assert.equal(await store.remove('/x'), true);
    assert.equal(await store.get('/x'), undefined);
    assert.equal(await store.remove('/x'), false);
  });

  it('getChildren with limit', async () => {
    const store = createMemoryTree();
    await store.set(createNode('/p', 'dir'));
    await store.set(createNode('/p/a', 'item'));
    await store.set(createNode('/p/b', 'item'));
    await store.set(createNode('/p/c', 'item'));

    const result = await store.getChildren('/p', { limit: 2 });
    assert.equal(result.items.length, 2);
    assert.equal(result.total, 3);
  });

  it('remove does not cascade to children', async () => {
    const store = createMemoryTree();
    await store.set(createNode('/a', 'dir'));
    await store.set(createNode('/a/b', 'item'));
    await store.set(createNode('/a/b/c', 'item'));
    assert.equal(await store.remove('/a'), true);
    assert.equal(await store.get('/a'), undefined);
    assert.equal((await store.get('/a/b'))?.$type, 't.item');
    assert.equal((await store.get('/a/b/c'))?.$type, 't.item');
  });

  it('getChildren with limit and offset', async () => {
    const store = createMemoryTree();
    await store.set(createNode('/p', 'dir'));
    await store.set(createNode('/p/a', 'item'));
    await store.set(createNode('/p/b', 'item'));
    await store.set(createNode('/p/c', 'item'));

    const all = await store.getChildren('/p');
    const result = await store.getChildren('/p', { limit: 2, offset: 1 });
    assert.equal(result.items.length, 2);
    assert.equal(result.total, 3);
    assert.deepEqual(result.items, all.items.slice(1, 3));
  });

  it('get returns isolated copy — mutating result does not affect stored node', async () => {
    const store = createMemoryTree();
    await store.set(createNode('/x', 'item', { tags: ['a', 'b'] }));

    const copy = await store.get('/x') as any;
    copy.tags.push('mutated');
    copy.extra = 'injected';

    const stored = await store.get('/x') as any;
    assert.deepEqual(stored.tags, ['a', 'b']);
    assert.equal(stored.extra, undefined);
  });

  it('set stores isolated copy — mutating original after set does not affect stored node', async () => {
    const store = createMemoryTree();
    const node = createNode('/y', 'item', { value: 1 }) as any;
    await store.set(node);

    node.value = 999;
    node.injected = true;

    const stored = await store.get('/y') as any;
    assert.equal(stored.value, 1);
    assert.equal(stored.injected, undefined);
  });

});

describe('OverlayStore', () => {
  it('reads from upper first', async () => {
    const upper = createMemoryTree();
    const lower = createMemoryTree();
    await upper.set(createNode('/a', 'upper'));
    await lower.set(createNode('/a', 'lower'));
    const store = createOverlayTree(upper, lower);
    const node = await store.get('/a');
    assert.equal(node?.$type, 't.upper');
  });

  it('falls back to lower on miss', async () => {
    const upper = createMemoryTree();
    const lower = createMemoryTree();
    await lower.set(createNode('/b', 'lower'));
    const store = createOverlayTree(upper, lower);
    assert.equal((await store.get('/b'))?.$type, 't.lower');
  });

  it('writes go to upper only', async () => {
    const upper = createMemoryTree();
    const lower = createMemoryTree();
    const store = createOverlayTree(upper, lower);
    await store.set(createNode('/c', 'new'));
    assert.equal((await upper.get('/c'))?.$type, 't.new');
    assert.equal(await lower.get('/c'), undefined);
  });

  it('getChildren merges, upper wins', async () => {
    const upper = createMemoryTree();
    const lower = createMemoryTree();
    await lower.set(createNode('/p/a', 'lower'));
    await lower.set(createNode('/p/b', 'lower'));
    await upper.set(createNode('/p/b', 'upper'));
    await upper.set(createNode('/p/c', 'upper'));
    const store = createOverlayTree(upper, lower);
    const { items } = await store.getChildren('/p');
    assert.equal(items.length, 3);
    const map = Object.fromEntries(items.map((n) => [n.$path, n.$type]));
    assert.equal(map['/p/a'], 't.lower');
    assert.equal(map['/p/b'], 't.upper');
    assert.equal(map['/p/c'], 't.upper');
  });

  it('remove only affects upper', async () => {
    const upper = createMemoryTree();
    const lower = createMemoryTree();
    await upper.set(createNode('/x', 'upper'));
    await lower.set(createNode('/y', 'lower'));
    const store = createOverlayTree(upper, lower);
    assert.equal(await store.remove('/x'), true);
    assert.equal(await store.remove('/y'), false);
  });
});
