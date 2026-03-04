import { createNode, register, unregister } from '#core';
import { createMemoryTree } from '#tree';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { withMigration } from './migrate';

const TEST_TYPE = 'test.migrated';

describe('withMigration', () => {
  afterEach(() => {
    unregister(TEST_TYPE, 'migrate');
  });

  it('passes through nodes without migrations', async () => {
    const inner = createMemoryTree();
    const store = withMigration(inner);
    const node = createNode('/a', 'dir', { label: 'hi' });
    await inner.set(node);

    const got = await store.get('/a');
    assert.equal(got?.label, 'hi');
    assert.equal((got as any).$v, undefined);
  });

  it('runs migration chain on read for v0 node', async () => {
    register(TEST_TYPE, 'migrate', () => ({
      1: (n: any) => { n.items = Array.isArray(n.items) ? n.items : []; },
      2: (n: any) => { n.label ??= 'default'; },
    }));

    const inner = createMemoryTree();
    const store = withMigration(inner);
    await inner.set(createNode('/a', TEST_TYPE, { items: 'old-string' }));

    const got = await store.get('/a');
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
    const store = withMigration(inner);
    await inner.set({ ...createNode('/a', TEST_TYPE), $v: 1 } as any);

    const got = await store.get('/a');
    assert.equal(ran1, false);
    assert.equal(got?.upgraded, true);
    assert.equal((got as any).$v, 2);
  });

  it('returns node unchanged when already at current version', async () => {
    register(TEST_TYPE, 'migrate', () => ({
      1: (n: any) => { n.touched = true; },
    }));

    const inner = createMemoryTree();
    const store = withMigration(inner);
    await inner.set({ ...createNode('/a', TEST_TYPE), $v: 1 } as any);

    const got = await store.get('/a');
    assert.equal(got?.touched, undefined);
    assert.equal((got as any).$v, 1);
  });

  it('stamps $v on set()', async () => {
    register(TEST_TYPE, 'migrate', () => ({
      1: (_n: any) => {},
      2: (_n: any) => {},
    }));

    const inner = createMemoryTree();
    const store = withMigration(inner);
    const node = createNode('/a', TEST_TYPE, { x: 1 });
    await store.set(node);

    // Read from inner store to see what was actually persisted
    const raw = await inner.get('/a');
    assert.equal((raw as any).$v, 2);
  });

  it('migrates children in getChildren()', async () => {
    register(TEST_TYPE, 'migrate', () => ({
      1: (n: any) => { n.fixed = true; },
    }));

    const inner = createMemoryTree();
    const store = withMigration(inner);
    await inner.set(createNode('/parent', 'dir'));
    await inner.set(createNode('/parent/a', TEST_TYPE, { val: 1 }));
    await inner.set(createNode('/parent/b', TEST_TYPE, { val: 2 }));

    const { items } = await store.getChildren('/parent');
    assert.equal(items.length, 2);
    for (const item of items) {
      assert.equal(item.fixed, true);
      assert.equal((item as any).$v, 1);
    }
  });

  it('does not mutate the original stored node', async () => {
    register(TEST_TYPE, 'migrate', () => ({
      1: (n: any) => { n.data = 'migrated'; },
    }));

    const inner = createMemoryTree();
    const store = withMigration(inner);
    await inner.set(createNode('/a', TEST_TYPE, { data: 'old' }));

    await store.get('/a');

    // Inner store should still have original data
    const raw = await inner.get('/a');
    assert.equal(raw?.data, 'old');
    assert.equal((raw as any).$v, undefined);
  });
});
