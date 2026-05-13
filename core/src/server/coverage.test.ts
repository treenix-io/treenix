// Coverage gap tests — exercises uncovered code paths across the codebase.
// Excludes Mongo (requires connection). Focuses on:
//  - mount-adapters (memory, query, overlay, types, fs validation)
//  - sift queries via memory tree getChildren
//  - sub.ts remove CDC path
//  - actions.ts (executeAction, setComponent, applyTemplate)
//  - fs tree OCC
//  - validate.ts edge cases
//  - volatile extractPaths

import { registerType } from '#comp';
import { createNode, isComponent, type NodeData, register, resolve } from '#core';
import { clearRegistry } from '#core/index.test';
import { createMemoryTree, createOverlayTree, type Tree } from '#tree';
import { createFsTree } from '#tree/fs';
import { createQueryTree, mapNodeForSift, mapSiftQuery, matchesFilter } from '#tree/query';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { applyTemplate, executeAction, executeStream, setComponent } from './actions';
import { OpError } from '#errors';
import { withMounts } from './mount';
import { MountMemory, MountOverlay, MountQuery, MountTypes } from './mount-adapters';
import { type CdcRegistry, withSubscriptions } from './sub';
import { createTypesTree } from './types-mount';
import { withValidation } from './validate';
import { extractPaths, isVolatile, withVolatile } from './volatile';

// ── Helpers ──

function fullPipeline(rootStore?: Tree) {
  const bootstrap = rootStore ?? createMemoryTree();
  const mountable = withMounts(bootstrap);
  const volatile = withVolatile(mountable);
  const validated = withValidation(volatile);
  const events: any[] = [];
  const { tree, cdc } = withSubscriptions(validated, (e) => events.push(e));
  return { bootstrap, tree, cdc, events };
}

// ── mount-adapters (non-Mongo) ──

describe('Mount adapters', () => {
  beforeEach(() => {
    clearRegistry();

    // Register mount adapters using typed classes (same as mount-adapters.ts but without Mongo import side effects)
    register(MountMemory, 'mount', () => createMemoryTree());
    register(MountTypes, 'mount', (_mount, ctx) => createTypesTree(ctx.parentStore));
    register(MountQuery, 'mount', (mount, ctx) => {
      if (!mount.source || !mount.match) throw new Error('t.mount.query: source and match required');
      return createQueryTree(mount, ctx.globalStore || ctx.parentStore);
    });
    register(MountOverlay, 'mount', async (mount, ctx) => {
      if (!mount.layers?.length) throw new Error('t.mount.overlay: layers required');
      const stores: Tree[] = [];
      for (const name of mount.layers) {
        const comp = ctx.node[name];
        if (!isComponent(comp)) throw new Error(`t.mount.overlay: component "${name}" not found`);
        const adapter = resolve(comp.$type, 'mount');
        if (!adapter) throw new Error(`No mount adapter for "${comp.$type}"`);
        const subCtx = { node: ctx.node, path: ctx.path, parentStore: stores[0] ?? ({} as Tree), globalStore: ctx.globalStore };
        stores.push(await adapter(comp, subCtx));
      }
      let result = stores[0];
      for (let i = 1; i < stores.length; i++) result = createOverlayTree(stores[i], result);
      return result;
    });
  });

  it('t.mount.memory creates independent tree', async () => {
    const root = createMemoryTree();
    await root.set(createNode('/mnt', 'folder', {}, {
      mount: { $type: 't.mount.memory' },
    }));
    const ms = withMounts(root);

    await ms.set(createNode('/mnt/a', 'item'));
    assert.ok(await ms.get('/mnt/a'));
    // Not visible in root tree (mounted into separate memory)
    assert.equal(await root.get('/mnt/a'), undefined);
  });

  it('t.mount.query requires source and match', async () => {
    const root = createMemoryTree();
    await root.set(createNode('/bad', 'folder', {}, {
      mount: { $type: 't.mount.query' },
      // missing source and match
    }));
    const ms = withMounts(root);

    await assert.rejects(() => ms.getChildren('/bad'));
  });

  it('t.mount.overlay merges two memory stores', async () => {
    const root = createMemoryTree();
    await root.set(createNode('/ovl', 'folder', {}, {
      mount: { $type: 't.mount.overlay', layers: ['base', 'upper'] },
      base: { $type: 't.mount.memory' },
      upper: { $type: 't.mount.memory' },
    }));
    const ms = withMounts(root);

    await ms.set(createNode('/ovl/x', 'item'));
    assert.ok(await ms.get('/ovl/x'));
  });

  it('t.mount.overlay throws without layers', async () => {
    const root = createMemoryTree();
    await root.set(createNode('/bad', 'folder', {}, {
      mount: { $type: 't.mount.overlay' },
    }));
    const ms = withMounts(root);

    await assert.rejects(() => ms.getChildren('/bad'));
  });

  it('t.mount.overlay throws on missing component', async () => {
    const root = createMemoryTree();
    await root.set(createNode('/bad2', 'folder', {}, {
      mount: { $type: 't.mount.overlay', layers: ['base', 'ghost'] },
      base: { $type: 't.mount.memory' },
      // 'ghost' component missing
    }));
    const ms = withMounts(root);

    await assert.rejects(() => ms.getChildren('/bad2'));
  });

  it('t.mount.overlay throws on unknown adapter type', async () => {
    const root = createMemoryTree();
    await root.set(createNode('/bad3', 'folder', {}, {
      mount: { $type: 't.mount.overlay', layers: ['base'] },
      base: { $type: 'unknown.adapter' },
    }));
    const ms = withMounts(root);

    await assert.rejects(() => ms.getChildren('/bad3'));
  });
});

