import type { NodeData } from '@treenity/core/core';
import { withCache } from '@treenity/core/tree/cache';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRemoteTree } from './remote-tree';

// ── Mock tRPC client ──

function createMockTrpc(backing: Map<string, NodeData>) {
  let getCalls = 0;

  const mock = {
    get getCalls() { return getCalls; },
    resetCalls() { getCalls = 0; },

    get: {
      query: async ({ path }: { path: string }) => {
        getCalls++;
        return backing.get(path);
      },
    },
    getChildren: {
      query: async ({ path, limit, offset }: { path: string; limit?: number; offset?: number }) => {
        getCalls++;
        const prefix = path === '/' ? '/' : path + '/';
        const items = [...backing.values()].filter(
          n => n.$path.startsWith(prefix) && n.$path !== path
            && n.$path.slice(prefix.length).indexOf('/') === -1,
        );
        const start = offset ?? 0;
        const sliced = limit ? items.slice(start, start + limit) : items.slice(start);
        return { items: sliced, total: items.length };
      },
    },
    set: {
      mutate: async ({ node }: { node: Record<string, unknown> }) => {
        backing.set(node.$path as string, node as NodeData);
      },
    },
    remove: {
      mutate: async ({ path }: { path: string }) => {
        backing.delete(path);
      },
    },
  };

  return mock;
}

// ── Tests ──

describe('createRemoteTree — method mapping', () => {
  it('get delegates to trpc.get.query', async () => {
    const data = new Map<string, NodeData>();
    data.set('/a', { $path: '/a', $type: 'test', v: 1 } as NodeData);
    const mock = createMockTrpc(data);
    const store = createRemoteTree(mock as any);

    const node = await store.get('/a');
    assert.equal(node?.$path, '/a');
    assert.equal((node as any).v, 1);
    assert.equal(mock.getCalls, 1);
  });

  it('get returns undefined for missing path', async () => {
    const store = createRemoteTree(createMockTrpc(new Map()) as any);
    const node = await store.get('/missing');
    assert.equal(node, undefined);
  });

  it('getChildren delegates to trpc.getChildren.query', async () => {
    const data = new Map<string, NodeData>();
    data.set('/p', { $path: '/p', $type: 'dir' } as NodeData);
    data.set('/p/a', { $path: '/p/a', $type: 'test' } as NodeData);
    data.set('/p/b', { $path: '/p/b', $type: 'test' } as NodeData);
    const store = createRemoteTree(createMockTrpc(data) as any);

    const result = await store.getChildren('/p');
    assert.equal(result.items.length, 2);
    assert.equal(result.total, 2);
  });

  it('set delegates to trpc.set.mutate', async () => {
    const data = new Map<string, NodeData>();
    const store = createRemoteTree(createMockTrpc(data) as any);

    await store.set({ $path: '/x', $type: 'test', v: 42 } as NodeData);
    assert.ok(data.has('/x'));
    assert.equal((data.get('/x') as any).v, 42);
  });

  it('remove delegates to trpc.remove.mutate', async () => {
    const data = new Map<string, NodeData>();
    data.set('/x', { $path: '/x', $type: 'test' } as NodeData);
    const store = createRemoteTree(createMockTrpc(data) as any);

    const result = await store.remove('/x');
    assert.equal(result, true);
    assert.ok(!data.has('/x'));
  });
});

describe('withCache(remoteStore) — client pipeline', () => {
  it('caches get results — second call skips tRPC', async () => {
    const data = new Map<string, NodeData>();
    data.set('/a', { $path: '/a', $type: 'test' } as NodeData);
    const mock = createMockTrpc(data);
    const store = withCache(createRemoteTree(mock as any));

    await store.get('/a');
    mock.resetCalls();
    await store.get('/a'); // should hit cache
    assert.equal(mock.getCalls, 0);
  });

  it('write-populate: set warms cache for next get', async () => {
    const data = new Map<string, NodeData>();
    const mock = createMockTrpc(data);
    const store = withCache(createRemoteTree(mock as any));

    await store.set({ $path: '/a', $type: 'test', v: 1 } as NodeData);
    mock.resetCalls();

    const node = await store.get('/a'); // should hit cache (write-populated)
    assert.equal(mock.getCalls, 0);
    assert.equal((node as any).v, 1);
  });

  it('inflight dedup: concurrent gets produce single tRPC call', async () => {
    const data = new Map<string, NodeData>();
    data.set('/a', { $path: '/a', $type: 'test', v: 99 } as NodeData);
    const mock = createMockTrpc(data);
    const store = withCache(createRemoteTree(mock as any));

    const results = await Promise.all(
      Array.from({ length: 5 }, () => store.get('/a')),
    );

    assert.equal(mock.getCalls, 1);
    for (const r of results) assert.equal((r as any).v, 99);
  });
});
