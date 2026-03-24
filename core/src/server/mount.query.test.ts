import { createNode, register } from '#core';
import { clearRegistry } from '#core/index.test';
import { createMemoryTree, type Tree } from '#tree';
import { createQueryTree } from '#tree/query';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { withMounts } from './mount';
import { MountQuery } from './mount-adapters';

describe('Query Mount', () => {
  let rootStore: Tree;

  beforeEach(() => {
    clearRegistry();
    register(MountQuery, 'mount', (mount, ctx) => {
      if (!mount.source || !mount.match) throw new Error('t.mount.query: source and match required');
      return createQueryTree(mount, ctx.globalStore || ctx.parentStore);
    });
    rootStore = createMemoryTree();
  });

  it('filters children from source path', async () => {
    await rootStore.set(createNode('/entities/orders/1', 'order', { status: 'new' }));
    await rootStore.set(createNode('/entities/orders/2', 'order', { status: 'kitchen' }));
    await rootStore.set(createNode('/entities/orders/3', 'order', { status: 'new' }));

    await rootStore.set(
      createNode('/workflows/new', 'folder', {}, {
        mount: { $type: 't.mount.query', source: '/entities/orders', match: { status: 'new' } }
      })
    );

    const ms = withMounts(rootStore);
    
    const children = await ms.getChildren('/workflows/new');
    assert.equal(children.items.length, 2);
    // They should have their original paths!
    assert.deepEqual(children.items.map(n => n.$path).sort(), ['/entities/orders/1', '/entities/orders/3']);
  });

  it('get delegates to parent tree (real paths)', async () => {
    await rootStore.set(createNode('/entities/orders/1', 'order', { status: 'new' }));
    await rootStore.set(
      createNode('/workflows/new', 'folder', {}, {
        mount: { $type: 't.mount.query', source: '/entities/orders', match: { status: 'new' } },
      }),
    );
    const ms = withMounts(rootStore);

    // Query mount delegates get to parent — real path works
    const node = await ms.get('/entities/orders/1');
    assert.equal(node?.$path, '/entities/orders/1');
  });

  it('mount config accessible via get', async () => {
    await rootStore.set(
      createNode('/workflows/new', 'folder', {}, {
        mount: { $type: 't.mount.query', source: '/entities/orders', match: { status: 'new' } },
      }),
    );
    const ms = withMounts(rootStore);

    const node = await ms.get('/workflows/new');
    assert.equal(node?.$type, 't.folder');
  });

  it('query mount with separate source dir excludes sibling mounts', async () => {
    // Agent pattern: /agent/tasks holds real tasks,
    // /agent/inbox and /agent/done are query mounts on /agent/tasks
    await rootStore.set(createNode('/agent', 'config'));
    await rootStore.set(createNode('/agent/tasks', 'dir'));
    await rootStore.set(createNode('/agent/tasks/t1', 'task', { status: 'pending' }));
    await rootStore.set(createNode('/agent/tasks/t2', 'task', { status: 'done' }));
    await rootStore.set(createNode('/agent/tasks/t3', 'task', { status: 'pending' }));

    await rootStore.set(createNode('/agent/inbox', 'mount-point', {}, {
      mount: { $type: 't.mount.query', source: '/agent/tasks', match: { $type: 't.task', status: 'pending' } },
    }));
    await rootStore.set(createNode('/agent/done', 'mount-point', {}, {
      mount: { $type: 't.mount.query', source: '/agent/tasks', match: { $type: 't.task', status: 'done' } },
    }));

    const ms = withMounts(rootStore);

    const inbox = await ms.getChildren('/agent/inbox');
    assert.equal(inbox.items.length, 2);
    assert.ok(inbox.items.every(n => n.$type === 't.task' && n.status === 'pending'));

    const done = await ms.getChildren('/agent/done');
    assert.equal(done.items.length, 1);
    assert.equal(done.items[0].$path, '/agent/tasks/t2');
  });

  it('circular source: mount-points excluded by sift filter', async () => {
    // Regression: source=/parent where mount-points are children of /parent.
    // Sift filter must exclude non-matching $type even with circular source.
    await rootStore.set(createNode('/parent', 'config'));
    await rootStore.set(createNode('/parent/t1', 'task', { status: 'pending' }));
    await rootStore.set(createNode('/parent/t2', 'task', { status: 'done' }));

    await rootStore.set(createNode('/parent/inbox', 'mount-point', {}, {
      mount: { $type: 't.mount.query', source: '/parent', match: { $type: 't.task', status: 'pending' } },
    }));
    await rootStore.set(createNode('/parent/done', 'mount-point', {}, {
      mount: { $type: 't.mount.query', source: '/parent', match: { $type: 't.task', status: 'done' } },
    }));

    const ms = withMounts(rootStore);

    // inbox should only see pending tasks, not mount-points or done tasks
    const inbox = await ms.getChildren('/parent/inbox');
    assert.equal(inbox.items.length, 1);
    assert.equal(inbox.items[0].$path, '/parent/t1');

    // done should only see done tasks
    const done = await ms.getChildren('/parent/done');
    assert.equal(done.items.length, 1);
    assert.equal(done.items[0].$path, '/parent/t2');
  });
});