// ── Sift queries via memory tree ──

describe('Sift queries via memory tree', () => {
  let tree: Tree;

  beforeEach(async () => {
    tree = createMemoryTree();
    // Seed diverse data
    for (let i = 0; i < 20; i++) {
      await tree.set({
        $path: `/items/${i}`,
        $type: i % 3 === 0 ? 'order' : 'task',
        status: { $type: 'status', value: i % 2 === 0 ? 'active' : 'done' },
        priority: i % 5,
        tags: i < 10 ? ['urgent'] : ['low'],
      } as any);
    }
  });

  it('$eq (implicit)', async () => {
    const result = await tree.getChildren('/items', { query: { priority: 0 } });
    assert.ok(result.items.length > 0);
    for (const n of result.items) assert.equal((n as any).priority, 0);
  });

  it('$gt / $lt', async () => {
    const result = await tree.getChildren('/items', { query: { priority: { $gt: 3 } } });
    assert.ok(result.items.length > 0);
    for (const n of result.items) assert.ok((n as any).priority > 3);
  });

  it('$in', async () => {
    const result = await tree.getChildren('/items', { query: { priority: { $in: [0, 4] } } });
    for (const n of result.items) assert.ok([0, 4].includes((n as any).priority));
  });

  it('$and (composite)', async () => {
    const result = await tree.getChildren('/items', {
      query: { $and: [{ priority: { $gte: 2 } }, { 'status.value': 'active' }] },
    });
    for (const n of result.items) {
      assert.ok((n as any).priority >= 2);
      assert.equal((n as any).status.value, 'active');
    }
  });

  it('$or', async () => {
    const result = await tree.getChildren('/items', {
      query: { $or: [{ priority: 0 }, { priority: 4 }] },
    });
    for (const n of result.items) assert.ok([0, 4].includes((n as any).priority));
  });

  it('$not / $ne', async () => {
    const result = await tree.getChildren('/items', { query: { priority: { $ne: 0 } } });
    for (const n of result.items) assert.notEqual((n as any).priority, 0);
  });

  it('$type mapping — _type instead of $type', async () => {
    const result = await tree.getChildren('/items', { query: { _type: 'order' } });
    assert.ok(result.items.length > 0);
    for (const n of result.items) assert.equal(n.$type, 'order');
  });

  it('dot-path nested queries', async () => {
    const result = await tree.getChildren('/items', { query: { 'status.value': 'done' } });
    assert.ok(result.items.length > 0);
    for (const n of result.items) assert.equal((n as any).status.value, 'done');
  });

  it('$elemMatch on arrays', async () => {
    const result = await tree.getChildren('/items', { query: { tags: { $in: ['urgent'] } } });
    assert.equal(result.items.length, 10);
    for (const n of result.items) assert.ok((n as any).tags.includes('urgent'));
  });

  it('$exists', async () => {
    await tree.set({ $path: '/items/special', $type: 'special', rare: true } as any);
    const result = await tree.getChildren('/items', { query: { rare: { $exists: true } } });
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].$path, '/items/special');
  });

  it('empty query returns all', async () => {
    const result = await tree.getChildren('/items', { query: {} });
    assert.equal(result.items.length, 20);
  });

  it('query + pagination', async () => {
    const page = await tree.getChildren('/items', {
      query: { 'status.value': 'active' },
      limit: 3,
      offset: 0,
    });
    assert.equal(page.items.length, 3);
    assert.ok(page.total >= 3);
  });

  it('query on non-existent path returns empty', async () => {
    const result = await tree.getChildren('/nonexistent', { query: { x: 1 } });
    assert.equal(result.items.length, 0);
  });
});

