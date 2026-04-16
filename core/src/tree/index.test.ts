import { createNode } from '#core';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { OpError } from '#errors';
import { createMemoryTree, createOverlayTree } from './index';

describe('MemoryStore', () => {
  it('set and get', async () => {
    const tree = createMemoryTree();
    const node = createNode('/tasks/1', 'task');
    await tree.set(node);
    assert.deepEqual(await tree.get('/tasks/1'), node);
  });

  it('get returns undefined for missing', async () => {
    const tree = createMemoryTree();
    assert.equal(await tree.get('/nope'), undefined);
  });

  it('getChildren returns direct children only', async () => {
    const tree = createMemoryTree();
    await tree.set(createNode('/bot', 'bot'));
    await tree.set(createNode('/bot/commands', 'dir'));
    await tree.set(createNode('/bot/commands/start', 'page'));
    await tree.set(createNode('/bot/commands/help', 'page'));
    await tree.set(createNode('/bot/config', 'config'));

    const { items: botChildren } = await tree.getChildren('/bot');
    assert.equal(botChildren.length, 2);
    assert.deepEqual(botChildren.map((n) => n.$path).sort(), ['/bot/commands', '/bot/config']);

    const { items: commands } = await tree.getChildren('/bot/commands');
    assert.equal(commands.length, 2);
    assert.deepEqual(commands.map((n) => n.$path).sort(), [
      '/bot/commands/help',
      '/bot/commands/start',
    ]);
  });

  it('getChildren with depth=2 returns two levels', async () => {
    const tree = createMemoryTree();
    await tree.set(createNode('/a', 'dir'));
    await tree.set(createNode('/a/b', 'dir'));
    await tree.set(createNode('/a/b/c', 'item'));
    await tree.set(createNode('/a/b/c/d', 'item'));
    await tree.set(createNode('/a/x', 'item'));

    const { items } = await tree.getChildren('/a', { depth: 2 });
    assert.equal(items.length, 3);
    assert.deepEqual(items.map((n) => n.$path).sort(), ['/a/b', '/a/b/c', '/a/x']);
  });

  it('getChildren with depth=Infinity returns all descendants', async () => {
    const tree = createMemoryTree();
    await tree.set(createNode('/r', 'root'));
    await tree.set(createNode('/r/a', 'dir'));
    await tree.set(createNode('/r/a/b', 'dir'));
    await tree.set(createNode('/r/a/b/c', 'item'));

    const result = await tree.getChildren('/r', { depth: Infinity });
    assert.equal(result.items.length, 3);
    assert.deepEqual(result.items.map((n) => n.$path).sort(), ['/r/a', '/r/a/b', '/r/a/b/c']);
  });

  it('remove', async () => {
    const tree = createMemoryTree();
    await tree.set(createNode('/x', 'x'));
    assert.equal(await tree.remove('/x'), true);
    assert.equal(await tree.get('/x'), undefined);
    assert.equal(await tree.remove('/x'), false);
  });

  it('getChildren with limit', async () => {
    const tree = createMemoryTree();
    await tree.set(createNode('/p', 'dir'));
    await tree.set(createNode('/p/a', 'item'));
    await tree.set(createNode('/p/b', 'item'));
    await tree.set(createNode('/p/c', 'item'));

    const result = await tree.getChildren('/p', { limit: 2 });
    assert.equal(result.items.length, 2);
    assert.equal(result.total, 3);
  });

  it('remove does not cascade to children', async () => {
    const tree = createMemoryTree();
    await tree.set(createNode('/a', 'dir'));
    await tree.set(createNode('/a/b', 'item'));
    await tree.set(createNode('/a/b/c', 'item'));
    assert.equal(await tree.remove('/a'), true);
    assert.equal(await tree.get('/a'), undefined);
    assert.equal((await tree.get('/a/b'))?.$type, 't.item');
    assert.equal((await tree.get('/a/b/c'))?.$type, 't.item');
  });

  it('getChildren with limit and offset', async () => {
    const tree = createMemoryTree();
    await tree.set(createNode('/p', 'dir'));
    await tree.set(createNode('/p/a', 'item'));
    await tree.set(createNode('/p/b', 'item'));
    await tree.set(createNode('/p/c', 'item'));

    const all = await tree.getChildren('/p');
    const result = await tree.getChildren('/p', { limit: 2, offset: 1 });
    assert.equal(result.items.length, 2);
    assert.equal(result.total, 3);
    assert.deepEqual(result.items, all.items.slice(1, 3));
  });

  it('get returns isolated copy — mutating result does not affect stored node', async () => {
    const tree = createMemoryTree();
    await tree.set(createNode('/x', 'item', { tags: ['a', 'b'] }));

    const copy = await tree.get('/x') as any;
    copy.tags.push('mutated');
    copy.extra = 'injected';

    const stored = await tree.get('/x') as any;
    assert.deepEqual(stored.tags, ['a', 'b']);
    assert.equal(stored.extra, undefined);
  });

  it('getChildren accepts watch/watchNew opts without error', async () => {
    const tree = createMemoryTree();
    await tree.set(createNode('/w', 'dir'));
    await tree.set(createNode('/w/a', 'item'));
    await tree.set(createNode('/w/b', 'item'));

    const result = await tree.getChildren('/w', { watch: true, watchNew: true });
    assert.equal(result.items.length, 2);
    assert.deepEqual(result.items.map(n => n.$path).sort(), ['/w/a', '/w/b']);
  });

  it('set stores isolated copy — mutating original after set does not affect stored node', async () => {
    const tree = createMemoryTree();
    const node = createNode('/y', 'item', { value: 1 }) as any;
    await tree.set(node);

    node.value = 999;
    node.injected = true;

    const stored = await tree.get('/y') as any;
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
    const tree = createOverlayTree(upper, lower);
    const node = await tree.get('/a');
    assert.equal(node?.$type, 't.upper');
  });

  it('falls back to lower on miss', async () => {
    const upper = createMemoryTree();
    const lower = createMemoryTree();
    await lower.set(createNode('/b', 'lower'));
    const tree = createOverlayTree(upper, lower);
    assert.equal((await tree.get('/b'))?.$type, 't.lower');
  });

  it('writes go to upper only', async () => {
    const upper = createMemoryTree();
    const lower = createMemoryTree();
    const tree = createOverlayTree(upper, lower);
    await tree.set(createNode('/c', 'new'));
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
    const tree = createOverlayTree(upper, lower);
    const { items } = await tree.getChildren('/p');
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
    const tree = createOverlayTree(upper, lower);
    assert.equal(await tree.remove('/x'), true);
    assert.equal(await tree.remove('/y'), false);
  });
});

describe('MemoryStore OCC — typed OpError', () => {
  it('set with stale $rev throws OpError with code CONFLICT', async () => {
    const tree = createMemoryTree();
    await tree.set(createNode('/n', 'doc', { title: 'a' }));
    const stored = (await tree.get('/n'))!;
    assert.ok(stored.$rev !== undefined, 'node should have $rev after set');
    await tree.set({ ...stored, title: 'b' }); // advances rev
    await assert.rejects(
      () => tree.set({ ...stored, title: 'c' }), // stale rev
      (e: unknown) => e instanceof OpError && e.code === 'CONFLICT',
    );
  });

  it('patch on missing node throws OpError with code NOT_FOUND', async () => {
    const tree = createMemoryTree();
    await assert.rejects(
      () => tree.patch('/nope', [['r', 'x', 1]]),
      (e: unknown) => e instanceof OpError && e.code === 'NOT_FOUND',
    );
  });
});
