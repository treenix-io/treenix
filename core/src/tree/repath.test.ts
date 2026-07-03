import { createNode } from '#core';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createMemoryTree } from './index';
import { createRepathTree } from './repath';

describe('createRepathTree', () => {
  it('translates paths: local /mnt → remote /', async () => {
    const inner = createMemoryTree();
    await inner.set(createNode('/docs/readme', 'doc', { title: 'Hello' }));

    const mounted = createRepathTree(inner, '/mnt', '/docs');
    const node = await mounted.get('/mnt/readme');

    assert.ok(node);
    assert.equal(node.$path, '/mnt/readme');
    assert.equal((node as any).title, 'Hello');
  });

  it('get returns undefined for missing nodes', async () => {
    const inner = createMemoryTree();
    const mounted = createRepathTree(inner, '/mnt', '/');

    assert.equal(await mounted.get('/mnt/nope'), undefined);
  });

  it('set translates path to remote', async () => {
    const inner = createMemoryTree();
    const mounted = createRepathTree(inner, '/mnt', '/data');

    await mounted.set(createNode('/mnt/item', 'doc', { x: 1 }));

    // Verify inner tree has it at remote path
    const stored = await inner.get('/data/item');
    assert.ok(stored);
    assert.equal(stored.$path, '/data/item');
    assert.equal((stored as any).x, 1);
  });

  it('getChildren remaps all child paths', async () => {
    const inner = createMemoryTree();
    await inner.set(createNode('/a', 'doc'));
    await inner.set(createNode('/a/one', 'doc'));
    await inner.set(createNode('/a/two', 'doc'));

    const mounted = createRepathTree(inner, '/x', '/a');
    const { items } = await mounted.getChildren('/x');

    assert.equal(items.length, 2);
    const paths = items.map(n => n.$path).sort();
    assert.deepEqual(paths, ['/x/one', '/x/two']);
  });

  it('remove translates path', async () => {
    const inner = createMemoryTree();
    await inner.set(createNode('/data/tmp', 'doc'));

    const mounted = createRepathTree(inner, '/mnt', '/data');
    const removed = await mounted.remove('/mnt/tmp');

    assert.ok(removed);
    assert.equal(await inner.get('/data/tmp'), undefined);
  });

  it('handles root remoteBase', async () => {
    const inner = createMemoryTree();
    await inner.set(createNode('/hello', 'doc'));

    const mounted = createRepathTree(inner, '/remote', '/');
    const node = await mounted.get('/remote/hello');

    assert.ok(node);
    assert.equal(node.$path, '/remote/hello');
  });

  it('handles mount at root', async () => {
    const inner = createMemoryTree();
    await inner.set(createNode('/stuff/item', 'doc'));

    const mounted = createRepathTree(inner, '/', '/stuff');
    const node = await mounted.get('/item');

    assert.ok(node);
    assert.equal(node.$path, '/item');
  });

  it('R4-TREE-1: rejects path containing ..', async () => {
    const inner = createMemoryTree();
    const mounted = createRepathTree(inner, '/mnt', '/data');
    await assert.rejects(() => mounted.get('/mnt/../etc'), /traversal|Invalid path/);
  });

  it('R4-TREE-1: rejects path outside localBase prefix', async () => {
    const inner = createMemoryTree();
    const mounted = createRepathTree(inner, '/mnt', '/data');
    await assert.rejects(() => mounted.get('/other/x'), /not under localBase/);
  });

  it('R4-TREE-1: accepts exact localBase address (mount root)', async () => {
    const inner = createMemoryTree();
    await inner.set(createNode('/data', 'dir'));
    const mounted = createRepathTree(inner, '/mnt', '/data');
    const node = await mounted.get('/mnt');
    assert.ok(node);
  });

  describe('execute capability', () => {
    it('no execute key when inner lacks the capability', () => {
      const inner = createMemoryTree();
      const mounted = createRepathTree(inner, '/mnt', '/data');
      assert.equal('execute' in mounted, false);
    });

    it('forwards with path translated to remote, opts/data intact', async () => {
      const calls: unknown[][] = [];
      const inner = {
        ...createMemoryTree(),
        execute: async (...args: unknown[]) => { calls.push(args); return 42; },
      };
      const mounted = createRepathTree(inner, '/mnt', '/data');

      const result = await mounted.execute!('/mnt/item', 'bump', { by: 2 }, { key: 'counter', opId: 'op-1' });

      assert.equal(result, 42);
      assert.equal(calls.length, 1);
      const [path, action, data, opts] = calls[0];
      assert.equal(path, '/data/item');
      assert.equal(action, 'bump');
      assert.deepEqual(data, { by: 2 });
      assert.deepEqual(opts, { key: 'counter', opId: 'op-1' });
    });

    it('remaps node-shaped result back to local namespace', async () => {
      const inner = {
        ...createMemoryTree(),
        execute: async () => ({ $path: '/data/item', $type: 'doc', n: 1 }),
      };
      const mounted = createRepathTree(inner, '/mnt', '/data');

      const result = await mounted.execute!('/mnt/item', 'read') as { $path: string };
      assert.equal(result.$path, '/mnt/item');
    });

    it('remaps Page-shaped result items back to local namespace', async () => {
      const inner = {
        ...createMemoryTree(),
        execute: async () => ({ items: [{ $path: '/data/a' }, { $path: '/data/b' }], total: 2 }),
      };
      const mounted = createRepathTree(inner, '/mnt', '/data');

      const result = await mounted.execute!('/mnt', 'list') as { items: { $path: string }[] };
      assert.deepEqual(result.items.map(i => i.$path), ['/mnt/a', '/mnt/b']);
    });

    it('leaves scalar and non-node results untouched', async () => {
      const inner = {
        ...createMemoryTree(),
        execute: async () => ({ ok: true, count: 3 }),
      };
      const mounted = createRepathTree(inner, '/mnt', '/data');

      assert.deepEqual(await mounted.execute!('/mnt/item', 'stat'), { ok: true, count: 3 });
    });

    it('fails loudly on result $path outside remoteBase', async () => {
      const inner = {
        ...createMemoryTree(),
        execute: async () => ({ $path: '/outside', $type: 'doc' }),
      };
      const mounted = createRepathTree(inner, '/mnt', '/data');

      await assert.rejects(() => mounted.execute!('/mnt/item', 'leak'), /outside remoteBase/);
    });
  });
});