// ── mapSiftQuery / mapNodeForSift edge cases ──

describe('query.ts mapping helpers', () => {
  it('mapSiftQuery renames all $ fields', () => {
    const mapped = mapSiftQuery({ $type: 'x', $path: '/a', $acl: [], $owner: 'u', $rev: 1 }) as Record<string, unknown>;
    assert.equal(mapped._type, 'x');
    assert.equal(mapped._path, '/a');
    assert.deepEqual(mapped._acl, []);
    assert.equal(mapped._owner, 'u');
    assert.equal(mapped._rev, 1);
  });

  it('mapSiftQuery handles nested arrays and objects', () => {
    const mapped = mapSiftQuery({ $and: [{ $type: 'a' }, { $path: '/b' }] });
    assert.deepEqual(mapped, { $and: [{ _type: 'a' }, { _path: '/b' }] });
  });

  it('mapSiftQuery passes primitives through', () => {
    assert.equal(mapSiftQuery('hello'), 'hello');
    assert.equal(mapSiftQuery(42), 42);
    assert.equal(mapSiftQuery(null), null);
    assert.equal(mapSiftQuery(true), true);
  });

  it('mapNodeForSift converts $ prefixed keys', () => {
    const mapped = mapNodeForSift({ $path: '/x', $type: 'y', name: 'z' } as NodeData);
    assert.equal(mapped._path, '/x');
    assert.equal(mapped._type, 'y');
    assert.equal(mapped.name, 'z');
    assert.equal(mapped.$path, undefined);
  });
});

// ── sub.ts: remove CDC path ──

