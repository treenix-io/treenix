import type { NodeData } from '@treenx/core';
import { applyOps, type PatchOp, type TreeEvent } from '@treenx/core/tree';
import { withCache } from '@treenx/core/tree/cache';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRemoteTree } from './remote-tree';

// ── Mock tRPC client ──

function createMockTrpc(backing: Map<string, NodeData>) {
  let getCalls = 0;
  let patchCalls = 0;
  // events: minimal sim of trpc.events.subscribe — caller-driven push.
  let lastOnData: ((e: TreeEvent) => void) | null = null;
  let unsubscribed = false;

  const mock = {
    get getCalls() { return getCalls; },
    get patchCalls() { return patchCalls; },
    resetCalls() { getCalls = 0; },

    // Test helpers — drive the events stream
    pushEvent(e: TreeEvent) { lastOnData?.(e); },
    get wasUnsubscribed() { return unsubscribed; },
    resetEvents() { lastOnData = null; unsubscribed = false; },

    get: {
      query: async ({ path }: { path: string }) => {
        getCalls++;
        return backing.get(path);
      },
    },
    getChildren: {
      query: async ({ path, limit }: { path: string; limit?: number }) => {
        getCalls++;
        const prefix = path === '/' ? '/' : path + '/';
        const items = [...backing.values()].filter(
          n => n.$path.startsWith(prefix) && n.$path !== path
            && n.$path.slice(prefix.length).indexOf('/') === -1,
        );
        const sliced = limit ? items.slice(0, limit) : items;
        return { items: sliced, total: items.length };
      },
    },
    set: {
      mutate: async ({ node }: { node: Record<string, unknown> }) => {
        backing.set(node.$path as string, node as NodeData);
      },
    },
    patch: {
      mutate: async ({ path, ops }: { path: string; ops: PatchOp[] }) => {
        patchCalls++;
        const node = structuredClone(backing.get(path));
        if (!node) throw new Error(`missing node: ${path}`);
        applyOps(node, ops);
        backing.set(path, node);
      },
    },
    remove: {
      mutate: async ({ path }: { path: string }) => {
        backing.delete(path);
      },
    },
    events: {
      subscribe(_: void, callbacks: { onData?(e: TreeEvent): void; onError?(err: unknown): void }) {
        lastOnData = callbacks.onData ?? null;
        return { unsubscribe() { unsubscribed = true; lastOnData = null; } };
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
    const tree = createRemoteTree(mock as any);

    const node = await tree.get('/a');
    assert.equal(node?.$path, '/a');
    assert.equal((node as any).v, 1);
    assert.equal(mock.getCalls, 1);
  });

  it('get returns undefined for missing path', async () => {
    const tree = createRemoteTree(createMockTrpc(new Map()) as any);
    const node = await tree.get('/missing');
    assert.equal(node, undefined);
  });

  it('getChildren delegates to trpc.getChildren.query', async () => {
    const data = new Map<string, NodeData>();
    data.set('/p', { $path: '/p', $type: 'dir' } as NodeData);
    data.set('/p/a', { $path: '/p/a', $type: 'test' } as NodeData);
    data.set('/p/b', { $path: '/p/b', $type: 'test' } as NodeData);
    const tree = createRemoteTree(createMockTrpc(data) as any);

    const result = await tree.getChildren('/p');
    assert.equal(result.items.length, 2);
    assert.equal(result.total, 2);
  });

  it('set delegates to trpc.set.mutate', async () => {
    const data = new Map<string, NodeData>();
    const tree = createRemoteTree(createMockTrpc(data) as any);

    await tree.set({ $path: '/x', $type: 'test', v: 42 } as NodeData);
    assert.ok(data.has('/x'));
    assert.equal((data.get('/x') as any).v, 42);
  });

  it('remove delegates to trpc.remove.mutate', async () => {
    const data = new Map<string, NodeData>();
    data.set('/x', { $path: '/x', $type: 'test' } as NodeData);
    const tree = createRemoteTree(createMockTrpc(data) as any);

    const result = await tree.remove('/x');
    assert.equal(result, true);
    assert.ok(!data.has('/x'));
  });

  it('patch delegates atomically without a get + set roundtrip', async () => {
    const data = new Map<string, NodeData>();
    data.set('/x', { $path: '/x', $type: 'test', value: 1 } as NodeData);
    const mock = createMockTrpc(data);
    const tree = createRemoteTree(mock as any);

    await tree.patch('/x', [['r', 'value', 2]]);

    assert.equal(mock.patchCalls, 1);
    assert.equal(mock.getCalls, 0);
    assert.equal((data.get('/x') as any).value, 2);
  });
});

