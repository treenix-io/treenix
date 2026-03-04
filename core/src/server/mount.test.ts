import { createNode, ref, register } from '#core';
import { clearRegistry } from '#core/index.test';
import { createMemoryTree, type Tree } from '#tree';
import { createQueryTree } from '#tree/query';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
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

  it('delegates get to mounted store', async () => {
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

  it('returns mount node from parent store', async () => {
    await rootStore.set(
      createNode('/users', 'collection', {}, {
        mount: { $type: 'test.mount.memory' },
      }),
    );
    const ms = withMounts(rootStore);
    const node = await ms.get('/users');
    assert.equal(node?.$type, 't.collection');
  });

  it('delegates getChildren to mounted store', async () => {
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

  it('delegates set to mounted store', async () => {
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

  it('delegates remove to mounted store', async () => {
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

  it('falls back to root store for unmounted paths', async () => {
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

  it('resolves mount via $ref to config node', async () => {
    register('test.ref.store', 'mount', () => usersStore);
    await rootStore.set(createNode('/mnt/users', 'test.ref.store'));
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
    await rootStore.set(createNode('/mnt/users', 'test.ref.store'));
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

  it('root mount: delegates children to mounted store', async () => {
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

  it('root mount: get delegates to mounted store', async () => {
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

  it('root mount: set writes to mounted store', async () => {
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

  it('nested mount: adapter receives parent store as deps', async () => {
    const dataStore = createMemoryTree();
    let receivedDeps: unknown = null;
    register('test.mount.data', 'mount', () => dataStore);
    register('test.mount.spy', 'mount', (_node: unknown, deps: unknown) => {
      receivedDeps = deps;
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
});

describe('Query mount (t.mount.query)', () => {
  let rootStore: Tree;
  let dataStore: Tree;

  beforeEach(() => {
    clearRegistry();
    rootStore = createMemoryTree();
    dataStore = createMemoryTree();
    register('test.mount.data', 'mount', () => dataStore);
    // Register query mount adapter
    register('t.mount.query', 'mount', (config, parentStore) => {
      const n = config as any;
      const query = n.query;
      return createQueryTree({ source: query.source, match: query.match }, parentStore);
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
        mount: { $type: 't.mount.query' },
        query: { $type: 'query', source: '/orders', match: { 'status.value': 'incoming' } },
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
        mount: { $type: 't.mount.query' },
        query: { $type: 'query', source: '/orders', match: { 'status.value': 'incoming' } },
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
        mount: { $type: 't.mount.query' },
        query: { $type: 'query', source: '/orders', match: { 'status.value': 'incoming' } },
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
      label: 'Hero',
      fields: { title: { type: 'string', label: 'Title' } },
    }));
    const ts = createTypesStore(backingStore, '/types');
    const node = await ts.get('/types/test/block/hero');
    assert.equal(node?.$type, 't.type');
    assert.equal(node?.$path, '/types/test/block/hero');
    const schema = node?.schema as { label: string };
    assert.equal(schema.label, 'Hero');
  });

  it('getChildren /types returns vendor folders', async () => {
    register('test.block.hero', 'schema', () => ({ label: 'Hero', fields: {} }));
    register('test.block.text', 'schema', () => ({ label: 'Text', fields: {} }));
    const ts = createTypesStore(backingStore, '/types');
    const children = await ts.getChildren('/types');
    assert.equal(children.items.length, 1); // /types/test folder
    assert.equal(children.items[0].$path, '/types/test');
    assert.equal(children.items[0].$type, 't.dir');
  });

  it('getChildren returns type nodes in category', async () => {
    register('test.block.hero', 'schema', () => ({ label: 'Hero', fields: {} }));
    register('test.block.text', 'schema', () => ({ label: 'Text', fields: {} }));
    const ts = createTypesStore(backingStore, '/types');
    const children = await ts.getChildren('/types/test/block');
    assert.equal(children.items.length, 2);
    const names = children.items.map((n) => n.$path).sort();
    assert.deepEqual(names, ['/types/test/block/hero', '/types/test/block/text']);
  });

  it('get category folder returns dir node', async () => {
    register('test.block.hero', 'schema', () => ({ label: 'Hero', fields: {} }));
    const ts = createTypesStore(backingStore, '/types');
    const node = await ts.get('/types/test/block');
    assert.equal(node?.$type, 't.dir');
  });

  it('falls back to backing store for dynamic types', async () => {
    await backingStore.set(createNode('/types/custom/card', 'type'));
    const ts = createTypesStore(backingStore, '/types');
    const node = await ts.get('/types/custom/card');
    assert.equal(node?.$type, 't.type');
  });

  it('merges registry and stored types in getChildren', async () => {
    register('test.block.hero', 'schema', () => ({ label: 'Hero', fields: {} }));
    await backingStore.set(createNode('/types/custom', 'dir'));
    const ts = createTypesStore(backingStore, '/types');
    const children = await ts.getChildren('/types');
    assert.equal(children.items.length, 2); // /types/test + /types/custom
  });

  it('registry wins on conflict', async () => {
    register('test.block.hero', 'schema', () => ({
      label: 'Hero from registry',
      fields: {},
    }));
    await backingStore.set(createNode('/types/test/block/hero', 'type'));
    const ts = createTypesStore(backingStore, '/types');
    const node = await ts.get('/types/test/block/hero');
    const schema = node?.schema as { label: string };
    assert.equal(schema.label, 'Hero from registry');
  });

  it('type node includes all registered contexts', async () => {
    register('test.block.hero', 'schema', () => ({
      title: 'Hero',
      type: 'object',
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

  it('set goes to backing store', async () => {
    const ts = createTypesStore(backingStore, '/types');
    await ts.set(createNode('/types/custom/card', 'type'));
    const stored = await backingStore.get('/types/custom/card');
    assert.equal(stored?.$type, 't.type');
  });

  it('remove deletes dynamic type from backing store', async () => {
    const ts = createTypesStore(backingStore, '/types');
    await ts.set(createNode('/types/custom/card', 'type'));
    const removed = await ts.remove('/types/custom/card');
    assert.equal(removed, true);
    assert.equal(await backingStore.get('/types/custom/card'), undefined);
  });

  it('remove throws on registry type', async () => {
    register('test.block.hero', 'schema', () => ({ label: 'Hero', fields: {} }));
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
    register('test.block.hero', 'schema', () => ({ label: 'Hero', fields: {} }));
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
