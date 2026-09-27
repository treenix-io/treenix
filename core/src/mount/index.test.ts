import { createNode, ref, register } from '#core';
import { OpError } from '#errors';
import { clearRegistry } from '#testing';
import { createMemoryTree, paginate, type Tree } from '#tree';
import { createFsTree } from '#tree/fs';
import { createQueryTree } from '#tree/query';
import { createRepathTree } from '#tree/repath';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { withMounts } from './index';
import { createTypesTree } from './types';

describe('Mounts', () => {
  let rootStore: Tree;
  let usersStore: Tree;

  beforeEach(() => {
    clearRegistry();
    rootStore = createMemoryTree();
    usersStore = createMemoryTree();
    register('test.mount.memory', 'mount', () => usersStore);
  });

  it('delegates get to mounted tree', async () => {
    await rootStore.set(
      createNode('/users', 'collection', {}, {
        mount: { $type: 'test.mount.memory' },
      }),
    );
    await usersStore.set(createNode('/users/alice', 'user'));

    const ms = withMounts(rootStore);
    const alice = await ms.get('/users/alice');
    assert.equal(alice?.$path, '/users/alice');
    assert.equal(alice?.$type, 't.user');
  });

  it('returns mount node from parent tree', async () => {
    await rootStore.set(
      createNode('/users', 'collection', {}, {
        mount: { $type: 'test.mount.memory' },
      }),
    );
    const ms = withMounts(rootStore);
    const node = await ms.get('/users');
    assert.equal(node?.$type, 't.collection');
  });

  it('delegates getChildren to mounted tree', async () => {
    await rootStore.set(
      createNode('/users', 'collection', {}, {
        mount: { $type: 'test.mount.memory' },
      }),
    );
    await usersStore.set(createNode('/users/alice', 'user'));
    await usersStore.set(createNode('/users/bob', 'user'));

    const ms = withMounts(rootStore);
    const children = await ms.getChildren('/users');
    assert.equal(children.items.length, 2);
  });

  // Regression (core-a4y): legacy adapter without native scanChildren must
  // still drive executeList — withMounts.scanChildren falls back to a single
  // getChildren page wrapped as an async generator. Was throwing
  // "Mount-resolved tree at /users does not expose scanChildren".
  it('scanChildren falls back to getChildren for adapters without scanChildren', async () => {
    const legacy: Tree = {
      async get(path) {
        if (path === '/users/alice') return createNode('/users/alice', 'user');
        if (path === '/users/bob') return createNode('/users/bob', 'user');
        return undefined;
      },
      async getChildren() {
        const items = [createNode('/users/alice', 'user'), createNode('/users/bob', 'user')];
        return { items, total: items.length };
      },
      async set() { return { changes: [] }; },
      async remove() { return { changes: [] }; },
      async patch() { return { changes: [] }; },
    };
    register('test.mount.legacy', 'mount', () => legacy);
    await rootStore.set(
      createNode('/users', 'collection', {}, {
        mount: { $type: 'test.mount.legacy' },
      }),
    );
    const ms = withMounts(rootStore);
    const collected: string[] = [];
    for await (const entry of ms.scanChildren!('/users')) {
      collected.push(entry.node.$path);
      assert.equal(entry.cursor, entry.node.$path);
    }
    assert.deepEqual(collected, ['/users/alice', '/users/bob']);
  });

  // core-35t / C13: the Tree-only fallback cannot honor a cursor — it always
  // restarts from page 1. Rather than silently hand a paginating caller a
  // duplicated page, it must reject `after` loudly.
  it('scanChildren fallback rejects a cursor (after) loudly on Tree-only mounts', async () => {
    const legacy: Tree = {
      async get() { return undefined; },
      async getChildren() {
        const items = [createNode('/users/alice', 'user')];
        return { items, total: items.length };
      },
      async set() { return { changes: [] }; },
      async remove() { return { changes: [] }; },
      async patch() { return { changes: [] }; },
    };
    register('test.mount.legacy2', 'mount', () => legacy);
    await rootStore.set(
      createNode('/users', 'collection', {}, { mount: { $type: 'test.mount.legacy2' } }),
    );
    const ms = withMounts(rootStore);
    await assert.rejects(
      async () => { for await (const _ of ms.scanChildren!('/users', { after: '/users/alice' })) { /* drain */ } },
      (e: unknown) => e instanceof OpError && e.code === 'BAD_REQUEST',
    );
  });

  // Regression core-anz4.16: limitHint applied as a hard getChildren limit
  // truncated the fallback at one page — a downstream filter dropping rows
  // then under-reported with no truncated flag. The fallback must keep
  // paging via nextCursor until the consumer stops pulling or the source
  // is exhausted.
  it('scanChildren fallback pages past limitHint until the source is exhausted', async () => {
    const nodes = Array.from({ length: 9 }, (_, i) =>
      createNode(`/users/u${i}`, i % 3 === 0 ? 'user' : 'ghost'));
    const userType = nodes[0].$type;
    let calls = 0;
    const legacy: Tree = {
      async get() { return undefined; },
      async getChildren(_path, opts) {
        calls++;
        return paginate(nodes, { limit: opts?.limit, cursor: opts?.cursor });
      },
      async set() { return { changes: [] }; },
      async remove() { return { changes: [] }; },
      async patch() { return { changes: [] }; },
    };
    register('test.mount.legacy3', 'mount', () => legacy);
    await rootStore.set(
      createNode('/users', 'collection', {}, { mount: { $type: 'test.mount.legacy3' } }),
    );
    const ms = withMounts(rootStore);

    // Consumer filter drops 2/3 of rows and wants a page of 3 with limitHint 3
    // — must still fill the page by pulling more source pages.
    const matched: string[] = [];
    for await (const entry of ms.scanChildren!('/users', { limitHint: 3 })) {
      if (entry.node.$type === userType) matched.push(entry.node.$path);
      if (matched.length === 3) break;
    }
    assert.deepEqual(matched, ['/users/u0', '/users/u3', '/users/u6']);
    assert.ok(calls > 1);

    // Full drain crosses page boundaries without skip or duplicate.
    const all: string[] = [];
    for await (const e of ms.scanChildren!('/users', { limitHint: 4 })) all.push(e.node.$path);
    assert.deepEqual(all, nodes.map(n => n.$path));
  });

  it('delegates set to mounted tree', async () => {
    await rootStore.set(
      createNode('/users', 'collection', {}, {
        mount: { $type: 'test.mount.memory' },
      }),
    );
    const ms = withMounts(rootStore);
    await ms.set(createNode('/users/charlie', 'user'));
    const charlie = await usersStore.get('/users/charlie');
    assert.equal(charlie?.$type, 't.user');
  });

  it('delegates remove to mounted tree', async () => {
    await rootStore.set(
      createNode('/users', 'collection', {}, {
        mount: { $type: 'test.mount.memory' },
      }),
    );
    await usersStore.set(createNode('/users/alice', 'user'));
    const ms = withMounts(rootStore);
    const removed = await ms.remove('/users/alice');
    assert.ok(removed.changes?.length);
    assert.equal(await usersStore.get('/users/alice'), undefined);
  });

  it('falls back to root tree for unmounted paths', async () => {
    await rootStore.set(createNode('/config', 'settings'));
    const ms = withMounts(rootStore);
    const config = await ms.get('/config');
    assert.equal(config?.$type, 't.settings');
  });

  it('caches resolved stores', async () => {
    let callCount = 0;
    clearRegistry();
    register('test.mount.counting', 'mount', () => {
      callCount++;
      return usersStore;
    });
    await rootStore.set(
      createNode('/users', 'collection', {}, {
        mount: { $type: 'test.mount.counting' },
      }),
    );
    const ms = withMounts(rootStore);
    await ms.get('/users/alice');
    await ms.get('/users/bob');
    assert.equal(callCount, 1);
  });

  it('caches resolved stores for getChildren on the mount path', async () => {
    let callCount = 0;
    clearRegistry();
    register('test.mount.countingChildren', 'mount', () => {
      callCount++;
      return usersStore;
    });
    await rootStore.set(
      createNode('/users', 'collection', {}, {
        mount: { $type: 'test.mount.countingChildren' },
      }),
    );
    await usersStore.set(createNode('/users/alice', 'user'));

    const ms = withMounts(rootStore);
    await ms.getChildren('/users');
    await ms.getChildren('/users');

    assert.equal(callCount, 1);
  });

  // TODO: ref-mount where ref-target $type IS the adapter — needs rethink after MountAdapter<T> refactor
  it('resolves mount via $ref to config node', async () => {
    register('test.ref.store', 'mount', () => usersStore);
    await rootStore.set({
      ...createNode('/mnt/users', 'mount-point'),
      '#mount': { $type: 'test.ref.store' },
    });
    await rootStore.set(
      createNode('/users', 'collection', {}, {
        mount: ref('/mnt/users'),
      }),
    );
    await usersStore.set(createNode('/users/alice', 'user'));

    const ms = withMounts(rootStore);
    const alice = await ms.get('/users/alice');
    assert.equal(alice?.$path, '/users/alice');
    assert.equal(alice?.$type, 't.user');
  });

  it('ref mount delegates set and getChildren', async () => {
    register('test.ref.store', 'mount', () => usersStore);
    await rootStore.set({
      ...createNode('/mnt/users', 'mount-point'),
      '#mount': { $type: 'test.ref.store' },
    });
    await rootStore.set(
      createNode('/users', 'collection', {}, {
        mount: ref('/mnt/users'),
      }),
    );

    const ms = withMounts(rootStore);
    await ms.set(createNode('/users/bob', 'user'));
    const children = await ms.getChildren('/users');
    assert.equal(children.items.length, 1);
    assert.equal(children.items[0].$path, '/users/bob');
  });

  it('throws on broken $ref', async () => {
    await rootStore.set(
      createNode('/users', 'collection', {}, {
        mount: ref('/mnt/nonexistent'),
      }),
    );
    const ms = withMounts(rootStore);
    await assert.rejects(() => ms.get('/users/alice'));
  });

  // ── Root mount ──

  it('root mount: delegates children to mounted tree', async () => {
    const dataStore = createMemoryTree();
    await dataStore.set(createNode('/foo', 'item'));
    await dataStore.set(createNode('/bar', 'item'));
    register('test.mount.data', 'mount', () => dataStore);

    await rootStore.set(
      createNode('/', 'root', {}, {
        mount: { $type: 'test.mount.data' },
      }),
    );
    const ms = withMounts(rootStore);
    const children = await ms.getChildren('/');
    assert.equal(children.items.length, 2);
  });

  it('root mount: get(/) returns root config node from bootstrap', async () => {
    const dataStore = createMemoryTree();
    register('test.mount.data', 'mount', () => dataStore);
    await rootStore.set(
      createNode('/', 'root', {}, {
        mount: { $type: 'test.mount.data' },
      }),
    );
    const ms = withMounts(rootStore);
    const root = await ms.get('/');
    assert.equal(root?.$type, 't.root');
  });

  it('root mount: get delegates to mounted tree', async () => {
    const dataStore = createMemoryTree();
    await dataStore.set(createNode('/hello', 'greeting'));
    register('test.mount.data', 'mount', () => dataStore);
    await rootStore.set(
      createNode('/', 'root', {}, {
        mount: { $type: 'test.mount.data' },
      }),
    );
    const ms = withMounts(rootStore);
    const node = await ms.get('/hello');
    assert.equal(node?.$type, 't.greeting');
  });

  it('root mount: set writes to mounted tree', async () => {
    const dataStore = createMemoryTree();
    register('test.mount.data', 'mount', () => dataStore);
    await rootStore.set(
      createNode('/', 'root', {}, {
        mount: { $type: 'test.mount.data' },
      }),
    );
    const ms = withMounts(rootStore);
    await ms.set(createNode('/new', 'item'));
    assert.equal((await dataStore.get('/new'))?.$type, 't.item');
  });

  // Only mounts AT or UNDER /sys/trash are inert (core-anz4.8). Ancestors above
  // it resolve as usual: a mounted root owns the trash, or soft-deleted nodes
  // land in the bootstrap memory tree and die on restart.
  it('root mount: trash lands in the mounted root, not in bootstrap', async () => {
    const dataStore = createMemoryTree();
    register('test.mount.data', 'mount', () => dataStore);
    await rootStore.set(createNode('/', 'root', {}, { mount: { $type: 'test.mount.data' } }));
    const ms = withMounts(rootStore);

    await ms.set(createNode('/sys/trash/e1', 'dir'));
    assert.ok(await dataStore.get('/sys/trash/e1'));
    assert.equal(await rootStore.get('/sys/trash/e1'), undefined);
    assert.equal((await ms.getChildren('/sys/trash')).items.length, 1);
  });

  it('a mount point inside trash stays inert', async () => {
    let resolved = 0;
    register('test.mount.spy', 'mount', () => { resolved++; return createMemoryTree(); });
    await rootStore.set(createNode('/sys/trash/e1/ext', 'dir', {}, { mount: { $type: 'test.mount.spy' } }));
    const ms = withMounts(rootStore);

    await ms.get('/sys/trash/e1/ext/child');
    await ms.getChildren('/sys/trash/e1/ext');
    assert.equal(resolved, 0);
  });

  // ── Nested mounts ──

  it('nested mount: root + child mount', async () => {
    const dataStore = createMemoryTree();
    const specialStore = createMemoryTree();
    await specialStore.set(createNode('/special/a', 'special-item'));

    register('test.mount.data', 'mount', () => dataStore);
    register('test.mount.special', 'mount', () => specialStore);

    // Root mounts to dataStore
    await rootStore.set(
      createNode('/', 'root', {}, {
        mount: { $type: 'test.mount.data' },
      }),
    );
    // /special mount config lives in dataStore (nested)
    await dataStore.set(
      createNode('/special', 'mount-point', {}, {
        mount: { $type: 'test.mount.special' },
      }),
    );

    const ms = withMounts(rootStore);
    // /special mount config from dataStore
    const mountNode = await ms.get('/special');
    assert.equal(mountNode?.$type, 't.mount-point');
    // /special/a comes from specialStore
    const a = await ms.get('/special/a');
    assert.equal(a?.$type, 't.special-item');
    // children of /special from specialStore
    const children = await ms.getChildren('/special');
    assert.equal(children.items.length, 1);
  });

  it('nested mount: adapter receives parent tree as deps', async () => {
    const dataStore = createMemoryTree();
    let receivedDeps: unknown = null;
    register('test.mount.data', 'mount', () => dataStore);
    register('test.mount.spy', 'mount', (_mount: unknown, ctx: any) => {
      receivedDeps = ctx.parentStore;
      return createMemoryTree();
    });
    await rootStore.set(
      createNode('/', 'root', {}, {
        mount: { $type: 'test.mount.data' },
      }),
    );
    await dataStore.set(
      createNode('/sub', 'mount-point', {}, {
        mount: { $type: 'test.mount.spy' },
      }),
    );
    const ms = withMounts(rootStore);
    await ms.get('/sub/x');
    // The spy adapter should have received dataStore (parent mount)
    assert.equal(receivedDeps, dataStore);
  });

  it('disabled mount is not resolved', async () => {
    await rootStore.set(
      createNode('/catalog', 'dir', {}, {
        mount: { $type: 'test.mount.memory', disabled: true },
      }),
    );
    await usersStore.set(createNode('/catalog/item', 'thing'));

    const ms = withMounts(rootStore);
    // Mount is disabled — should NOT delegate to usersStore
    const item = await ms.get('/catalog/item');
    assert.equal(item, undefined);

    // The mount-point node itself should still be readable
    const node = await ms.get('/catalog');
    assert.equal(node?.$type, 't.dir');
    assert.equal((node?.['#mount'] as Record<string, unknown>)?.disabled, true);
  });

  it('enabled mount still works normally', async () => {
    await rootStore.set(
      createNode('/active', 'dir', {}, {
        mount: { $type: 'test.mount.memory', disabled: false },
      }),
    );
    await usersStore.set(createNode('/active/item', 'thing'));

    const ms = withMounts(rootStore);
    const item = await ms.get('/active/item');
    assert.equal(item?.$path, '/active/item');
  });

  it('mount without disabled flag works as before', async () => {
    await rootStore.set(
      createNode('/normal', 'dir', {}, {
        mount: { $type: 'test.mount.memory' },
      }),
    );
    await usersStore.set(createNode('/normal/item', 'thing'));

    const ms = withMounts(rootStore);
    const item = await ms.get('/normal/item');
    assert.equal(item?.$path, '/normal/item');
  });

  it('keeps broken mount config editable without starting adapter', async () => {
    register('test.mount.needsRoot', 'mount', (mount: { root?: string }) => {
      if (!mount.root) throw new Error('test.mount.needsRoot: root required');
      return usersStore;
    });
    await rootStore.set(
      createNode('/broken', 'mount-point', {}, {
        mount: { $type: 'test.mount.needsRoot' },
      }),
    );

    const ms = withMounts(rootStore);
    const config = await ms.get('/broken');
    assert.equal(config?.$path, '/broken');
    assert.equal((config?.['#mount'] as { root?: string }).root, undefined);

    await ms.patch('/broken', [['r', '#mount.root', 'ok']]);
    await ms.set(createNode('/broken/item', 'thing'));

    const item = await usersStore.get('/broken/item');
    assert.equal(item?.$type, 't.thing');
  });

  it('keeps broken t.mount.fs config editable when root is empty', async () => {
    register('t.mount.fs', 'mount', (mount: { root?: string }) => {
      if (!mount.root) throw new Error('t.mount.fs: root required');
      return usersStore;
    });
    await rootStore.set(
      createNode('/fs', 'mount-point', {}, {
        mount: { $type: 't.mount.fs', root: '' },
      }),
    );

    const ms = withMounts(rootStore);
    assert.equal(((await ms.get('/fs'))?.['#mount'] as { root?: string }).root, '');
    await assert.rejects(() => ms.getChildren('/fs'), /t\.mount\.fs: root required/);

    await ms.patch('/fs', [['r', '#mount.root', 'ok']]);
    await ms.set(createNode('/fs/item', 'thing'));

    assert.equal((await usersStore.get('/fs/item'))?.$type, 't.thing');
  });

  it('throws loudly when writing inside a broken mount', async () => {
    register('test.mount.needsRoot', 'mount', (mount: { root?: string }) => {
      if (!mount.root) throw new Error('test.mount.needsRoot: root required');
      return usersStore;
    });
    await rootStore.set(
      createNode('/broken', 'mount-point', {}, {
        mount: { $type: 'test.mount.needsRoot' },
      }),
    );

    const ms = withMounts(rootStore);
    await assert.rejects(
      () => ms.set(createNode('/broken/item', 'thing')),
      /root required/,
    );
  });

  it('resolves mounted root for getChildren on the mount path', async () => {
    await rootStore.set(
      createNode('/mounted', 'mount-point', {}, {
        mount: { $type: 'test.mount.memory' },
      }),
    );
    await usersStore.set(createNode('/mounted/item', 'thing'));

    const ms = withMounts(rootStore);
    const children = await ms.getChildren('/mounted');

    assert.deepEqual(children.items.map(n => n.$path), ['/mounted/item']);
  });

  it('root mount invalidation clears nested mount cache entries', async () => {
    const rootA = createMemoryTree();
    const rootB = createMemoryTree();
    const nestedA = createMemoryTree();

    register('test.mount.rootSwitch', 'mount', (mount: { id: string }) => {
      return mount.id === 'a' ? rootA : rootB;
    });
    register('test.mount.nestedA', 'mount', () => nestedA);

    await rootStore.set(
      createNode('/', 'root', {}, {
        mount: { $type: 'test.mount.rootSwitch', id: 'a' },
      }),
    );
    await rootA.set(
      createNode('/special', 'mount-point', {}, {
        mount: { $type: 'test.mount.nestedA' },
      }),
    );
    await nestedA.set(createNode('/special/item', 'old'));
    await rootB.set(createNode('/special/item', 'new'));

    const ms = withMounts(rootStore);
    assert.equal((await ms.get('/special/item'))?.$type, 't.old');

    await ms.patch('/', [['r', '#mount.id', 'b']]);

    assert.equal((await ms.get('/special/item'))?.$type, 't.new');
  });

  it('invalidates $ref mount cache when ref target changes', async () => {
    const storeA = createMemoryTree();
    const storeB = createMemoryTree();
    register('test.mount.a', 'mount', () => storeA);
    register('test.mount.b', 'mount', () => storeB);

    await rootStore.set(
      createNode('/configs/users', 'mount-point', {}, {
        mount: { $type: 'test.mount.a' },
      }),
    );
    await rootStore.set(
      createNode('/users', 'collection', {}, {
        mount: ref('/configs/users'),
      }),
    );
    await storeA.set(createNode('/users/item', 'old'));
    await storeB.set(createNode('/users/item', 'new'));

    const ms = withMounts(rootStore);
    assert.equal((await ms.get('/users/item'))?.$type, 't.old');

    await ms.patch('/configs/users', [['r', '#mount', { $type: 'test.mount.b' }]]);

    assert.equal((await ms.get('/users/item'))?.$type, 't.new');
  });

  it('throws on mount component with unknown adapter type', async () => {
    await rootStore.set(
      createNode('/bad', 'mount-point', {}, {
        mount: { $type: 'test.mount.missing' },
      }),
    );

    const ms = withMounts(rootStore);
    await assert.rejects(() => ms.get('/bad/item'), /No adapter for type "test.mount.missing"/);
    await assert.rejects(() => ms.getChildren('/bad'), /No adapter for type "test.mount.missing"/);
  });
});

