import { createNode } from '#core';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { createFsTree } from './fs';
import { mapSiftQuery } from './query';

describe('FsStore', () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function setup() {
    dir = await mkdtemp(join(tmpdir(), 'treenity-fs-test-'));
    return createFsTree(dir);
  }

  function exists(path: string) {
    return stat(join(dir, path)).then(() => true, () => false);
  }

  it('set and get', async () => {
    const store = await setup();
    const node = createNode('/users/alice', 'user');
    await store.set(node);
    assert.deepEqual(await store.get('/users/alice'), node);
  });

  it('get returns undefined for missing', async () => {
    const store = await setup();
    assert.equal(await store.get('/nope'), undefined);
  });

  it('getChildren direct', async () => {
    const store = await setup();
    await store.set(createNode('/app', 'root'));
    await store.set(createNode('/app/a', 'item'));
    await store.set(createNode('/app/b', 'item'));
    await store.set(createNode('/app/a/deep', 'item'));

    const children = await store.getChildren('/app');
    assert.equal(children.items.length, 2);
    assert.deepEqual(children.items.map((n) => n.$path).sort(), ['/app/a', '/app/b']);
  });

  it('getChildren with depth', async () => {
    const store = await setup();
    await store.set(createNode('/x', 'root'));
    await store.set(createNode('/x/a', 'item'));
    await store.set(createNode('/x/a/b', 'item'));
    await store.set(createNode('/x/a/b/c', 'item'));

    const d2 = await store.getChildren('/x', { depth: 2 });
    assert.equal(d2.items.length, 2);
    assert.deepEqual(d2.items.map((n) => n.$path).sort(), ['/x/a', '/x/a/b']);

    const all = await store.getChildren('/x', { depth: Infinity });
    assert.equal(all.items.length, 3);
  });

  it('remove', async () => {
    const store = await setup();
    await store.set(createNode('/z', 'item'));
    assert.equal(await store.remove('/z'), true);
    assert.equal(await store.get('/z'), undefined);
    assert.equal(await store.remove('/z'), false);
  });

  it('handles nested paths', async () => {
    const store = await setup();
    const node = createNode('/a/b/c/d/e', 'deep');
    await store.set(node);
    assert.deepEqual(await store.get('/a/b/c/d/e'), node);
  });

  // ── Storage format tests ──

  it('leaf node stored as name.json', async () => {
    const store = await setup();
    await store.set(createNode('/leaf', 'item'));

    assert.ok(await exists('leaf.json'), 'leaf.json should exist');
    assert.ok(!(await exists('leaf/$.json')), 'leaf/$.json should NOT exist');
  });

  it('root always stored as $/$.json (dir form)', async () => {
    const store = await setup();
    await store.set(createNode('/', 'root'));

    assert.ok(await exists('$.json'), 'root $.json should exist');
  });

  it('auto-promotes leaf to dir when child is created', async () => {
    const store = await setup();
    await store.set(createNode('/parent', 'dir'));

    // Initially leaf form
    assert.ok(await exists('parent.json'), 'should be leaf form');
    assert.ok(!(await exists('parent/$.json')), 'should NOT be dir form yet');

    // Add child — parent must be promoted to dir form
    await store.set(createNode('/parent/child', 'item'));

    assert.ok(await exists('parent/$.json'), 'parent should now be dir form');
    assert.ok(!(await exists('parent.json')), 'parent.json should be gone');
    assert.ok(await exists('parent/child.json'), 'child should be leaf form');

    // Both nodes still readable
    const parent = await store.get('/parent');
    assert.equal(parent?.$type, 't.dir');
    const child = await store.get('/parent/child');
    assert.equal(child?.$type, 't.item');
  });

  it('auto-demotes dir to leaf when last child is removed', async () => {
    const store = await setup();
    await store.set(createNode('/parent', 'dir'));
    await store.set(createNode('/parent/child', 'item'));

    // Parent in dir form
    assert.ok(await exists('parent/$.json'));

    // Remove the child
    await store.remove('/parent/child');

    // Parent should be demoted to leaf form
    assert.ok(await exists('parent.json'), 'parent should be demoted to leaf form');
    assert.ok(!(await exists('parent/$.json')), 'parent dir form should be gone');

    // Parent still readable
    const parent = await store.get('/parent');
    assert.equal(parent?.$type, 't.dir');
  });

  it('node with children stays in dir form on re-save', async () => {
    const store = await setup();
    await store.set(createNode('/p', 'dir'));
    await store.set(createNode('/p/a', 'item'));

    // Re-save parent — should stay dir form because it has children
    const p = await store.get('/p');
    await store.set({ ...p!, $rev: p!.$rev });

    assert.ok(await exists('p/$.json'), 'should remain dir form');
    assert.ok(!(await exists('p.json')), 'should not have leaf form');
  });

  it('deep promotion chain', async () => {
    const store = await setup();
    await store.set(createNode('/a', 'n'));
    await store.set(createNode('/a/b', 'n'));

    // Both start as leaves where possible
    assert.ok(await exists('a/$.json'), 'a has child b → dir form');
    assert.ok(await exists('a/b.json'), 'b is leaf');

    // Create deep child — b must promote
    await store.set(createNode('/a/b/c', 'n'));

    assert.ok(await exists('a/b/$.json'), 'b promoted to dir form');
    assert.ok(!(await exists('a/b.json')), 'b.json gone');
    assert.ok(await exists('a/b/c.json'), 'c is leaf');
  });

  it('deep demotion chain', async () => {
    const store = await setup();
    await store.set(createNode('/a', 'n'));
    await store.set(createNode('/a/b', 'n'));
    await store.set(createNode('/a/b/c', 'n'));

    // Remove c — b should demote, a should demote too (b.json is still a child of a)
    await store.remove('/a/b/c');

    assert.ok(await exists('a/b.json'), 'b demoted to leaf');
    assert.ok(await exists('a/$.json'), 'a still dir form (has child b.json)');

    // Remove b — a should demote
    await store.remove('/a/b');

    assert.ok(await exists('a.json'), 'a demoted to leaf');
    assert.ok(!(await exists('a/$.json')), 'a dir form gone');
  });

  it('data integrity through promotion/demotion', async () => {
    const store = await setup();
    const parent = createNode('/p', 'dir', { label: 'parent' });
    await store.set(parent);

    const child = createNode('/p/c', 'item', { label: 'child' });
    await store.set(child);

    // Verify data survived promotion
    const p = await store.get('/p');
    assert.equal((p as any).label, 'parent');

    await store.remove('/p/c');

    // Verify data survived demotion
    const p2 = await store.get('/p');
    assert.equal((p2 as any).label, 'parent');
  });

  it('OCC still works across storage forms', async () => {
    const store = await setup();
    await store.set(createNode('/n', 'item'));
    const n = await store.get('/n');

    // Promote by adding child
    await store.set(createNode('/n/child', 'item'));

    // OCC should still work on promoted node
    await assert.rejects(() => store.set({ ...n!, $rev: 999 }));
  });

  it('getChildren applies sift query filter', async () => {
    const store = await setup();
    await store.set(createNode('/tasks', 'dir'));
    await store.set(createNode('/tasks/t1', 'task', { status: 'pending' }));
    await store.set(createNode('/tasks/t2', 'task', { status: 'done' }));
    await store.set(createNode('/tasks/t3', 'task', { status: 'pending' }));

    const pending = await store.getChildren('/tasks', {
      query: mapSiftQuery({ $type: 't.task', status: 'pending' }) as Record<string, unknown>,
    });
    assert.equal(pending.items.length, 2);
    assert.deepEqual(pending.items.map(n => n.$path).sort(), ['/tasks/t1', '/tasks/t3']);
  });

  it('getChildren sift filter excludes non-matching types', async () => {
    const store = await setup();
    await store.set(createNode('/parent', 'config'));
    await store.set(createNode('/parent/mount-a', 'mount-point'));
    await store.set(createNode('/parent/mount-b', 'mount-point'));
    await store.set(createNode('/parent/t1', 'task', { status: 'pending' }));
    await store.set(createNode('/parent/t2', 'task', { status: 'done' }));

    const tasks = await store.getChildren('/parent', {
      query: mapSiftQuery({ $type: 't.task' }) as Record<string, unknown>,
    });
    assert.equal(tasks.items.length, 2);
    assert.ok(tasks.items.every(n => n.$type === 't.task'));
  });
});