describe('sub.ts: remove + CDC', () => {
  let cdc: CdcRegistry;

  beforeEach(() => {
    clearRegistry();

  });

  it('remove emits rmVps when node was in query', async () => {
    const mem = createMemoryTree();
    const events: any[] = [];
    const sub = withSubscriptions(mem, (e) => events.push(e));
    const tree = sub.tree;
    cdc = sub.cdc;

    // Register a query watch
    cdc.watchQuery('/active', '/items', { 'status.value': 'active' }, 'user1');

    // Create a matching node
    await tree.set({ $path: '/items/a', $type: 'item', status: { $type: 'status', value: 'active' } } as NodeData);

    events.length = 0;

    // Remove it — should emit rmVps
    await tree.remove('/items/a');
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'remove');
    assert.deepEqual(events[0].rmVps, ['/active']);

    cdc.unwatchAllQueries('user1');
  });

  it('remove of non-matching node has empty rmVps', async () => {
    const mem = createMemoryTree();
    const events: any[] = [];
    const sub = withSubscriptions(mem, (e) => events.push(e));
    const tree = sub.tree;
    cdc = sub.cdc;

    cdc.watchQuery('/active', '/items', { 'status.value': 'active' }, 'user1');

    await tree.set({ $path: '/items/b', $type: 'item', status: { $type: 'status', value: 'done' } } as NodeData);
    events.length = 0;

    await tree.remove('/items/b');
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'remove');
    assert.equal(events[0].rmVps, undefined);

    cdc.unwatchAllQueries('user1');
  });

  it('remove of non-existent node emits nothing', async () => {
    const mem = createMemoryTree();
    const events: any[] = [];
    const { tree } = withSubscriptions(mem, (e) => events.push(e));

    await tree.remove('/ghost');
    assert.equal(events.length, 0);
  });

  it('unwatchQuery removes single user', () => {
    const { cdc } = withSubscriptions(createMemoryTree());

    cdc.watchQuery('/vp1', '/src', { x: 1 }, 'userA');
    cdc.watchQuery('/vp1', '/src', { x: 1 }, 'userB');
    assert.equal(cdc.getActiveQueryCount(), 1);

    cdc.unwatchQuery('/vp1', 'userA');
    assert.equal(cdc.getActiveQueryCount(), 1, 'entry should remain (userB watching)');

    cdc.unwatchQuery('/vp1', 'userB');
    assert.equal(cdc.getActiveQueryCount(), 0, 'entry fully cleaned');

    // Idempotent
    cdc.unwatchQuery('/vp1', 'userB');
    assert.equal(cdc.getActiveQueryCount(), 0);
  });

  it('unwatchAllQueries cleans up all entries for user', () => {
    const { cdc } = withSubscriptions(createMemoryTree());

    cdc.watchQuery('/a', '/s', { x: 1 }, 'u1');
    cdc.watchQuery('/b', '/s', { y: 2 }, 'u1');
    cdc.watchQuery('/a', '/s', { x: 1 }, 'u2');
    assert.equal(cdc.getActiveQueryCount(), 2);

    cdc.unwatchAllQueries('u1');
    assert.equal(cdc.getActiveQueryCount(), 1, '/a should remain (u2 watching)');

    cdc.unwatchAllQueries('u2');
    assert.equal(cdc.getActiveQueryCount(), 0);
  });
});

// ── actions.ts: executeAction, setComponent, applyTemplate ──

