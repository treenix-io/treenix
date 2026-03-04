// Coverage gap tests — exercises uncovered code paths across the codebase.
// Excludes Mongo (requires connection). Focuses on:
//  - mount-adapters (memory, query, overlay, types, fs validation)
//  - sift queries via memory store getChildren
//  - sub.ts remove CDC path
//  - actions.ts (executeAction, setComponent, applyTemplate)
//  - fs store OCC
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
import { OpError } from './errors';
import { withMounts } from './mount';
import { getActiveQueryCount, unwatchAllQueries, unwatchQuery, watchQuery, withSubscriptions } from './sub';
import { createTypesStore } from './types-mount';
import { withValidation } from './validate';
import { extractPaths, isVolatile, withVolatile } from './volatile';

// ── Helpers ──

function fullPipeline(rootStore?: Tree) {
  const bootstrap = rootStore ?? createMemoryTree();
  const mountable = withMounts(bootstrap);
  const volatile = withVolatile(mountable);
  const validated = withValidation(volatile);
  const events: any[] = [];
  const store = withSubscriptions(validated, (e) => events.push(e));
  return { bootstrap, store, events };
}

// ── mount-adapters (non-Mongo) ──

describe('Mount adapters', () => {
  beforeEach(() => {
    clearRegistry();

    // Register mount adapters manually (same as mount-adapters.ts but without Mongo import side effects)
    register('t.mount.memory', 'mount', () => createMemoryTree());
    register('t.mount.types', 'mount', (_node: any, deps: Tree) => createTypesStore(deps));
    register('t.mount.query', 'mount', (config: any, parentStore: Tree, _ctx: any, globalStore?: Tree) => {
      const n = config as NodeData;
      const qv = n['query'];
      const query = isComponent(qv) ? qv as { source: string; match: Record<string, unknown> } : undefined;
      if (!query?.source || !query?.match) throw new Error("t.mount.query requires 'query' component with source and match");
      return createQueryTree({ source: query.source, match: query.match }, globalStore || parentStore);
    });
    register('t.mount.overlay', 'mount', async (config: any, parentStore: Tree, ctx: any, globalStore?: Tree) => {
      const n = config as NodeData;
      const mount = n['mount'] as any;
      if (!mount?.layers?.length) throw new Error('t.mount.overlay: layers required');
      const stores: Tree[] = [];
      for (const name of mount.layers) {
        const comp = n[name] as any;
        if (!comp) throw new Error(`t.mount.overlay: component "${name}" not found`);
        const adapter = resolve(comp.$type, 'mount');
        if (!adapter) throw new Error(`No mount adapter for "${comp.$type}"`);
        stores.push(await adapter(comp, stores[0] ?? ({} as Tree), ctx, globalStore));
      }
      let result = stores[0];
      for (let i = 1; i < stores.length; i++) result = createOverlayTree(stores[i], result);
      return result;
    });
  });

  it('t.mount.memory creates independent store', async () => {
    const root = createMemoryTree();
    await root.set(createNode('/mnt', 'folder', {}, {
      mount: { $type: 't.mount.memory' },
    }));
    const ms = withMounts(root);

    await ms.set(createNode('/mnt/a', 'item'));
    assert.ok(await ms.get('/mnt/a'));
    // Not visible in root store (mounted into separate memory)
    assert.equal(await root.get('/mnt/a'), undefined);
  });

  it('t.mount.query requires query component', async () => {
    const root = createMemoryTree();
    await root.set(createNode('/bad', 'folder', {}, {
      mount: { $type: 't.mount.query' },
      // missing 'query' component
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

// ── Sift queries via memory store ──

describe('Sift queries via memory store', () => {
  let store: Tree;

  beforeEach(async () => {
    store = createMemoryTree();
    // Seed diverse data
    for (let i = 0; i < 20; i++) {
      await store.set({
        $path: `/items/${i}`,
        $type: i % 3 === 0 ? 'order' : 'task',
        status: { $type: 'status', value: i % 2 === 0 ? 'active' : 'done' },
        priority: i % 5,
        tags: i < 10 ? ['urgent'] : ['low'],
      } as any);
    }
  });

  it('$eq (implicit)', async () => {
    const result = await store.getChildren('/items', { query: { priority: 0 } });
    assert.ok(result.items.length > 0);
    for (const n of result.items) assert.equal((n as any).priority, 0);
  });

  it('$gt / $lt', async () => {
    const result = await store.getChildren('/items', { query: { priority: { $gt: 3 } } });
    assert.ok(result.items.length > 0);
    for (const n of result.items) assert.ok((n as any).priority > 3);
  });

  it('$in', async () => {
    const result = await store.getChildren('/items', { query: { priority: { $in: [0, 4] } } });
    for (const n of result.items) assert.ok([0, 4].includes((n as any).priority));
  });

  it('$and (composite)', async () => {
    const result = await store.getChildren('/items', {
      query: { $and: [{ priority: { $gte: 2 } }, { 'status.value': 'active' }] },
    });
    for (const n of result.items) {
      assert.ok((n as any).priority >= 2);
      assert.equal((n as any).status.value, 'active');
    }
  });

  it('$or', async () => {
    const result = await store.getChildren('/items', {
      query: { $or: [{ priority: 0 }, { priority: 4 }] },
    });
    for (const n of result.items) assert.ok([0, 4].includes((n as any).priority));
  });

  it('$not / $ne', async () => {
    const result = await store.getChildren('/items', { query: { priority: { $ne: 0 } } });
    for (const n of result.items) assert.notEqual((n as any).priority, 0);
  });

  it('$type mapping — _type instead of $type', async () => {
    const result = await store.getChildren('/items', { query: { _type: 'order' } });
    assert.ok(result.items.length > 0);
    for (const n of result.items) assert.equal(n.$type, 'order');
  });

  it('dot-path nested queries', async () => {
    const result = await store.getChildren('/items', { query: { 'status.value': 'done' } });
    assert.ok(result.items.length > 0);
    for (const n of result.items) assert.equal((n as any).status.value, 'done');
  });

  it('$elemMatch on arrays', async () => {
    const result = await store.getChildren('/items', { query: { tags: { $in: ['urgent'] } } });
    assert.equal(result.items.length, 10);
    for (const n of result.items) assert.ok((n as any).tags.includes('urgent'));
  });

  it('$exists', async () => {
    await store.set({ $path: '/items/special', $type: 'special', rare: true } as any);
    const result = await store.getChildren('/items', { query: { rare: { $exists: true } } });
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].$path, '/items/special');
  });

  it('empty query returns all', async () => {
    const result = await store.getChildren('/items', { query: {} });
    assert.equal(result.items.length, 20);
  });

  it('query + pagination', async () => {
    const page = await store.getChildren('/items', {
      query: { 'status.value': 'active' },
      limit: 3,
      offset: 0,
    });
    assert.equal(page.items.length, 3);
    assert.ok(page.total >= 3);
  });

  it('query on non-existent path returns empty', async () => {
    const result = await store.getChildren('/nonexistent', { query: { x: 1 } });
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
  beforeEach(() => {
    clearRegistry();

  });

  it('remove emits rmVps when node was in query', async () => {
    const mem = createMemoryTree();
    const events: any[] = [];
    const store = withSubscriptions(mem, (e) => events.push(e));

    // Register a query watch
    watchQuery('/active', '/items', { 'status.value': 'active' }, 'user1');

    // Create a matching node
    await store.set({ $path: '/items/a', $type: 'item', status: { $type: 'status', value: 'active' } } as NodeData);

    events.length = 0;

    // Remove it — should emit rmVps
    await store.remove('/items/a');
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'remove');
    assert.deepEqual(events[0].rmVps, ['/active']);

    unwatchAllQueries('user1');
  });

  it('remove of non-matching node has empty rmVps', async () => {
    const mem = createMemoryTree();
    const events: any[] = [];
    const store = withSubscriptions(mem, (e) => events.push(e));

    watchQuery('/active', '/items', { 'status.value': 'active' }, 'user1');

    await store.set({ $path: '/items/b', $type: 'item', status: { $type: 'status', value: 'done' } } as NodeData);
    events.length = 0;

    await store.remove('/items/b');
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'remove');
    assert.equal(events[0].rmVps, undefined);

    unwatchAllQueries('user1');
  });

  it('remove of non-existent node emits nothing', async () => {
    const mem = createMemoryTree();
    const events: any[] = [];
    const store = withSubscriptions(mem, (e) => events.push(e));

    await store.remove('/ghost');
    assert.equal(events.length, 0);
  });

  it('unwatchQuery removes single user', () => {
    watchQuery('/vp1', '/src', { x: 1 }, 'userA');
    watchQuery('/vp1', '/src', { x: 1 }, 'userB');
    assert.equal(getActiveQueryCount(), 1);

    unwatchQuery('/vp1', 'userA');
    assert.equal(getActiveQueryCount(), 1, 'entry should remain (userB watching)');

    unwatchQuery('/vp1', 'userB');
    assert.equal(getActiveQueryCount(), 0, 'entry fully cleaned');

    // Idempotent
    unwatchQuery('/vp1', 'userB');
    assert.equal(getActiveQueryCount(), 0);
  });

  it('unwatchAllQueries cleans up all entries for user', () => {
    watchQuery('/a', '/s', { x: 1 }, 'u1');
    watchQuery('/b', '/s', { y: 2 }, 'u1');
    watchQuery('/a', '/s', { x: 1 }, 'u2');
    assert.equal(getActiveQueryCount(), 2);

    unwatchAllQueries('u1');
    assert.equal(getActiveQueryCount(), 1, '/a should remain (u2 watching)');

    unwatchAllQueries('u2');
    assert.equal(getActiveQueryCount(), 0);
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

    const store = createMemoryTree();
    await store.set(createNode('/c', 'item', {}, {
      counter: { $type: 'counter', count: 0 },
    }));

    await executeAction(store, '/c', 'counter', undefined, 'increment');

    const node = await store.get('/c');
    assert.equal((node!['counter'] as any).count, 1);
    // $rev incremented
    assert.equal(node!.$rev, 2); // once from initial set, once from executeAction
  });

  it('executeAction without component name uses node type', async () => {
    register('mytype', 'action:doStuff', (actx: any) => {
      actx.node.result = 42;
      return 'ok';
    });

    const store = createMemoryTree();
    await store.set(createNode('/n', 'mytype'));

    const result = await executeAction(store, '/n', undefined, undefined, 'doStuff');
    assert.equal(result, 'ok');
  });

  it('executeAction throws NOT_FOUND for missing node', async () => {
    const store = createMemoryTree();
    await assert.rejects(
      () => executeAction(store, '/missing', undefined, undefined, 'x'),
      (e: any) => { assert.equal(e.code, 'NOT_FOUND'); return true; },
    );
  });

  it('executeAction throws NOT_FOUND for missing component', async () => {
    const store = createMemoryTree();
    await store.set(createNode('/n', 'item'));
    await assert.rejects(
      () => executeAction(store, '/n', 'ghost', undefined, 'x'),
      (e: any) => { assert.equal(e.code, 'NOT_FOUND'); return true; },
    );
  });

  it('executeAction throws BAD_REQUEST for missing action', async () => {
    class Dummy { x = 1; }
    registerType('dummy', Dummy);

    const store = createMemoryTree();
    await store.set(createNode('/n', 'item', {}, {
      dummy: { $type: 'dummy', x: 1 },
    }));

    await assert.rejects(
      () => executeAction(store, '/n', 'dummy', undefined, 'nonexistent'),
      (e: any) => { assert.equal(e.code, 'BAD_REQUEST'); return true; },
    );
  });

  it('pure action (no patches) does not persist', async () => {
    register('reader', 'action:read', (_actx: any, data: any) => {
      return { echo: data };
    });

    const store = createMemoryTree();
    await store.set(createNode('/r', 'reader'));

    const result = await executeAction(store, '/r', undefined, undefined, 'read', { msg: 'hello' });
    assert.deepEqual(result, { echo: { msg: 'hello' } });
    // $rev stays at 1 — no store.set() called
    const node = await store.get('/r');
    assert.equal(node!.$rev, 1);
  });

  it('executeAction throws NOT_FOUND for missing node (no type)', async () => {
    const store = createMemoryTree();
    await assert.rejects(
      () => executeAction(store, '/missing', undefined, undefined, 'x'),
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

    const store = createMemoryTree();
    await store.set(createNode('/e', 'item', {}, {
      emitter: { $type: 'emitter' },
    }));

    const collected: unknown[] = [];
    for await (const item of executeStream(store, '/e', 'emitter', undefined, 'emit', { n: 3 })) {
      collected.push(item);
    }
    assert.deepEqual(collected, [0, 1, 2]);
  });

  it('executeStream: BAD_REQUEST for non-generator action', async () => {
    class Plain { run() { return 42; } }
    registerType('plain', Plain);

    const store = createMemoryTree();
    await store.set(createNode('/p', 'item', {}, { plain: { $type: 'plain' } }));

    await assert.rejects(
      async () => {
        for await (const _ of executeStream(store, '/p', 'plain', undefined, 'run')) { /* */ }
      },
      (e: any) => { assert.equal(e.code, 'BAD_REQUEST'); return true; },
    );
  });

  it('setComponent updates single component', async () => {
    const store = createMemoryTree();
    await store.set(createNode('/s', 'item', {}, {
      meta: { $type: 'meta', title: 'old' },
    }));

    await setComponent(store, '/s', 'meta', { $type: 'meta', title: 'new' });

    const node = await store.get('/s');
    assert.equal((node as any).meta.title, 'new');
  });

  it('setComponent throws NOT_FOUND for missing node', async () => {
    const store = createMemoryTree();
    await assert.rejects(
      () => setComponent(store, '/missing', 'x', {}),
      (e: any) => { assert.equal(e.code, 'NOT_FOUND'); return true; },
    );
  });

  it('setComponent throws CONFLICT on stale rev', async () => {
    const store = createMemoryTree();
    await store.set(createNode('/s', 'item'));
    await assert.rejects(
      () => setComponent(store, '/s', 'x', {}, 999),
      (e: any) => { assert.equal(e.code, 'CONFLICT'); return true; },
    );
  });

  it('applyTemplate copies children to target', async () => {
    const store = createMemoryTree();
    await store.set(createNode('/templates/blog', 'template'));
    await store.set(createNode('/templates/blog/header', 'block', { text: 'Hello' }));
    await store.set(createNode('/templates/blog/body', 'block', { text: 'Content' }));

    // Existing children at target get removed
    await store.set(createNode('/pages/p1', 'page'));
    await store.set(createNode('/pages/p1/old', 'block'));

    const result = await applyTemplate(store, '/templates/blog', '/pages/p1');
    assert.equal(result.blocks, 2);
    assert.equal(result.applied, '/templates/blog');

    // Old child gone
    assert.equal(await store.get('/pages/p1/old'), undefined);

    // New children present
    const header = await store.get('/pages/p1/header');
    assert.ok(header);
    assert.equal((header as any).text, 'Hello');
  });

  it('applyTemplate throws NOT_FOUND for missing template', async () => {
    const store = createMemoryTree();
    await assert.rejects(
      () => applyTemplate(store, '/missing', '/target'),
      (e: any) => { assert.equal(e.code, 'NOT_FOUND'); return true; },
    );
  });
});

// ── fs store: OCC + remove edge cases ──

describe('FsStore OCC', () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('OCC rejects stale rev', async () => {
    dir = await mkdtemp(join(tmpdir(), 'treenity-fs-occ-'));
    const store = await createFsTree(dir);

    await store.set(createNode('/n', 'item')); // rev becomes 1
    const node = await store.get('/n');

    // Simulate stale read
    await store.set({ ...node!, $rev: node!.$rev }); // rev becomes 2

    // Now try with stale rev=1
    await assert.rejects(() => store.set({ ...node!, $rev: 1 }));
  });

  it('OCC throws when node does not exist but rev provided', async () => {
    dir = await mkdtemp(join(tmpdir(), 'treenity-fs-occ2-'));
    const store = await createFsTree(dir);

    await assert.rejects(
      () => store.set({ ...createNode('/ghost', 'item'), $rev: 1 }),
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
      properties: { name: { type: 'string' } },
    }));

    const store = withValidation(createMemoryTree());

    await assert.rejects(
      () => store.set({ $path: '/v', $type: 'x', comp: { $type: 'typed', name: 123 } } as any),
    );
  });

  it('rejects string where number expected', async () => {
    register('numtype', 'schema', () => ({
      properties: { count: { type: 'number' } },
    }));

    const store = withValidation(createMemoryTree());

    await assert.rejects(
      () => store.set({ $path: '/v', $type: 'x', comp: { $type: 'numtype', count: 'not a number' } } as any),
    );
  });

  it('rejects number where boolean expected', async () => {
    register('booltype', 'schema', () => ({
      properties: { flag: { type: 'boolean' } },
    }));

    const store = withValidation(createMemoryTree());

    await assert.rejects(
      () => store.set({ $path: '/v', $type: 'x', comp: { $type: 'booltype', flag: 42 } } as any),
    );
  });

  it('allows null/undefined values (optional by default)', async () => {
    register('opttype', 'schema', () => ({
      properties: { name: { type: 'string' } },
    }));

    const store = withValidation(createMemoryTree());
    // null and undefined should pass — optional by default
    await store.set({ $path: '/v', $type: 'x', comp: { $type: 'opttype', name: null } } as any);
    await store.set({ $path: '/v2', $type: 'x', comp: { $type: 'opttype' } } as any);
  });

  it('skips components without schema', async () => {
    const store = withValidation(createMemoryTree());
    await store.set({ $path: '/v', $type: 'x', comp: { $type: 'untyped', anything: 'goes' } } as any);
    const node = await store.get('/v');
    assert.ok(node, 'node should be stored');
    assert.equal((node as any).comp.anything, 'goes');
  });

  it('skips schemas without properties', async () => {
    register('emptyschema', 'schema', () => ({}));

    const store = withValidation(createMemoryTree());
    await store.set({ $path: '/v', $type: 'x', comp: { $type: 'emptyschema', x: 1 } } as any);
    const node = await store.get('/v');
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
    const ts = createTypesStore(backing);
    const result = await ts.get('/sys/types/nonexistent');
    assert.equal(result, undefined);
  });

  it('remove throws on registry type', async () => {
    register('vendor.widget', 'schema', () => ({ properties: {} }));
    const backing = createMemoryTree();
    const ts = createTypesStore(backing);

    await assert.rejects(() => ts.remove('/sys/types/vendor/widget'));
  });

  it('remove works on dynamic (stored) type', async () => {
    const backing = createMemoryTree();
    await backing.set(createNode('/sys/types/custom/thing', 'type'));

    const ts = createTypesStore(backing);
    const result = await ts.remove('/sys/types/custom/thing');
    assert.equal(result, true);
  });

  it('set goes to backing store', async () => {
    const backing = createMemoryTree();
    const ts = createTypesStore(backing);
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
