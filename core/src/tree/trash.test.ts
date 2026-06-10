import { A, createNode, R, S, W } from '#core';
import { createPipeline } from '#server/server';
import { createMemoryTree, type Tree } from '#tree';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { isTrashExempt, sweepTrash, TRASH_ENTRY_TYPE, TRASH_ROOT, withTrash } from './trash';

const DAY = 86_400_000;

async function setup(): Promise<{ inner: Tree; tree: Tree }> {
  const inner = createMemoryTree();
  await inner.set(createNode('/', 'root', {}));
  await inner.set(createNode('/clients', 'dir', {}));
  await inner.set(createNode('/clients/acme', 'crm.client', { name: 'Acme' }));
  await inner.set(createNode('/clients/acme', 'crm.client', { name: 'Acme Corp' })); // $rev → 2
  await inner.set(createNode('/clients/acme/deal', 'crm.deal', { sum: 100 }));
  await inner.set(createNode('/clients/acme/deal/note', 'doc.note', { text: 'hi' }));
  return { inner, tree: withTrash(inner) };
}

async function trashEntries(tree: Tree) {
  const { items } = await tree.getChildren(TRASH_ROOT, { depth: 1 });
  return items;
}

describe('withTrash', () => {
  it('moves the removed node into /sys/trash and reports the origin', async () => {
    const { inner, tree } = await setup();

    assert.equal(await tree.remove('/clients/acme'), true);
    assert.equal(await inner.get('/clients/acme'), undefined);

    // remove() is single-node engine-wide (children live by prefix query, D04):
    // descendants stay at their paths, so nothing is ever lost.
    assert.ok(await inner.get('/clients/acme/deal'), 'children survive their parent');

    const entries = await trashEntries(inner);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].$type, TRASH_ENTRY_TYPE);
    assert.equal(entries[0].from, '/clients/acme');
    assert.equal(typeof entries[0].removedAt, 'string');

    const copy = await inner.get(`${entries[0].$path}/acme`);
    assert.equal(copy?.name, 'Acme Corp');
    assert.equal(copy?.$rev, 1, 'copy starts a fresh OCC counter, original history does not transfer');
  });

  it('system namespaces hard-delete without a trash entry', async () => {
    const { inner, tree } = await setup();
    await inner.set(createNode('/auth', 'dir', {}));
    await inner.set(createNode('/auth/sessions', 'dir', {}));
    await inner.set(createNode('/auth/sessions/tok', 'session', {}));
    await inner.set(createNode('/sys', 'dir', {}));
    await inner.set(createNode('/sys/log', 'dir', {}));

    assert.equal(await tree.remove('/auth/sessions/tok'), true);
    assert.equal(await tree.remove('/sys/log'), true);

    assert.deepEqual(await trashEntries(inner), []);
    assert.equal(await inner.get('/auth/sessions/tok'), undefined);
  });

  it('removing a trash entry purges it for real (no recursion)', async () => {
    const { inner, tree } = await setup();
    await tree.remove('/clients/acme');
    const [entry] = await trashEntries(inner);

    assert.equal(await tree.remove(entry.$path), true);
    assert.deepEqual(await trashEntries(inner), []);
  });

  it('returns false for a missing node and writes nothing', async () => {
    const { inner, tree } = await setup();
    assert.equal(await tree.remove('/clients/ghost'), false);
    assert.deepEqual(await trashEntries(inner), []);
  });

  it('isTrashExempt covers the system namespaces and the root', () => {
    for (const p of ['/', '/sys', '/sys/trash/x', '/auth/users/a', '/proc/x']) {
      assert.equal(isTrashExempt(p), true, p);
    }
    for (const p of ['/clients', '/authx', '/system', '/board/t1']) {
      assert.equal(isTrashExempt(p), false, p);
    }
  });
});

describe('sweepTrash', () => {
  afterEach(() => {
    delete process.env.TREENIX_TRASH_TTL_DAYS;
  });

  it('purges entries older than the TTL, keeps fresh ones', async () => {
    const { inner, tree } = await setup();

    await tree.remove('/clients/acme');
    const oldPath = `${TRASH_ROOT}/${Date.now() - 40 * DAY}-0-old~node`;
    await inner.set({ $path: oldPath, $type: TRASH_ENTRY_TYPE, from: '/old/node', removedAt: 'past' });

    const purged = await sweepTrash(inner, 30 * DAY);
    assert.equal(purged, 1);

    const left = await trashEntries(inner);
    assert.equal(left.length, 1);
    assert.equal(left[0].from, '/clients/acme');
  });

  it('rejects an invalid TTL env instead of silently skipping GC', async () => {
    const { inner } = await setup();
    process.env.TREENIX_TRASH_TTL_DAYS = 'soon';
    await assert.rejects(async () => sweepTrash(inner));
  });

  it('is a no-op on an empty or absent trash root', async () => {
    const inner = createMemoryTree();
    await inner.set(createNode('/', 'root', {}));
    assert.equal(await sweepTrash(inner, DAY), 0);
  });
});

describe('trash through the pipeline (e2e)', () => {
  it('pipeline remove trashes; systemTree remove stays hard', async () => {
    const bootstrap = createMemoryTree();
    const root = createNode('/', 'root', {});
    root.$acl = [{ g: 'system', p: R | W | A | S }];
    await bootstrap.set(root);
    const { tree, systemTree } = createPipeline(bootstrap);

    await tree.set(createNode('/board', 'dir', {}));
    await tree.set(createNode('/board/t1', 'task', { title: 'x' }));

    assert.equal(await tree.remove('/board/t1'), true);
    assert.equal(await tree.get('/board/t1'), undefined);

    const { items } = await systemTree.getChildren(TRASH_ROOT, { depth: 1 });
    assert.equal(items.length, 1);
    assert.equal(items[0].from, '/board/t1');
    assert.ok((await systemTree.get(`${items[0].$path}/t1`))?.title === 'x');

    // Internal path: systemTree sits below withTrash — hard delete, no new entry.
    await systemTree.set(createNode('/board/t2', 'task', { title: 'y' }));
    assert.equal(await systemTree.remove('/board/t2'), true);
    const after = await systemTree.getChildren(TRASH_ROOT, { depth: 1 });
    assert.equal(after.items.length, 1);
  });
});