describe('Query mount (t.mount.query)', () => {
  let rootStore: Tree;
  let dataStore: Tree;

  beforeEach(() => {
    clearRegistry();
    rootStore = createMemoryTree();
    dataStore = createMemoryTree();
    register('test.mount.data', 'mount', () => dataStore);
    // Register query mount adapter (receives mount component + MountCtx)
    register('t.mount.query', 'mount', (_mount, ctx) => {
      return createQueryTree({ source: _mount.source, match: _mount.match }, ctx.parentStore);
    });
  });

  it('filters children by status component', async () => {
    await rootStore.set(
      createNode('/', 'root', {}, { mount: { $type: 'test.mount.data' } }),
    );
    // Orders with different statuses
    await dataStore.set({ $path: '/orders/a', $type: 'order', '#status': { $type: 'status', value: 'incoming' } } as any);
    await dataStore.set({ $path: '/orders/b', $type: 'order', '#status': { $type: 'status', value: 'kitchen' } } as any);
    await dataStore.set({ $path: '/orders/c', $type: 'order', '#status': { $type: 'status', value: 'incoming' } } as any);

    // Query mount config lives in dataStore (like a nested mount)
    await dataStore.set(
      createNode('/orders/incoming', 'mount-point', {}, {
        mount: { $type: 't.mount.query',  source: '/orders', match: { '#status.value': 'incoming' } },
      }),
    );

    const ms = withMounts(rootStore);
    const children = await ms.getChildren('/orders/incoming');

    assert.equal(children.items.length, 2);
    assert.deepEqual(children.items.map(n => n.$path).sort(), ['/orders/a', '/orders/c']);
  });

  it('returns empty when no matches', async () => {
    await rootStore.set(
      createNode('/', 'root', {}, { mount: { $type: 'test.mount.data' } }),
    );
    await dataStore.set({ $path: '/orders/a', $type: 'order', '#status': { $type: 'status', value: 'done' } } as any);
    await dataStore.set(
      createNode('/orders/incoming', 'mount-point', {}, {
        mount: { $type: 't.mount.query', source: '/orders', match: { '#status.value': 'incoming' } },
      }),
    );

    const ms = withMounts(rootStore);
    const children = await ms.getChildren('/orders/incoming');

    assert.equal(children.items.length, 0);
  });

  it('mount config node accessible via get', async () => {
    await rootStore.set(
      createNode('/', 'root', {}, { mount: { $type: 'test.mount.data' } }),
    );
    await dataStore.set(
      createNode('/orders/incoming', 'mount-point', {}, {
        mount: { $type: 't.mount.query', source: '/orders', match: { '#status.value': 'incoming' } },
      }),
    );

    const ms = withMounts(rootStore);
    const node = await ms.get('/orders/incoming');

    assert.equal(node?.$type, 't.mount-point');
  });
});

