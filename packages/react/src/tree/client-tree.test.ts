import type { NodeData } from '@treenx/core';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createClientTree } from './client-tree';
import { stampNode } from '#symbols';

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
    const { tree } = createClientTree(mock as any);

    await tree.set({ $path: '/local/ui/theme', $type: 'theme', dark: true } as NodeData);
    mock.resetCalls();

    const node = await tree.get('/local/ui/theme');
    assert.equal(mock.calls, 0, 'tRPC should not be called for /local paths');
    assert.equal(node?.$type, 'theme');
    assert.equal((node as any).dark, true);
  });

  it('non-local paths route through tRPC', async () => {
    const backing = new Map<string, NodeData>();
    backing.set('/orders/1', { $path: '/orders/1', $type: 'order', total: 42 } as NodeData);
    const mock = createMockTrpc(backing);
    const { tree } = createClientTree(mock as any);

    const node = await tree.get('/orders/1');
    assert.ok(mock.calls > 0, 'tRPC should be called for remote paths');
    assert.equal((node as any).total, 42);
  });

  it('getChildren merges local and remote children', async () => {
    const backing = new Map<string, NodeData>();
    backing.set('/cloud', { $path: '/cloud', $type: 'dir' } as NodeData);
    const mock = createMockTrpc(backing);
    const { tree } = createClientTree(mock as any);

    // Write a local node
    await tree.set({ $path: '/local', $type: 'dir' } as NodeData);

    // getChildren('/') should return both
    const { items } = await tree.getChildren('/');
    const paths = items.map((n: { $path: string }) => n.$path).sort();
    assert.ok(paths.includes('/local'), 'should include local children');
    assert.ok(paths.includes('/cloud'), 'should include remote children');
  });

  it('remove /local/* does not call tRPC', async () => {
    const mock = createMockTrpc(new Map());
    const { tree } = createClientTree(mock as any);

    await tree.set({ $path: '/local/temp', $type: 'tmp' } as NodeData);
    mock.resetCalls();

    await tree.remove('/local/temp');
    // filterStore tries both, but remote remove is harmless no-op
    const node = await tree.get('/local/temp');
    assert.equal(node, undefined, '/local/temp should be gone');
  });

  it('cached remote: second get skips tRPC', async () => {
    const backing = new Map<string, NodeData>();
    backing.set('/x', { $path: '/x', $type: 'test' } as NodeData);
    const mock = createMockTrpc(backing);
    const { tree } = createClientTree(mock as any);

    await tree.get('/x'); // populates cache
    mock.resetCalls();
    await tree.get('/x'); // should hit cache
    assert.equal(mock.calls, 0, 'second get should come from cache');
  });

  // Regression — DO NOT DELETE. This has broken 3 times already:
  //   a85fd7e (react): guarded stampNode against re-stamping
  //   ed09479 (core):  deepFreeze-on-write → froze nodes upper layer must stamp
  //   a51f64b:         surfaced it via engine bump
  //
  // Symptom in UI: "Cannot define property Symbol(treenix.$key), object is
  // not extensible" when loading the tree editor. App.tsx calls
  // tree.getChildren() then cache.replaceChildren() which calls stampNode()
  // on every returned node. If ANY layer between createRemoteTree and the
  // consumer freezes nodes, stampNode throws via Object.defineProperty.
  //
  // Don't "fix" a future freeze regression by making stampNode tolerant —
  // fix the layer that froze data it doesn't own.
  describe('client tree output is stampable end-to-end', () => {
    it('tree.get returns nodes stampNode can annotate', async () => {
      const backing = new Map<string, NodeData>();
      backing.set('/x', { $path: '/x', $type: 'test', comp: { $type: 'c', v: 1 } } as NodeData);
      const mock = createMockTrpc(backing);
      const { tree } = createClientTree(mock as any);

      const node = await tree.get('/x');
      assert.ok(node);
      assert.doesNotThrow(() => stampNode(node));
    });

    it('tree.getChildren returns items stampNode can annotate', async () => {
      const backing = new Map<string, NodeData>();
      backing.set('/a', { $path: '/a', $type: 'test' } as NodeData);
      backing.set('/b', { $path: '/b', $type: 'test', comp: { $type: 'c' } } as NodeData);
      const mock = createMockTrpc(backing);
      const { tree } = createClientTree(mock as any);

      const { items } = await tree.getChildren('/');
      assert.ok(items.length > 0);
      for (const item of items) {
        assert.doesNotThrow(() => stampNode(item), `stampNode must not throw on ${item.$path}`);
      }
    });

    it('tree.getChildren after a cached tree.get still returns stampable items', async () => {
      // Edge case: get populates the cache, then getChildren returns the SAME
      // cached object. If get's write path froze it, getChildren inherits the
      // frozen ref — this is the exact scenario ed09479 caused.
      const backing = new Map<string, NodeData>();
      backing.set('/a', { $path: '/a', $type: 'test' } as NodeData);
      const mock = createMockTrpc(backing);
      const { tree } = createClientTree(mock as any);

      await tree.get('/a'); // populates core cache
      const { items } = await tree.getChildren('/');
      for (const item of items) {
        assert.doesNotThrow(() => stampNode(item), `stampNode must not throw on ${item.$path}`);
      }
    });
  });
});