describe('actions.ts operations', () => {
  beforeEach(() => {
    clearRegistry();

  });

  it('executeAction generates Immer patches', async () => {
    class Counter {
      count = 0;
      increment() { this.count++; }
    }
    registerType('counter', Counter);
    register('counter', 'schema', () => ({
      $id: 'counter', title: 'Counter', type: 'object' as const,
      properties: { count: { type: 'number' } },
      methods: { increment: { arguments: [] } },
    }));

    const tree = createMemoryTree();
    await tree.set(createNode('/c', 'item', {}, {
      counter: { $type: 'counter', count: 0 },
    }));

    await executeAction(tree, '/c', 'counter', undefined, 'increment');

    const node = await tree.get('/c');
    assert.equal((node!['counter'] as any).count, 1);
    // $rev incremented
    assert.equal(node!.$rev, 2); // once from initial set, once from executeAction
  });

  it('executeAction without component name uses node type', async () => {
    register('mytype', 'action:doStuff', (actx: any) => {
      actx.node.result = 42;
      return 'ok';
    });
    register('mytype', 'schema', () => ({
      $id: 'mytype', title: 'MyType', type: 'object' as const, properties: {},
      methods: { doStuff: { arguments: [] } },
    }));

    const tree = createMemoryTree();
    await tree.set(createNode('/n', 'mytype'));

    const result = await executeAction(tree, '/n', undefined, undefined, 'doStuff');
    assert.equal(result, 'ok');
  });

  it('executeAction throws NOT_FOUND for missing node', async () => {
    const tree = createMemoryTree();
    await assert.rejects(
      () => executeAction(tree, '/missing', undefined, undefined, 'x'),
      (e: any) => { assert.equal(e.code, 'NOT_FOUND'); return true; },
    );
  });

  it('executeAction throws NOT_FOUND for missing component', async () => {
    const tree = createMemoryTree();
    await tree.set(createNode('/n', 'item'));
    await assert.rejects(
      () => executeAction(tree, '/n', 'ghost', undefined, 'x'),
      (e: any) => { assert.equal(e.code, 'NOT_FOUND'); return true; },
    );
  });

  it('executeAction throws BAD_REQUEST for missing action', async () => {
    class Dummy { x = 1; }
    registerType('dummy', Dummy);

    const tree = createMemoryTree();
    await tree.set(createNode('/n', 'item', {}, {
      dummy: { $type: 'dummy', x: 1 },
    }));

    await assert.rejects(
      () => executeAction(tree, '/n', 'dummy', undefined, 'nonexistent'),
      (e: any) => { assert.equal(e.code, 'BAD_REQUEST'); return true; },
    );
  });

  it('pure action (no patches) does not persist', async () => {
    register('reader', 'action:read', (_actx: any, data: any) => {
      return { echo: data };
    });
    register('reader', 'schema', () => ({
      $id: 'reader', title: 'Reader', type: 'object' as const, properties: {},
      methods: { read: { arguments: [{ name: 'data', type: 'object', properties: { msg: { type: 'string' } } }] } },
    }));

    const tree = createMemoryTree();
    await tree.set(createNode('/r', 'reader'));

    const result = await executeAction(tree, '/r', undefined, undefined, 'read', { msg: 'hello' });
    assert.deepEqual(result, { echo: { msg: 'hello' } });
    // $rev stays at 1 — no tree.set() called
    const node = await tree.get('/r');
    assert.equal(node!.$rev, 1);
  });

  it('executeAction throws NOT_FOUND for missing node (no type)', async () => {
    const tree = createMemoryTree();
    await assert.rejects(
      () => executeAction(tree, '/missing', undefined, undefined, 'x'),
      (e: any) => { assert.equal(e.code, 'NOT_FOUND'); return true; },
    );
  });

  it('executeStream: yields values from async generator action', async () => {
    class Emitter {
      async *emit(data: { n: number }) {
        for (let i = 0; i < data.n; i++) yield i;
      }
    }
    registerType('emitter', Emitter);
    register('emitter', 'schema', () => ({
      $id: 'emitter', title: 'Emitter', type: 'object' as const, properties: {},
      methods: { emit: { arguments: [{ name: 'data', type: 'object', properties: { n: { type: 'number' } }, required: ['n'] }], streaming: true } },
    }));

    const tree = createMemoryTree();
    await tree.set(createNode('/e', 'item', {}, {
      emitter: { $type: 'emitter' },
    }));

    const collected: unknown[] = [];
    for await (const item of executeStream(tree, '/e', 'emitter', undefined, 'emit', { n: 3 })) {
      collected.push(item);
    }
    assert.deepEqual(collected, [0, 1, 2]);
  });

  it('executeStream: BAD_REQUEST for non-generator action', async () => {
    class Plain { run() { return 42; } }
    registerType('plain', Plain);
    register('plain', 'schema', () => ({
      $id: 'plain', title: 'Plain', type: 'object' as const, properties: {},
      methods: { run: { arguments: [] } },
    }));

    const tree = createMemoryTree();
    await tree.set(createNode('/p', 'item', {}, { plain: { $type: 'plain' } }));

    await assert.rejects(
      async () => {
        for await (const _ of executeStream(tree, '/p', 'plain', undefined, 'run')) { /* */ }
      },
      (e: any) => { assert.equal(e.code, 'BAD_REQUEST'); return true; },
    );
  });

  it('setComponent updates single component', async () => {
    const tree = createMemoryTree();
    await tree.set(createNode('/s', 'item', {}, {
      meta: { $type: 'meta', title: 'old' },
    }));

    await setComponent(tree, '/s', 'meta', { $type: 'meta', title: 'new' });

    const node = await tree.get('/s');
    assert.equal((node as any).meta.title, 'new');
  });

  it('setComponent throws NOT_FOUND for missing node', async () => {
    const tree = createMemoryTree();
    await assert.rejects(
      () => setComponent(tree, '/missing', 'x', {}),
      (e: any) => { assert.equal(e.code, 'NOT_FOUND'); return true; },
    );
  });

  it('setComponent throws CONFLICT on stale rev', async () => {
    const tree = createMemoryTree();
    await tree.set(createNode('/s', 'item'));
    await assert.rejects(
      () => setComponent(tree, '/s', 'x', {}, 999),
      (e: any) => { assert.equal(e.code, 'CONFLICT'); return true; },
    );
  });

  it('applyTemplate copies children to target', async () => {
    const tree = createMemoryTree();
    await tree.set(createNode('/templates/blog', 'template'));
    await tree.set(createNode('/templates/blog/header', 'block', { text: 'Hello' }));
    await tree.set(createNode('/templates/blog/body', 'block', { text: 'Content' }));

    // Existing children at target get removed
    await tree.set(createNode('/pages/p1', 'page'));
    await tree.set(createNode('/pages/p1/old', 'block'));

    const result = await applyTemplate(tree, '/templates/blog', '/pages/p1');
    assert.equal(result.blocks, 2);
    assert.equal(result.applied, '/templates/blog');

    // Old child gone
    assert.equal(await tree.get('/pages/p1/old'), undefined);

    // New children present
    const header = await tree.get('/pages/p1/header');
    assert.ok(header);
    assert.equal((header as any).text, 'Hello');
  });

  it('applyTemplate throws NOT_FOUND for missing template', async () => {
    const tree = createMemoryTree();
    await assert.rejects(
      () => applyTemplate(tree, '/missing', '/target'),
      (e: any) => { assert.equal(e.code, 'NOT_FOUND'); return true; },
    );
  });
});

