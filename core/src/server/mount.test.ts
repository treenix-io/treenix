import { createNode, ref, register } from '#core';
import { clearRegistry } from '#core/index.test';
import { createMemoryTree, type Tree } from '#tree';
import { createFsTree } from '#tree/fs';
import { createQueryTree } from '#tree/query';
import { createRepathTree } from '#tree/repath';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { withMounts } from './mount';
import { createTypesStore } from './types-mount';

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
    assert.equal(removed, true);
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

  // TODO: ref-mount where ref-target $type IS the adapter — needs rethink after MountAdapter<T> refactor
  it('resolves mount via $ref to config node', async () => {
    register('test.ref.store', 'mount', () => usersStore);
    await rootStore.set({
      ...createNode('/mnt/users', 'mount-point'),
      mount: { $type: 'test.ref.store' },
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
      mount: { $type: 'test.ref.store' },
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
    assert.equal((node?.mount as Record<string, unknown>)?.disabled, true);
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
    await dataStore.set({ $path: '/orders/a', $type: 'order', status: { $type: 'status', value: 'incoming' } } as any);
    await dataStore.set({ $path: '/orders/b', $type: 'order', status: { $type: 'status', value: 'kitchen' } } as any);
    await dataStore.set({ $path: '/orders/c', $type: 'order', status: { $type: 'status', value: 'incoming' } } as any);

    // Query mount config lives in dataStore (like a nested mount)
    await dataStore.set(
      createNode('/orders/incoming', 'mount-point', {}, {
        mount: { $type: 't.mount.query',  source: '/orders', match: { 'status.value': 'incoming' } },
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
    await dataStore.set({ $path: '/orders/a', $type: 'order', status: { $type: 'status', value: 'done' } } as any);
    await dataStore.set(
      createNode('/orders/incoming', 'mount-point', {}, {
        mount: { $type: 't.mount.query', source: '/orders', match: { 'status.value': 'incoming' } },
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
        mount: { $type: 't.mount.query', source: '/orders', match: { 'status.value': 'incoming' } },
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
    const ts = createTypesStore(backingStore, '/types');
    const node = await ts.get('/types/test/block/hero');
    assert.equal(node?.$type, 't.type');
    assert.equal(node?.$path, '/types/test/block/hero');
    const schema = node?.schema as { title: string };
    assert.equal(schema.title, 'Hero');
  });

  it('getChildren /types returns vendor folders', async () => {
    register('test.block.hero', 'schema', () => ({ title: 'Hero', type: 'object' as const, properties: {} }));
    register('test.block.text', 'schema', () => ({ title: 'Text', type: 'object' as const, properties: {} }));
    const ts = createTypesStore(backingStore, '/types');
    const children = await ts.getChildren('/types');
    const testFolder = children.items.find(n => n.$path === '/types/test');
    assert.ok(testFolder, '/types/test folder should exist');
    assert.equal(testFolder.$type, 't.dir');
  });

  it('getChildren returns type nodes in category', async () => {
    register('test.block.hero', 'schema', () => ({ title: 'Hero', type: 'object' as const, properties: {} }));
    register('test.block.text', 'schema', () => ({ title: 'Text', type: 'object' as const, properties: {} }));
    const ts = createTypesStore(backingStore, '/types');
    const children = await ts.getChildren('/types/test/block');
    assert.equal(children.items.length, 2);
    const names = children.items.map((n) => n.$path).sort();
    assert.deepEqual(names, ['/types/test/block/hero', '/types/test/block/text']);
  });

  it('get category folder returns dir node', async () => {
    register('test.block.hero', 'schema', () => ({ title: 'Hero', type: 'object' as const, properties: {} }));
    const ts = createTypesStore(backingStore, '/types');
    const node = await ts.get('/types/test/block');
    assert.equal(node?.$type, 't.dir');
  });

  it('falls back to backing tree for dynamic types', async () => {
    await backingStore.set(createNode('/types/custom/card', 'type'));
    const ts = createTypesStore(backingStore, '/types');
    const node = await ts.get('/types/custom/card');
    assert.equal(node?.$type, 't.type');
  });

  it('merges registry and stored types in getChildren', async () => {
    register('test.block.hero', 'schema', () => ({ title: 'Hero', type: 'object' as const, properties: {} }));
    await backingStore.set(createNode('/types/custom', 'dir'));
    const ts = createTypesStore(backingStore, '/types');
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
    const ts = createTypesStore(backingStore, '/types');
    const node = await ts.get('/types/test/block/hero');
    const schema = node?.schema as { title: string };
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
    const ts = createTypesStore(backingStore, '/types');
    const node = await ts.get('/types/test/block/hero');
    assert.equal(node?.$type, 't.type');
    const schema = node?.schema as { $type: string; title: string };
    assert.equal(schema.$type, 'schema');
    assert.equal(schema.title, 'Hero');
    const react = node?.react as { $type: string };
    assert.equal(react.$type, 'react');
    const reactEdit = node?.['react:edit'] as { $type: string };
    assert.equal(reactEdit.$type, 'react:edit');
  });

  it('set goes to backing tree', async () => {
    const ts = createTypesStore(backingStore, '/types');
    await ts.set(createNode('/types/custom/card', 'type'));
    const stored = await backingStore.get('/types/custom/card');
    assert.equal(stored?.$type, 't.type');
  });

  it('remove deletes dynamic type from backing tree', async () => {
    const ts = createTypesStore(backingStore, '/types');
    await ts.set(createNode('/types/custom/card', 'type'));
    const removed = await ts.remove('/types/custom/card');
    assert.equal(removed, true);
    assert.equal(await backingStore.get('/types/custom/card'), undefined);
  });

  it('remove throws on registry type', async () => {
    register('test.block.hero', 'schema', () => ({ title: 'Hero', type: 'object' as const, properties: {} }));
    const ts = createTypesStore(backingStore, '/types');
    await assert.rejects(() => ts.remove('/types/test/block/hero'));
  });

  it('dynamic type visible via get after set', async () => {
    const ts = createTypesStore(backingStore, '/types');
    const card = createNode('/types/custom/card', 'type', {}, {
      schema: { $type: 'schema', title: 'Card', type: 'object', properties: {} },
    });
    await ts.set(card);
    const node = await ts.get('/types/custom/card');
    assert.equal(node?.$type, 't.type');
    const schema = node?.schema as { title: string };
    assert.equal(schema.title, 'Card');
  });

  it('dynamic type appears in getChildren', async () => {
    const ts = createTypesStore(backingStore, '/types');
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
    const ts = createTypesStore(backingStore, '/types');
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

});