describe('Types mount adapter', () => {
  let backingStore: Tree;

  beforeEach(() => {
    clearRegistry();
    backingStore = createMemoryTree();
  });

  it('returns registered type as node', async () => {
    register('test.block.hero', 'schema', () => ({
      title: 'Hero', type: 'object' as const,
      properties: { title: { type: 'string' } },
    }));
    const ts = createTypesTree(backingStore, '/types');
    const node = await ts.get('/types/test/block/hero');
    assert.equal(node?.$type, 't.type');
    assert.equal(node?.$path, '/types/test/block/hero');
    const schema = node?.['#schema'] as { title: string };
    assert.equal(schema.title, 'Hero');
  });

  it('getChildren /types returns vendor folders', async () => {
    register('test.block.hero', 'schema', () => ({ title: 'Hero', type: 'object' as const, properties: {} }));
    register('test.block.text', 'schema', () => ({ title: 'Text', type: 'object' as const, properties: {} }));
    const ts = createTypesTree(backingStore, '/types');
    const children = await ts.getChildren('/types');
    const testFolder = children.items.find(n => n.$path === '/types/test');
    assert.ok(testFolder, '/types/test folder should exist');
    assert.equal(testFolder.$type, 't.dir');
  });

  it('getChildren returns type nodes in category', async () => {
    register('test.block.hero', 'schema', () => ({ title: 'Hero', type: 'object' as const, properties: {} }));
    register('test.block.text', 'schema', () => ({ title: 'Text', type: 'object' as const, properties: {} }));
    const ts = createTypesTree(backingStore, '/types');
    const children = await ts.getChildren('/types/test/block');
    assert.equal(children.items.length, 2);
    const names = children.items.map((n) => n.$path).sort();
    assert.deepEqual(names, ['/types/test/block/hero', '/types/test/block/text']);
  });

  it('get category folder returns dir node', async () => {
    register('test.block.hero', 'schema', () => ({ title: 'Hero', type: 'object' as const, properties: {} }));
    const ts = createTypesTree(backingStore, '/types');
    const node = await ts.get('/types/test/block');
    assert.equal(node?.$type, 't.dir');
  });

  it('falls back to backing tree for dynamic types', async () => {
    await backingStore.set(createNode('/types/custom/card', 'type'));
    const ts = createTypesTree(backingStore, '/types');
    const node = await ts.get('/types/custom/card');
    assert.equal(node?.$type, 't.type');
  });

  it('merges registry and stored types in getChildren', async () => {
    register('test.block.hero', 'schema', () => ({ title: 'Hero', type: 'object' as const, properties: {} }));
    await backingStore.set(createNode('/types/custom', 'dir'));
    const ts = createTypesTree(backingStore, '/types');
    const children = await ts.getChildren('/types');
    const paths = children.items.map(n => n.$path);
    assert.ok(paths.includes('/types/test'), '/types/test should exist');
    assert.ok(paths.includes('/types/custom'), '/types/custom should exist');
  });

  it('registry wins on conflict', async () => {
    register('test.block.hero', 'schema', () => ({
      title: 'Hero from registry', type: 'object' as const, properties: {},
    }));
    await backingStore.set(createNode('/types/test/block/hero', 'type'));
    const ts = createTypesTree(backingStore, '/types');
    const node = await ts.get('/types/test/block/hero');
    const schema = node?.['#schema'] as { title: string };
    assert.equal(schema.title, 'Hero from registry');
  });

  it('type node includes all registered contexts', async () => {
    register('test.block.hero', 'schema', () => ({
      title: 'Hero',
      type: 'object' as const,
      properties: {},
    }));
    register('test.block.hero', 'react', () => 'react-component');
    register('test.block.hero', 'react:edit', () => 'react-component');
    const ts = createTypesTree(backingStore, '/types');
    const node = await ts.get('/types/test/block/hero');
    assert.equal(node?.$type, 't.type');
    const schema = node?.['#schema'] as { $type: string; title: string };
    assert.equal(schema.$type, 'schema');
    assert.equal(schema.title, 'Hero');
    const react = node?.['#react'] as { $type: string };
    assert.equal(react.$type, 'react');
    const reactEdit = node?.['#react:edit'] as { $type: string };
    assert.equal(reactEdit.$type, 'react:edit');
  });

  it('set goes to backing tree', async () => {
    const ts = createTypesTree(backingStore, '/types');
    await ts.set(createNode('/types/custom/card', 'type'));
    const stored = await backingStore.get('/types/custom/card');
    assert.equal(stored?.$type, 't.type');
  });

  it('remove deletes dynamic type from backing tree', async () => {
    const ts = createTypesTree(backingStore, '/types');
    await ts.set(createNode('/types/custom/card', 'type'));
    const removed = await ts.remove('/types/custom/card');
    assert.ok(removed.changes?.length);
    assert.equal(await backingStore.get('/types/custom/card'), undefined);
  });

  it('remove throws on registry type', async () => {
    register('test.block.hero', 'schema', () => ({ title: 'Hero', type: 'object' as const, properties: {} }));
    const ts = createTypesTree(backingStore, '/types');
    await assert.rejects(() => ts.remove('/types/test/block/hero'));
  });

  it('dynamic type visible via get after set', async () => {
    const ts = createTypesTree(backingStore, '/types');
    const card = createNode('/types/custom/card', 'type', {}, {
      schema: { $type: 'schema', title: 'Card', type: 'object', properties: {} },
    });
    await ts.set(card);
    const node = await ts.get('/types/custom/card');
    assert.equal(node?.$type, 't.type');
    const schema = node?.['#schema'] as { title: string };
    assert.equal(schema.title, 'Card');
  });

  it('dynamic type appears in getChildren', async () => {
    const ts = createTypesTree(backingStore, '/types');
    await ts.set(createNode('/types/custom/card', 'type'));
    await ts.set(createNode('/types/custom/list', 'type'));
    const children = await ts.getChildren('/types/custom');
    assert.equal(children.items.length, 2);
    const paths = children.items.map((n) => n.$path).sort();
    assert.deepEqual(paths, ['/types/custom/card', '/types/custom/list']);
  });

  it('getChildren merges dynamic and registry in same category', async () => {
    register('test.block.hero', 'schema', () => ({ title: 'Hero', type: 'object' as const, properties: {} }));
    await backingStore.set(createNode('/types/test/block/custom-block', 'type'));
    const ts = createTypesTree(backingStore, '/types');
    const children = await ts.getChildren('/types/test/block');
    assert.equal(children.items.length, 2);
    const paths = children.items.map((n) => n.$path).sort();
    assert.deepEqual(paths, [
      '/types/test/block/custom-block',
      '/types/test/block/hero',
    ]);
  });
});