// ── fs tree: OCC + remove edge cases ──

describe('FsStore OCC', () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('OCC rejects stale rev', async () => {
    dir = await mkdtemp(join(tmpdir(), 'treenix-fs-occ-'));
    const tree = await createFsTree(dir);

    await tree.set(createNode('/n', 'item')); // rev becomes 1
    const node = await tree.get('/n');

    // Simulate stale read
    await tree.set({ ...node!, $rev: node!.$rev }); // rev becomes 2

    // Now try with stale rev=1
    await assert.rejects(() => tree.set({ ...node!, $rev: 1 }));
  });

  it('OCC throws when node does not exist but rev provided', async () => {
    dir = await mkdtemp(join(tmpdir(), 'treenix-fs-occ2-'));
    const tree = await createFsTree(dir);

    await assert.rejects(
      () => tree.set({ ...createNode('/ghost', 'item'), $rev: 1 }),
    );
  });
});

// ── validate.ts edge cases ──

describe('Validation edge cases', () => {
  beforeEach(() => {
    clearRegistry();

  });

  it('rejects boolean where string expected', async () => {
    register('typed', 'schema', () => ({
      title: 'typed', type: 'object' as const,
      properties: { name: { type: 'string' } },
    }));

    const tree = withValidation(createMemoryTree());

    await assert.rejects(
      () => tree.set({ $path: '/v', $type: 'x', comp: { $type: 'typed', name: 123 } } as any),
    );
  });

  it('rejects string where number expected', async () => {
    register('numtype', 'schema', () => ({
      title: 'numtype', type: 'object' as const,
      properties: { count: { type: 'number' } },
    }));

    const tree = withValidation(createMemoryTree());

    await assert.rejects(
      () => tree.set({ $path: '/v', $type: 'x', comp: { $type: 'numtype', count: 'not a number' } } as any),
    );
  });

  it('rejects number where boolean expected', async () => {
    register('booltype', 'schema', () => ({
      title: 'booltype', type: 'object' as const,
      properties: { flag: { type: 'boolean' } },
    }));

    const tree = withValidation(createMemoryTree());

    await assert.rejects(
      () => tree.set({ $path: '/v', $type: 'x', comp: { $type: 'booltype', flag: 42 } } as any),
    );
  });

  it('allows null/undefined values (optional by default)', async () => {
    register('opttype', 'schema', () => ({
      title: 'opttype', type: 'object' as const,
      properties: { name: { type: 'string' } },
    }));

    const tree = withValidation(createMemoryTree());
    // null and undefined should pass — optional by default
    await tree.set({ $path: '/v', $type: 'x', comp: { $type: 'opttype', name: null } } as any);
    await tree.set({ $path: '/v2', $type: 'x', comp: { $type: 'opttype' } } as any);
  });

  it('skips components without schema', async () => {
    const tree = withValidation(createMemoryTree());
    await tree.set({ $path: '/v', $type: 'x', comp: { $type: 'untyped', anything: 'goes' } } as any);
    const node = await tree.get('/v');
    assert.ok(node, 'node should be stored');
    assert.equal((node as any).comp.anything, 'goes');
  });

  it('skips schemas without properties', async () => {
    register('emptyschema', 'schema', () => ({ title: 'emptyschema', type: 'object' as const, properties: {} }));

    const tree = withValidation(createMemoryTree());
    await tree.set({ $path: '/v', $type: 'x', comp: { $type: 'emptyschema', x: 1 } } as any);
    const node = await tree.get('/v');
    assert.ok(node, 'node should be stored');
    assert.equal((node as any).comp.x, 1);
  });
});

