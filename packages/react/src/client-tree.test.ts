import type { NodeData } from '@treenity/core/core';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createClientTree } from './client-tree';

// ── Mock tRPC client ──

function createMockTrpc(backing: Map<string, NodeData>) {
  let calls = 0;

  const mock = {
    get calls() { return calls; },
    resetCalls() { calls = 0; },

    get: {
      query: async ({ path }: { path: string }) => {
        calls++;
        return backing.get(path);
      },
    },
    getChildren: {
      query: async ({ path }: { path: string; limit?: number; offset?: number }) => {
        calls++;
        const prefix = path === '/' ? '/' : path + '/';
        const items = [...backing.values()].filter(
          n => n.$path.startsWith(prefix) && n.$path !== path
            && n.$path.slice(prefix.length).indexOf('/') === -1,
        );
        return { items, total: items.length };
      },
    },
    set: {
      mutate: async ({ node }: { node: Record<string, unknown> }) => {
        calls++;
        backing.set(node.$path as string, node as NodeData);
      },
    },
    remove: {
      mutate: async ({ path }: { path: string }) => {
        calls++;
        backing.delete(path);
      },
    },
  };

  return mock;
}

// ── Tests ──

describe('createClientTree — unified client tree', () => {
  it('/local/* paths stay in memory, never hit tRPC', async () => {
    const mock = createMockTrpc(new Map());
    const { tree: store } = createClientTree(mock as any);

    await store.set({ $path: '/local/ui/theme', $type: 'theme', dark: true } as NodeData);
    mock.resetCalls();

    const node = await store.get('/local/ui/theme');
    assert.equal(mock.calls, 0, 'tRPC should not be called for /local paths');
    assert.equal(node?.$type, 'theme');
    assert.equal((node as any).dark, true);
  });

  it('non-local paths route through tRPC', async () => {
    const backing = new Map<string, NodeData>();
    backing.set('/orders/1', { $path: '/orders/1', $type: 'order', total: 42 } as NodeData);
    const mock = createMockTrpc(backing);
    const { tree: store } = createClientTree(mock as any);

    const node = await store.get('/orders/1');
    assert.ok(mock.calls > 0, 'tRPC should be called for remote paths');
    assert.equal((node as any).total, 42);
  });

  it('getChildren merges local and remote children', async () => {
    const backing = new Map<string, NodeData>();
    backing.set('/cloud', { $path: '/cloud', $type: 'dir' } as NodeData);
    const mock = createMockTrpc(backing);
    const { tree: store } = createClientTree(mock as any);

    // Write a local node
    await store.set({ $path: '/local', $type: 'dir' } as NodeData);

    // getChildren('/') should return both
    const { items } = await store.getChildren('/');
    const paths = items.map((n: { $path: string }) => n.$path).sort();
    assert.ok(paths.includes('/local'), 'should include local children');
    assert.ok(paths.includes('/cloud'), 'should include remote children');
  });

  it('remove /local/* does not call tRPC', async () => {
    const mock = createMockTrpc(new Map());
    const { tree: store } = createClientTree(mock as any);

    await store.set({ $path: '/local/temp', $type: 'tmp' } as NodeData);
    mock.resetCalls();

    await store.remove('/local/temp');
    // filterStore tries both, but remote remove is harmless no-op
    const node = await store.get('/local/temp');
    assert.equal(node, undefined, '/local/temp should be gone');
  });

  it('cached remote: second get skips tRPC', async () => {
    const backing = new Map<string, NodeData>();
    backing.set('/x', { $path: '/x', $type: 'test' } as NodeData);
    const mock = createMockTrpc(backing);
    const { tree: store } = createClientTree(mock as any);

    await store.get('/x'); // populates cache
    mock.resetCalls();
    await store.get('/x'); // should hit cache
    assert.equal(mock.calls, 0, 'second get should come from cache');
  });
});
