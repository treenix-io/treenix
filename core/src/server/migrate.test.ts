import { createNode, register, unregister } from '#core';
import { createMemoryTree } from '#tree';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { withMigration } from './migrate';

const TEST_TYPE = 'test.migrated';
const COMP_TYPE = 'test.comp.migrated';

describe('withMigration', () => {
  afterEach(() => {
    unregister(TEST_TYPE, 'migrate');
    try { unregister(COMP_TYPE, 'migrate'); } catch {}
  });

  it('passes through nodes without migrations', async () => {
    const inner = createMemoryTree();
    const tree = withMigration(inner);
    const node = createNode('/a', 'dir', { label: 'hi' });
    await inner.set(node);

    const got = await tree.get('/a');
    assert.equal(got?.label, 'hi');
    assert.equal((got as any).$v, undefined);
  });

  it('runs migration chain on read for v0 node', async () => {
    register(TEST_TYPE, 'migrate', () => ({
      1: (n: any) => { n.items = Array.isArray(n.items) ? n.items : []; },
      2: (n: any) => { n.label ??= 'default'; },
    }));

    const inner = createMemoryTree();
    const tree = withMigration(inner);
    await inner.set(createNode('/a', TEST_TYPE, { items: 'old-string' }));

    const got = await tree.get('/a');
    assert.deepEqual(got?.items, []);
    assert.equal(got?.label, 'default');
    assert.equal((got as any).$v, 2);
  });

  it('skips already-applied migrations', async () => {
    let ran1 = false;
    register(TEST_TYPE, 'migrate', () => ({
      1: (_n: any) => { ran1 = true; },
      2: (n: any) => { n.upgraded = true; },
    }));

    const inner = createMemoryTree();
    const tree = withMigration(inner);
    await inner.set({ ...createNode('/a', TEST_TYPE), $v: 1 } as any);

    const got = await tree.get('/a');
    assert.equal(ran1, false);
    assert.equal(got?.upgraded, true);
    assert.equal((got as any).$v, 2);
  });

  it('returns node unchanged when already at current version', async () => {
    register(TEST_TYPE, 'migrate', () => ({
      1: (n: any) => { n.touched = true; },
    }));

    const inner = createMemoryTree();
    const tree = withMigration(inner);
    await inner.set({ ...createNode('/a', TEST_TYPE), $v: 1 } as any);

    const got = await tree.get('/a');
    assert.equal(got?.touched, undefined);
    assert.equal((got as any).$v, 1);
  });

  it('stamps $v on set()', async () => {
    register(TEST_TYPE, 'migrate', () => ({
      1: (_n: any) => {},
      2: (_n: any) => {},
    }));

    const inner = createMemoryTree();
    const tree = withMigration(inner);
    const node = createNode('/a', TEST_TYPE, { x: 1 });
    await tree.set(node);

    const raw = await inner.get('/a');
    assert.equal((raw as any).$v, 2);
  });

  it('migrates children in getChildren()', async () => {
    register(TEST_TYPE, 'migrate', () => ({
      1: (n: any) => { n.fixed = true; },
    }));

    const inner = createMemoryTree();
    const tree = withMigration(inner);
    await inner.set(createNode('/parent', 'dir'));
    await inner.set(createNode('/parent/a', TEST_TYPE, { val: 1 }));
    await inner.set(createNode('/parent/b', TEST_TYPE, { val: 2 }));

    const { items } = await tree.getChildren('/parent');
    assert.equal(items.length, 2);
    for (const item of items) {
      assert.equal(item.fixed, true);
      assert.equal((item as any).$v, 1);
    }
  });

  it('write-back persists migrated data to inner tree', async () => {
    register(TEST_TYPE, 'migrate', () => ({
      1: (n: any) => { n.data = 'migrated'; },
    }));

    const inner = createMemoryTree();
    const tree = withMigration(inner);
    await inner.set(createNode('/a', TEST_TYPE, { data: 'old' }));

    await tree.get('/a');

    // Write-back: inner tree now has migrated data
    const raw = await inner.get('/a');
    assert.equal(raw?.data, 'migrated');
    assert.equal((raw as any).$v, 1);
  });

  it('WeakSet skips already-checked nodes on second read', async () => {
    let callCount = 0;
    register(TEST_TYPE, 'migrate', () => ({
      1: (n: any) => { callCount++; n.x = true; },
    }));

    const inner = createMemoryTree();
    const tree = withMigration(inner);
    await inner.set(createNode('/a', TEST_TYPE));

    await tree.get('/a');
    assert.equal(callCount, 1);

    // Second read — same object from cache, WeakSet skips
    await tree.get('/a');
    assert.equal(callCount, 1);
  });

  // ── Component-level migration ──

  it('migrates named components on read', async () => {
    register(COMP_TYPE, 'migrate', () => ({
      1: (data: any) => { data.fixed = true; },
    }));

    const inner = createMemoryTree();
    const tree = withMigration(inner);
    await inner.set({
      ...createNode('/a', 'dir'),
      mount: { $type: COMP_TYPE, broken: true },
    });

    const got = await tree.get('/a');
    assert.equal((got as any).mount.fixed, true);
    assert.equal((got as any).mount.$v, 1);
  });

  it('stamps $v on components during set()', async () => {
    register(COMP_TYPE, 'migrate', () => ({
      1: (_data: any) => {},
    }));

    const inner = createMemoryTree();
    const tree = withMigration(inner);
    await tree.set({
      ...createNode('/a', 'dir'),
      mount: { $type: COMP_TYPE, val: 1 },
    });

    const raw = await inner.get('/a');
    assert.equal((raw as any).mount.$v, 1);
  });

  it('migrates both node-level and component-level', async () => {
    register(TEST_TYPE, 'migrate', () => ({
      1: (n: any) => { n.nodeFixed = true; },
    }));
    register(COMP_TYPE, 'migrate', () => ({
      1: (data: any) => { data.compFixed = true; },
    }));

    const inner = createMemoryTree();
    const tree = withMigration(inner);
    await inner.set({
      ...createNode('/a', TEST_TYPE),
      extra: { $type: COMP_TYPE, val: 1 },
    });

    const got = await tree.get('/a');
    assert.equal(got?.nodeFixed, true);
    assert.equal((got as any).$v, 1);
    assert.equal((got as any).extra.compFixed, true);
    assert.equal((got as any).extra.$v, 1);
  });

  it('write-back persists component migration', async () => {
    register(COMP_TYPE, 'migrate', () => ({
      1: (data: any) => {
        if (!data['source']) data['source'] = '/';
        if (!data['match']) data['match'] = {};
      },
    }));

    const inner = createMemoryTree();
    const tree = withMigration(inner);
    await inner.set({
      ...createNode('/a', 'dir'),
      mount: { $type: COMP_TYPE },
    });

    await tree.get('/a');

    const raw = await inner.get('/a');
    assert.equal((raw as any).mount.source, '/');
    assert.deepEqual((raw as any).mount.match, {});
    assert.equal((raw as any).mount.$v, 1);
  });

  // ── Edge cases ──

  it('handles non-sequential version keys', async () => {
    const order: number[] = [];
    register(TEST_TYPE, 'migrate', () => ({
      3: (n: any) => { order.push(3); n.v3 = true; },
      7: (n: any) => { order.push(7); n.v7 = true; },
      10: (n: any) => { order.push(10); n.v10 = true; },
    }));

    const inner = createMemoryTree();
    const tree = withMigration(inner);
    await inner.set(createNode('/a', TEST_TYPE));

    const got = await tree.get('/a');
    assert.deepEqual(order, [3, 7, 10]);
    assert.equal(got?.v3, true);
    assert.equal(got?.v7, true);
    assert.equal(got?.v10, true);
    assert.equal((got as any).$v, 10);
  });

  it('skips versions up to current $v with non-sequential keys', async () => {
    const order: number[] = [];
    register(TEST_TYPE, 'migrate', () => ({
      3: (n: any) => { order.push(3); n.v3 = true; },
      7: (n: any) => { order.push(7); n.v7 = true; },
      10: (n: any) => { order.push(10); n.v10 = true; },
    }));

    const inner = createMemoryTree();
    const tree = withMigration(inner);
    await inner.set({ ...createNode('/a', TEST_TYPE), $v: 5 } as any);

    const got = await tree.get('/a');
    assert.deepEqual(order, [7, 10]);
    assert.equal(got?.v3, undefined);
    assert.equal(got?.v7, true);
    assert.equal((got as any).$v, 10);
  });

  it('migration can delete fields', async () => {
    register(TEST_TYPE, 'migrate', () => ({
      1: (n: any) => { delete n.legacy; delete n.deprecated; },
    }));

    const inner = createMemoryTree();
    const tree = withMigration(inner);
    await inner.set(createNode('/a', TEST_TYPE, { legacy: 'old', deprecated: 42, keep: 'yes' }));

    const got = await tree.get('/a');
    assert.equal(got?.legacy, undefined);
    assert.equal(got?.deprecated, undefined);
    assert.equal(got?.keep, 'yes');
    assert.equal('legacy' in (got ?? {}), false);
  });

  it('migration can rename fields', async () => {
    register(TEST_TYPE, 'migrate', () => ({
      1: (n: any) => { n.deadline = n.dueDate; delete n.dueDate; },
    }));

    const inner = createMemoryTree();
    const tree = withMigration(inner);
    await inner.set(createNode('/a', TEST_TYPE, { dueDate: '2026-04-01' }));

    const got = await tree.get('/a');
    assert.equal(got?.deadline, '2026-04-01');
    assert.equal('dueDate' in (got ?? {}), false);
  });

  it('migration can restructure nested data', async () => {
    register(TEST_TYPE, 'migrate', () => ({
      1: (n: any) => {
        // flatten { config: { timeout: 5 } } → { timeout: 5 }
        if (n.config && typeof n.config === 'object') {
          Object.assign(n, n.config);
          delete n.config;
        }
      },
    }));

    const inner = createMemoryTree();
    const tree = withMigration(inner);
    await inner.set(createNode('/a', TEST_TYPE, { config: { timeout: 5, retries: 3 } }));

    const got = await tree.get('/a');
    assert.equal(got?.timeout, 5);
    assert.equal(got?.retries, 3);
    assert.equal('config' in (got ?? {}), false);
  });

  it('migration error propagates — does not corrupt data', async () => {
    register(TEST_TYPE, 'migrate', () => ({
      1: () => { throw new Error('migration broke'); },
    }));

    const inner = createMemoryTree();
    const tree = withMigration(inner);
    await inner.set(createNode('/a', TEST_TYPE, { safe: true }));

    await assert.rejects(() => tree.get('/a'), (err: Error) => {
      assert.match(err.message, /migration broke/);
      return true;
    });

    // Original data untouched in inner tree (structuredClone ran before throw)
    const raw = await inner.get('/a');
    assert.equal(raw?.safe, true);
    assert.equal((raw as any).$v, undefined);
  });

  it('getChildren write-back persists to inner tree', async () => {
    register(TEST_TYPE, 'migrate', () => ({
      1: (n: any) => { n.migrated = true; },
    }));

    const inner = createMemoryTree();
    const tree = withMigration(inner);
    await inner.set(createNode('/p', 'dir'));
    await inner.set(createNode('/p/a', TEST_TYPE));
    await inner.set(createNode('/p/b', TEST_TYPE));

    await tree.getChildren('/p');

    // Verify write-back happened (awaited, no setTimeout needed)
    const rawA = await inner.get('/p/a');
    const rawB = await inner.get('/p/b');
    assert.equal(rawA?.migrated, true);
    assert.equal((rawA as any).$v, 1);
    assert.equal(rawB?.migrated, true);
    assert.equal((rawB as any).$v, 1);
  });

  it('migration can add a named component', async () => {
    register(TEST_TYPE, 'migrate', () => ({
      1: (n: any) => {
        if (!n.meta) n.meta = { $type: 'test.meta', created: Date.now() };
      },
    }));

    const inner = createMemoryTree();
    const tree = withMigration(inner);
    await inner.set(createNode('/a', TEST_TYPE, { title: 'hello' }));

    const got = await tree.get('/a');
    assert.equal(got?.title, 'hello');
    assert.equal((got as any).meta.$type, 'test.meta');
    assert.equal(typeof (got as any).meta.created, 'number');
  });

  it('empty migrations object is a no-op', async () => {
    register(TEST_TYPE, 'migrate', () => ({}));

    const inner = createMemoryTree();
    const tree = withMigration(inner);
    await inner.set(createNode('/a', TEST_TYPE, { val: 1 }));

    const got = await tree.get('/a');
    assert.equal(got?.val, 1);
    assert.equal((got as any).$v, undefined);
  });
});