// ── volatile.ts: extractPaths ──

describe('extractPaths', () => {
  it('extracts from { items: [...] }', () => {
    const paths = extractPaths({ items: [{ $path: '/a' }, { $path: '/b' }] });
    assert.deepEqual(paths, ['/a', '/b']);
  });

  it('extracts from single node', () => {
    const paths = extractPaths({ $path: '/single' });
    assert.deepEqual(paths, ['/single']);
  });

  it('returns empty for null/undefined', () => {
    assert.deepEqual(extractPaths(null), []);
    assert.deepEqual(extractPaths(undefined), []);
    assert.deepEqual(extractPaths('string'), []);
    assert.deepEqual(extractPaths(42), []);
  });

  it('filters items without $path', () => {
    const paths = extractPaths({ items: [{ $path: '/a' }, { name: 'no path' }, { $path: '/b' }] });
    assert.deepEqual(paths, ['/a', '/b']);
  });

  it('returns empty for object without $path or items', () => {
    assert.deepEqual(extractPaths({ foo: 'bar' }), []);
  });
});

// ── volatile.ts: isVolatile ──

describe('isVolatile', () => {
  beforeEach(() => {
    clearRegistry();

  });

  it('returns true for $volatile flag', () => {
    assert.equal(isVolatile({ $path: '/a', $type: 'x', $volatile: true } as any), true);
  });

  it('returns false without $volatile and no handler', () => {
    assert.equal(isVolatile({ $path: '/a', $type: 'x' } as any), false);
  });

  it('returns true when type has volatile handler', () => {
    register('ephemeral', 'volatile', () => true);
    assert.equal(isVolatile({ $path: '/a', $type: 'ephemeral' } as any), true);
  });

  it('$volatile false overrides type handler', () => {
    register('ephemeral2', 'volatile', () => true);
    assert.equal(isVolatile({ $path: '/a', $type: 'ephemeral2', $volatile: false } as any), false);
  });
});

