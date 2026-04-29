import { createNode } from '#core';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
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
    dir = await mkdtemp(join(tmpdir(), 'treenix-fs-test-'));
    return createFsTree(dir);
  }

  function exists(path: string) {
    return stat(join(dir, path)).then(() => true, () => false);
  }

  it('set and get', async () => {
    const tree = await setup();
    const node = createNode('/users/alice', 'user');
    await tree.set(node);
    assert.deepEqual(await tree.get('/users/alice'), node);
  });

  it('get returns undefined for missing', async () => {
    const tree = await setup();
    assert.equal(await tree.get('/nope'), undefined);
  });

  it('getChildren direct', async () => {
    const tree = await setup();
    await tree.set(createNode('/app', 'root'));
    await tree.set(createNode('/app/a', 'item'));
    await tree.set(createNode('/app/b', 'item'));
    await tree.set(createNode('/app/a/deep', 'item'));

    const children = await tree.getChildren('/app');
    assert.equal(children.items.length, 2);
    assert.deepEqual(children.items.map((n) => n.$path).sort(), ['/app/a', '/app/b']);
  });

  it('getChildren with depth', async () => {
    const tree = await setup();
    await tree.set(createNode('/x', 'root'));
    await tree.set(createNode('/x/a', 'item'));
    await tree.set(createNode('/x/a/b', 'item'));
    await tree.set(createNode('/x/a/b/c', 'item'));

    const d2 = await tree.getChildren('/x', { depth: 2 });
    assert.equal(d2.items.length, 2);
    assert.deepEqual(d2.items.map((n) => n.$path).sort(), ['/x/a', '/x/a/b']);

    const all = await tree.getChildren('/x', { depth: Infinity });
    assert.equal(all.items.length, 3);
  });

  it('remove', async () => {
    const tree = await setup();
    await tree.set(createNode('/z', 'item'));
    assert.equal(await tree.remove('/z'), true);
    assert.equal(await tree.get('/z'), undefined);
    assert.equal(await tree.remove('/z'), false);
  });

  it('handles nested paths', async () => {
    const tree = await setup();
    const node = createNode('/a/b/c/d/e', 'deep');
    await tree.set(node);
    assert.deepEqual(await tree.get('/a/b/c/d/e'), node);
  });

  // ── Storage format tests ──

  it('leaf node stored as name.json', async () => {
    const tree = await setup();
    await tree.set(createNode('/leaf', 'item'));

    assert.ok(await exists('leaf.json'), 'leaf.json should exist');
    assert.ok(!(await exists('leaf/$.json')), 'leaf/$.json should NOT exist');
  });

  it('root always stored as $/$.json (dir form)', async () => {
    const tree = await setup();
    await tree.set(createNode('/', 'root'));

    assert.ok(await exists('$.json'), 'root $.json should exist');
  });

  it('auto-promotes leaf to dir when child is created', async () => {
    const tree = await setup();
    await tree.set(createNode('/parent', 'dir'));

    // Initially leaf form
    assert.ok(await exists('parent.json'), 'should be leaf form');
    assert.ok(!(await exists('parent/$.json')), 'should NOT be dir form yet');

    // Add child — parent must be promoted to dir form
    await tree.set(createNode('/parent/child', 'item'));

    assert.ok(await exists('parent/$.json'), 'parent should now be dir form');
    assert.ok(!(await exists('parent.json')), 'parent.json should be gone');
    assert.ok(await exists('parent/child.json'), 'child should be leaf form');

    // Both nodes still readable
    const parent = await tree.get('/parent');
    assert.equal(parent?.$type, 't.dir');
    const child = await tree.get('/parent/child');
    assert.equal(child?.$type, 't.item');
  });

  it('auto-demotes dir to leaf when last child is removed', async () => {
    const tree = await setup();
    await tree.set(createNode('/parent', 'dir'));
    await tree.set(createNode('/parent/child', 'item'));

    // Parent in dir form
    assert.ok(await exists('parent/$.json'));

    // Remove the child
    await tree.remove('/parent/child');

    // Parent should be demoted to leaf form
    assert.ok(await exists('parent.json'), 'parent should be demoted to leaf form');
    assert.ok(!(await exists('parent/$.json')), 'parent dir form should be gone');

    // Parent still readable
    const parent = await tree.get('/parent');
    assert.equal(parent?.$type, 't.dir');
  });

  it('node with children stays in dir form on re-save', async () => {
    const tree = await setup();
    await tree.set(createNode('/p', 'dir'));
    await tree.set(createNode('/p/a', 'item'));

    // Re-save parent — should stay dir form because it has children
    const p = await tree.get('/p');
    await tree.set({ ...p!, $rev: p!.$rev });

    assert.ok(await exists('p/$.json'), 'should remain dir form');
    assert.ok(!(await exists('p.json')), 'should not have leaf form');
  });

  it('deep promotion chain', async () => {
    const tree = await setup();
    await tree.set(createNode('/a', 'n'));
    await tree.set(createNode('/a/b', 'n'));

    // Both start as leaves where possible
    assert.ok(await exists('a/$.json'), 'a has child b → dir form');
    assert.ok(await exists('a/b.json'), 'b is leaf');

    // Create deep child — b must promote
    await tree.set(createNode('/a/b/c', 'n'));

    assert.ok(await exists('a/b/$.json'), 'b promoted to dir form');
    assert.ok(!(await exists('a/b.json')), 'b.json gone');
    assert.ok(await exists('a/b/c.json'), 'c is leaf');
  });

  it('deep demotion chain', async () => {
    const tree = await setup();
    await tree.set(createNode('/a', 'n'));
    await tree.set(createNode('/a/b', 'n'));
    await tree.set(createNode('/a/b/c', 'n'));

    // Remove c — b should demote, a should demote too (b.json is still a child of a)
    await tree.remove('/a/b/c');

    assert.ok(await exists('a/b.json'), 'b demoted to leaf');
    assert.ok(await exists('a/$.json'), 'a still dir form (has child b.json)');

    // Remove b — a should demote
    await tree.remove('/a/b');

    assert.ok(await exists('a.json'), 'a demoted to leaf');
    assert.ok(!(await exists('a/$.json')), 'a dir form gone');
  });

  it('data integrity through promotion/demotion', async () => {
    const tree = await setup();
    const parent = createNode('/p', 'dir', { label: 'parent' });
    await tree.set(parent);

    const child = createNode('/p/c', 'item', { label: 'child' });
    await tree.set(child);

    // Verify data survived promotion
    const p = await tree.get('/p');
    assert.equal((p as any).label, 'parent');

    await tree.remove('/p/c');

    // Verify data survived demotion
    const p2 = await tree.get('/p');
    assert.equal((p2 as any).label, 'parent');
  });

  it('OCC still works across storage forms', async () => {
    const tree = await setup();
    await tree.set(createNode('/n', 'item'));
    const n = await tree.get('/n');

    // Promote by adding child
    await tree.set(createNode('/n/child', 'item'));

    // OCC should still work on promoted node
    await assert.rejects(() => tree.set({ ...n!, $rev: 999 }));
  });

  it('getChildren applies sift query filter', async () => {
    const tree = await setup();
    await tree.set(createNode('/tasks', 'dir'));
    await tree.set(createNode('/tasks/t1', 'task', { status: 'pending' }));
    await tree.set(createNode('/tasks/t2', 'task', { status: 'done' }));
    await tree.set(createNode('/tasks/t3', 'task', { status: 'pending' }));

    const pending = await tree.getChildren('/tasks', {
      query: mapSiftQuery({ $type: 't.task', status: 'pending' }) as Record<string, unknown>,
    });
    assert.equal(pending.items.length, 2);
    assert.deepEqual(pending.items.map(n => n.$path).sort(), ['/tasks/t1', '/tasks/t3']);
  });

  it('getChildren sift filter excludes non-matching types', async () => {
    const tree = await setup();
    await tree.set(createNode('/parent', 'config'));
    await tree.set(createNode('/parent/mount-a', 'mount-point'));
    await tree.set(createNode('/parent/mount-b', 'mount-point'));
    await tree.set(createNode('/parent/t1', 'task', { status: 'pending' }));
    await tree.set(createNode('/parent/t2', 'task', { status: 'done' }));

    const tasks = await tree.getChildren('/parent', {
      query: mapSiftQuery({ $type: 't.task' }) as Record<string, unknown>,
    });
    assert.equal(tasks.items.length, 2);
    assert.ok(tasks.items.every(n => n.$type === 't.task'));
  });

  // ── Symlink protection tests ──

  it('blocks symlink that escapes root', async () => {
    const tree = await setup();
    const outsideDir = await mkdtemp(join(tmpdir(), 'treenix-fs-escape-'));
    try {
      // Symlink inside root pointing outside
      await symlink(outsideDir, join(dir, 'escape'));
      // Trying to set a node under the symlinked path should fail
      await assert.rejects(
        () => tree.set({ $path: '/escape/secret', $type: 't.test' }),
        /symlink|traversal/i,
      );
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  it('skips symlinks in getChildren walk', async () => {
    const tree = await setup();
    await tree.set(createNode('/safe', 'dir'));
    await tree.set(createNode('/safe/real', 'test'));
    // Create symlink inside safe/ pointing elsewhere
    const outsideDir = await mkdtemp(join(tmpdir(), 'treenix-fs-sym-'));
    await writeFile(join(outsideDir, 'evil.json'), '{"$path":"/safe/evil","$type":"t.hack"}');
    // safe/ is in dir form (has child real.json), so symlink goes inside safe/
    await symlink(outsideDir, join(dir, 'safe', 'linked'));
    try {
      const { items } = await tree.getChildren('/safe');
      const paths = items.map(n => n.$path);
      assert.ok(!paths.includes('/safe/evil'), 'should not follow symlinks');
      assert.ok(paths.includes('/safe/real'), 'should include real children');
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  it('creates files with 0o600 permissions', async () => {
    const tree = await setup();
    await tree.set(createNode('/secret', 'test'));
    const s = await stat(join(dir, 'secret.json'));
    assert.equal(s.mode & 0o777, 0o600);
  });

  it('does not persist $path in leaf file body; reconstructs from location on read', async () => {
    const tree = await setup();
    await tree.set(createNode('/foo/bar', 'test', { x: 1 }));

    // On-disk body must not contain $path — location is authoritative
    const leaf = join(dir, 'foo', 'bar.json');
    const raw = JSON.parse(await readFile(leaf, 'utf-8'));
    assert.equal(raw.$path, undefined);
    assert.equal(raw.$type, 't.test');
    assert.equal(raw.x, 1);

    // Read via get() — $path must be stamped from logical path
    const read = await tree.get('/foo/bar');
    assert.equal(read?.$path, '/foo/bar');
    assert.equal(read?.$type, 't.test');
    assert.equal(read?.x, 1);

    // Read via getChildren — $path must be stamped from FS location
    const kids = await tree.getChildren('/foo');
    assert.deepEqual(kids.items.map(n => n.$path), ['/foo/bar']);

    // Physically move the file — get() must return node with updated $path
    await mkdir(join(dir, 'moved'), { recursive: true });
    await rename(leaf, join(dir, 'moved', 'bar.json'));
    const moved = await tree.get('/moved/bar');
    assert.equal(moved?.$path, '/moved/bar');
    assert.equal(moved?.x, 1);
  });

  it('does not persist $path in dir-form $.json body', async () => {
    const tree = await setup();
    await tree.set(createNode('/parent', 'test', { a: 1 }));
    await tree.set(createNode('/parent/child', 'test')); // forces promotion to dir form
    const raw = JSON.parse(await readFile(join(dir, 'parent', '$.json'), 'utf-8'));
    assert.equal(raw.$path, undefined);
    assert.equal(raw.$type, 't.test');
    assert.equal(raw.a, 1);
  });
});