describe('withCache(remoteStore) — client pipeline', () => {
  it('caches get results — second call skips tRPC', async () => {
    const data = new Map<string, NodeData>();
    data.set('/a', { $path: '/a', $type: 'test' } as NodeData);
    const mock = createMockTrpc(data);
    const tree = withCache(createRemoteTree(mock as any));

    await tree.get('/a');
    mock.resetCalls();
    await tree.get('/a'); // should hit cache
    assert.equal(mock.getCalls, 0);
  });

  it('write-populate: set warms cache for next get', async () => {
    const data = new Map<string, NodeData>();
    const mock = createMockTrpc(data);
    const tree = withCache(createRemoteTree(mock as any));

    await tree.set({ $path: '/a', $type: 'test', v: 1 } as NodeData);
    mock.resetCalls();

    const node = await tree.get('/a'); // should hit cache (write-populated)
    assert.equal(mock.getCalls, 0);
    assert.equal((node as any).v, 1);
  });

  it('inflight dedup: concurrent gets produce single tRPC call', async () => {
    const data = new Map<string, NodeData>();
    data.set('/a', { $path: '/a', $type: 'test', v: 99 } as NodeData);
    const mock = createMockTrpc(data);
    const tree = withCache(createRemoteTree(mock as any));

    const results = await Promise.all(
      Array.from({ length: 5 }, () => tree.get('/a')),
    );

    assert.equal(mock.getCalls, 1);
    for (const r of results) assert.equal((r as any).v, 99);
  });
});

// ── Part D: createRemoteTree.watch — Tree.watch via tRPC ──

describe('createRemoteTree.watch — pipes trpc.events to AsyncIterable', () => {
  it('exposes watch as an AsyncIterable<TreeEvent>', () => {
    const mock = createMockTrpc(new Map());
    const tree = createRemoteTree(mock as any);
    assert.equal(typeof tree.watch, 'function');
    const stream = tree.watch!({ kind: 'all' });
    assert.equal(typeof stream[Symbol.asyncIterator], 'function');
  });

  it('path scope yields ONLY exact-path matches; unsubscribes on close', async () => {
    const mock = createMockTrpc(new Map());
    const tree = createRemoteTree(mock as any);

    const stream = tree.watch!({ kind: 'path', path: '/a' });
    const it = stream[Symbol.asyncIterator]();
    const pump = it.next();
    await new Promise(r => setImmediate(r));

    mock.pushEvent({ type: 'set', path: '/other', node: { $type: 't' } });   // filtered out
    mock.pushEvent({ type: 'remove', path: '/a' });                          // matches

    const { value } = await pump;
    assert.ok(value && value.type === 'remove');
    if (value.type === 'remove') assert.equal(value.path, '/a');

    await it.return!();
    assert.equal(mock.wasUnsubscribed, true, 'sub.unsubscribe ran on iterator close');
  });

  it('children scope yields direct children only (parent + grandchild skipped)', async () => {
    const mock = createMockTrpc(new Map());
    const tree = createRemoteTree(mock as any);

    const stream = tree.watch!({ kind: 'children', path: '/parent' });
    const it = stream[Symbol.asyncIterator]();
    const pump = it.next();
    await new Promise(r => setImmediate(r));

    mock.pushEvent({ type: 'remove', path: '/parent' });          // parent — skipped
    mock.pushEvent({ type: 'remove', path: '/parent/x/y' });      // grandchild — skipped
    mock.pushEvent({ type: 'remove', path: '/parent/direct' });   // direct — yields

    const { value } = await pump;
    assert.ok(value && value.type === 'remove');
    if (value.type === 'remove') assert.equal(value.path, '/parent/direct');

    await it.return!();
  });

  it('strips VP fields from wire NodeEvent (TreeEvent has no addVps/rmVps/invalidateVps)', async () => {
    const mock = createMockTrpc(new Map());
    const tree = createRemoteTree(mock as any);

    const stream = tree.watch!({ kind: 'all' });
    const it = stream[Symbol.asyncIterator]();
    const pump = it.next();
    await new Promise(r => setImmediate(r));

    // Wire-shape event with VPs (NodeEvent at wire — must be stripped here)
    mock.pushEvent({
      type: 'set', path: '/x', node: { $type: 't' },
      addVps: ['/q/hot'], rmVps: ['/q/cold'], invalidateVps: ['/q/idx'],
    } as unknown as TreeEvent);

    const { value } = await pump;
    await it.return!();

    assert.ok(value);
    assert.equal(value.type, 'set');
    assert.ok(!('addVps' in value), 'addVps stripped');
    assert.ok(!('rmVps' in value), 'rmVps stripped');
    assert.ok(!('invalidateVps' in value), 'invalidateVps stripped');
  });

  it('reconnect events pass through regardless of scope', async () => {
    const mock = createMockTrpc(new Map());
    const tree = createRemoteTree(mock as any);

    const stream = tree.watch!({ kind: 'path', path: '/never-matched' });
    const it = stream[Symbol.asyncIterator]();
    const pump = it.next();
    await new Promise(r => setImmediate(r));

    mock.pushEvent({ type: 'reconnect', preserved: true });

    const { value } = await pump;
    await it.return!();

    assert.ok(value && value.type === 'reconnect');
    if (value.type === 'reconnect') assert.equal(value.preserved, true);
  });
});