// ── OpError ──

describe('OpError', () => {
  it('has correct name and code', () => {
    const err = new OpError('NOT_FOUND', 'thing not found');
    assert.equal(err.name, 'OpError');
    assert.equal(err.code, 'NOT_FOUND');
    assert.equal(err.message, 'thing not found');
    assert.ok(err instanceof Error);
  });
});

// ── TypesStore edge cases ──

describe('TypesStore', () => {
  beforeEach(() => {
    clearRegistry();

  });

  it('get returns undefined for unregistered type', async () => {
    const backing = createMemoryTree();
    const ts = createTypesTree(backing);
    const result = await ts.get('/sys/types/nonexistent');
    assert.equal(result, undefined);
  });

  it('remove throws on registry type', async () => {
    register('vendor.widget', 'schema', () => ({ title: 'vendor.widget', type: 'object' as const, properties: {} }));
    const backing = createMemoryTree();
    const ts = createTypesTree(backing);

    await assert.rejects(() => ts.remove('/sys/types/vendor/widget'));
  });

  it('remove works on dynamic (stored) type', async () => {
    const backing = createMemoryTree();
    await backing.set(createNode('/sys/types/custom/thing', 'type'));

    const ts = createTypesTree(backing);
    const result = await ts.remove('/sys/types/custom/thing');
    assert.equal(result, true);
  });

  it('set goes to backing tree', async () => {
    const backing = createMemoryTree();
    const ts = createTypesTree(backing);
    await ts.set(createNode('/sys/types/dynamic/type', 'type'));

    const node = await backing.get('/sys/types/dynamic/type');
    assert.ok(node);
  });
});

// ── QueryStore: merged query from parent ──

describe('QueryStore advanced', () => {
  it('merges external query with config match via $and', async () => {
    const parent = createMemoryTree();
    await parent.set({ $path: '/items/1', $type: 'item', status: { $type: 's', value: 'active' }, priority: 1 } as any);
    await parent.set({ $path: '/items/2', $type: 'item', status: { $type: 's', value: 'active' }, priority: 5 } as any);
    await parent.set({ $path: '/items/3', $type: 'item', status: { $type: 's', value: 'done' }, priority: 1 } as any);

    const qs = createQueryTree({ source: '/items', match: { 'status.value': 'active' } }, parent);
    // Pass additional query — should merge with $and
    const result = await qs.getChildren('/view', { query: { priority: { $gt: 3 } } });
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].$path, '/items/2');
  });

  it('returns queryMount metadata', async () => {
    const parent = createMemoryTree();
    await parent.set({ $path: '/items/1', $type: 'item', status: { $type: 's', value: 'active' } } as any);

    const qs = createQueryTree({ source: '/items', match: { 'status.value': 'active' } }, parent);
    const result = await qs.getChildren('/view');
    assert.deepEqual(result.queryMount, { source: '/items', match: { 'status.value': 'active' } });
  });
});

// ── matchesFilter edge cases ──

describe('matchesFilter advanced', () => {
  it('$regex matching', () => {
    const node = { $path: '/a', $type: 'x', name: 'hello-world' } as NodeData;
    assert.equal(matchesFilter(node, { name: { $regex: 'hello' } }), true);
    assert.equal(matchesFilter(node, { name: { $regex: '^nope' } }), false);
  });

  it('$path in match maps correctly', () => {
    const node = { $path: '/items/42', $type: 'item' } as NodeData;
    assert.equal(matchesFilter(node, { $path: '/items/42' }), true);
    assert.equal(matchesFilter(node, { $path: '/items/99' }), false);
  });

  it('$acl / $owner in match', () => {
    const node = { $path: '/a', $type: 'x', $owner: 'alice', $acl: [{ g: 'admin', p: 7 }] } as any;
    assert.equal(matchesFilter(node, { $owner: 'alice' }), true);
    assert.equal(matchesFilter(node, { $owner: 'bob' }), false);
  });
});