// Regression: FS mount at nested path should not duplicate prefix in file paths
describe('FS mount repath (dedicated)', () => {
  let rootStore: Tree;
  let tmpDir: string;

  beforeEach(async () => {
    clearRegistry();
    rootStore = createMemoryTree();
    tmpDir = await mkdtemp(join(tmpdir(), 'treenix-fs-mount-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('dedicated FS mount stores files without mount prefix', async () => {
    const fsTree = await createFsTree(tmpDir);
    const repathed = createRepathTree(fsTree, '/data/files', '/');

    register('test.mount.fs', 'mount', () => repathed);
    await rootStore.set(
      createNode('/data/files', 'mount-point', {}, {
        mount: { $type: 'test.mount.fs' },
      }),
    );

    const ms = withMounts(rootStore);
    await ms.set(createNode('/data/files/doc', 'document'));

    // FS dir should contain doc.json, NOT data/files/doc.json
    const entries = await readdir(tmpDir);
    assert.ok(entries.includes('doc.json'), `expected doc.json in ${tmpDir}, got: ${entries}`);

    // Read back through mount — path should be full tree path
    const node = await ms.get('/data/files/doc');
    assert.equal(node?.$path, '/data/files/doc');
    assert.equal(node?.$type, 't.document');
  });

  it('getChildren returns full tree paths', async () => {
    const fsTree = await createFsTree(tmpDir);
    const repathed = createRepathTree(fsTree, '/data/files', '/');

    register('test.mount.fs', 'mount', () => repathed);
    await rootStore.set(
      createNode('/data/files', 'mount-point', {}, {
        mount: { $type: 'test.mount.fs' },
      }),
    );

    const ms = withMounts(rootStore);
    await ms.set(createNode('/data/files/a', 'item'));
    await ms.set(createNode('/data/files/b', 'item'));

    const children = await ms.getChildren('/data/files');
    assert.equal(children.items.length, 2);
    const paths = children.items.map(n => n.$path).sort();
    assert.deepEqual(paths, ['/data/files/a', '/data/files/b']);
  });

  // Lifecycle: external-watch consumers MUST be aborted whenever their
  // mount cache entry leaves the cache — by explicit invalidation OR by
  // FIFO eviction when cacheMax fills up. The bounded-cache onEvict path
  // is what makes FIFO-safe; before that, FIFO drops silently leaked
  // change-stream cursors + timers + onSelfWrite subscriptions.

  describe('external-watch lifecycle', () => {
    it('FIFO eviction aborts the external-watch consumer (no leak)', async () => {
      const root = createMemoryTree();
      await root.set(createNode('/m1', 'mount-point', {}, {
        mount: { $type: 'test.mount.lifecycle' },
      }));
      await root.set(createNode('/m2', 'mount-point', {}, {
        mount: { $type: 'test.mount.lifecycle' },
      }));

      const aborts: string[] = [];
      register('test.mount.lifecycle', 'mount', (_m, ctx) => {
        const fake: Tree = createMemoryTree();
        if (ctx.startExternalWatch) {
          ctx.startExternalWatch(fake, { pathPrefix: ctx.path, source: `at:${ctx.path}` });
        }
        return fake;
      });

      const ms = withMounts(root, {
        cacheMax: 1,
        startExternalWatch: (_tree, opts) => () => aborts.push(opts.source),
      });

      // getChildren on the mount path runs resolveContentTree which caches
      // the resolved mount entry (and starts the external watch).
      await ms.getChildren('/m1');
      assert.equal(aborts.length, 0);

      // Resolving /m2 forces FIFO eviction of /m1 — onEvict on bounded-cache
      // fires the abort attached to /m1's entry.
      await ms.getChildren('/m2');
      assert.deepEqual(aborts, ['at:/m1']);
    });

    it('mount config rewrite invalidates cache → onEvict aborts external-watch', async () => {
      const root = createMemoryTree();
      await root.set(createNode('/m', 'mount-point', {}, {
        mount: { $type: 'test.mount.invalidate' },
      }));

      const aborts: string[] = [];
      register('test.mount.invalidate', 'mount', (_m, ctx) => {
        const fake: Tree = createMemoryTree();
        if (ctx.startExternalWatch) {
          ctx.startExternalWatch(fake, { pathPrefix: ctx.path, source: 'inv' });
        }
        return fake;
      });

      const ms = withMounts(root, {
        startExternalWatch: (_tree, opts) => () => aborts.push(opts.source),
      });

      // Cache the mount via getChildren.
      await ms.getChildren('/m');
      assert.equal(aborts.length, 0);

      // Rewrite the mount node itself — the cache key '/m' is invalidated
      // (write touches the mount path), onEvict fires the abort.
      await ms.set(createNode('/m', 'mount-point', {}, {
        mount: { $type: 'test.mount.invalidate' },
      }));
      assert.deepEqual(aborts, ['inv']);
    });

    it('exposes invalidateMount publicly — external callers can evict adapter cache', async () => {
      const root = createMemoryTree();
      await root.set(createNode('/m', 'mount-point', {}, {
        mount: { $type: 'test.mount.public-invalidate' },
      }));

      const aborts: string[] = [];
      register('test.mount.public-invalidate', 'mount', (_m, ctx) => {
        const fake: Tree = createMemoryTree();
        if (ctx.startExternalWatch) {
          ctx.startExternalWatch(fake, { pathPrefix: ctx.path, source: 'pub-inv' });
        }
        return fake;
      });

      const ms = withMounts(root, {
        startExternalWatch: (_tree, opts) => () => aborts.push(opts.source),
      });

      await ms.getChildren('/m');
      assert.equal(aborts.length, 0);

      // External caller (createPipeline external-watch consumer) drops the
      // mount cache without going through tree.set/remove/patch.
      ms.invalidateMount('/m');
      assert.deepEqual(aborts, ['pub-inv']);
    });

    it('invalidateMount("/") clears every cached mount', async () => {
      const root = createMemoryTree();
      await root.set(createNode('/a', 'mount-point', {}, { mount: { $type: 'test.mount.bulk' } }));
      await root.set(createNode('/b', 'mount-point', {}, { mount: { $type: 'test.mount.bulk' } }));

      const aborts: string[] = [];
      register('test.mount.bulk', 'mount', (_m, ctx) => {
        const fake: Tree = createMemoryTree();
        if (ctx.startExternalWatch) {
          ctx.startExternalWatch(fake, { pathPrefix: ctx.path, source: `bulk:${ctx.path}` });
        }
        return fake;
      });

      const ms = withMounts(root, {
        startExternalWatch: (_tree, opts) => () => aborts.push(opts.source),
      });

      await ms.getChildren('/a');
      await ms.getChildren('/b');
      assert.equal(aborts.length, 0);

      ms.invalidateMount('/');
      assert.deepEqual(aborts.sort(), ['bulk:/a', 'bulk:/b']);
    });
  });

});

describe('resolveActionTree (core-pxlu)', () => {
  let rootStore: Tree;

  beforeEach(() => {
    clearRegistry();
    rootStore = createMemoryTree();
    register('test.mount.plain', 'mount', () => createMemoryTree());
    register('test.mount.exec', 'mount', () => ({
      ...createMemoryTree(),
      execute: async () => 'remote',
    }));
  });

  it('returns the mounted subtree when it exposes execute (foreign authority)', async () => {
    await rootStore.set(createNode('/fed', 'dir', {}, { mount: { $type: 'test.mount.exec' } }));

    const ms = withMounts(rootStore);
    const t = await ms.resolveActionTree('/fed/w');

    assert.ok(t);
    assert.ok(t.execute, 'resolved subtree carries the capability');
    assert.equal(await t.execute!('/fed/w', 'x'), 'remote');
  });

  it('returns undefined for storage mounts (no execute)', async () => {
    await rootStore.set(createNode('/users', 'collection', {}, { mount: { $type: 'test.mount.plain' } }));

    const ms = withMounts(rootStore);
    assert.equal(await ms.resolveActionTree('/users/alice'), undefined);
  });

  it('returns undefined for unmounted paths', async () => {
    await rootStore.set(createNode('/plain', 'dir'));

    const ms = withMounts(rootStore);
    assert.equal(await ms.resolveActionTree('/plain/x'), undefined);
  });

  it('action on the mount node itself is local (strict ancestors)', async () => {
    await rootStore.set(createNode('/fed', 'dir', {}, { mount: { $type: 'test.mount.exec' } }));

    const ms = withMounts(rootStore);
    assert.equal(await ms.resolveActionTree('/fed'), undefined);
  });
});
