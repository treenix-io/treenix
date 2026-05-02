import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { NodeData } from '@treenx/core';
import type { Tree, Page, ChildrenOpts } from '@treenx/core/tree';
import { ServerTreeSource } from './server-tree-source';

function fakeTree(seed: NodeData[]): Tree {
  const map = new Map(seed.map(n => [n.$path, n]));
  const tree: Tree = {
    async get(path) { return map.get(path); },
    async getChildren(parent: string, _opts?: ChildrenOpts): Promise<Page<NodeData>> {
      const items = [...map.values()].filter(n =>
        n.$path !== parent && n.$path.startsWith(parent === '/' ? '/' : parent + '/'));
      return { items, total: items.length };
    },
    async set() {},
    async remove() { return false; },
    async patch() {},
  };
  return tree;
}

describe('ServerTreeSource', () => {
  it('first read records pending and returns loading snapshot', () => {
    const src = new ServerTreeSource(fakeTree([{ $path: '/a', $type: 'x' }]));
    const snap = src.getPathSnapshot('/a');
    assert.equal(snap.status, 'loading');
    assert.equal(snap.data, undefined);
    assert.equal(src.pendingCount(), 1);
  });

  it('flushPending resolves recorded paths to ready', async () => {
    const src = new ServerTreeSource(fakeTree([{ $path: '/a', $type: 'x' }]));
    src.getPathSnapshot('/a');
    await src.flushPending();
    const snap = src.getPathSnapshot('/a');
    assert.equal(snap.status, 'ready');
    assert.equal(snap.data?.$type, 'x');
    assert.equal(src.pendingCount(), 0);
  });

  it('missing path resolves to not_found, not error', async () => {
    const src = new ServerTreeSource(fakeTree([]));
    src.getPathSnapshot('/missing');
    await src.flushPending();
    const snap = src.getPathSnapshot('/missing');
    assert.equal(snap.status, 'not_found');
  });

  it('tree.get throwing surfaces as error snapshot', async () => {
    const tree: Tree = {
      async get() { throw new Error('boom'); },
      async getChildren() { return { items: [], total: 0 }; },
      async set() {}, async remove() { return false; }, async patch() {},
    };
    const src = new ServerTreeSource(tree);
    src.getPathSnapshot('/x');
    await src.flushPending();
    const snap = src.getPathSnapshot('/x');
    assert.equal(snap.status, 'error');
    assert.equal(snap.error?.message, 'boom');
  });

  it('children flush populates list and total', async () => {
    const src = new ServerTreeSource(fakeTree([
      { $path: '/p', $type: 'dir' },
      { $path: '/p/a', $type: 'x' },
      { $path: '/p/b', $type: 'x' },
    ]));
    src.getChildrenSnapshot('/p');
    await src.flushPending();
    const snap = src.getChildrenSnapshot('/p');
    assert.equal(snap.phase, 'ready');
    assert.equal(snap.data.length, 2);
    assert.equal(snap.total, 2);
  });

  it('subscribe* / mount* are no-ops on server', () => {
    const src = new ServerTreeSource(fakeTree([]));
    const unsub = src.subscribePath('/a', () => assert.fail('should not fire'));
    const handle = src.mountPath('/a');
    assert.equal(typeof unsub, 'function');
    unsub();
    handle.refetch();
    handle.dispose();
  });

  it('mountPath records the path for flush', () => {
    const src = new ServerTreeSource(fakeTree([]));
    src.mountPath('/a');
    assert.equal(src.pendingCount(), 1);
  });

  it('serialize emits ready snapshots for hydration', async () => {
    const src = new ServerTreeSource(fakeTree([
      { $path: '/a', $type: 'x' },
      { $path: '/p', $type: 'dir' },
      { $path: '/p/c', $type: 'x' },
    ]));
    src.getPathSnapshot('/a');
    src.getChildrenSnapshot('/p');
    await src.flushPending();
    const out = src.serialize();
    assert.equal(out.paths['/a']?.$type, 'x');
    assert.equal(out.children['/p']?.length, 1);
  });

  it('multi-pass: leaf added during pass-2 takes pass-3 to resolve', async () => {
    const src = new ServerTreeSource(fakeTree([
      { $path: '/a', $type: 'x' },
      { $path: '/b', $type: 'x' },
    ]));
    src.getPathSnapshot('/a');
    await src.flushPending();
    src.getPathSnapshot('/b');
    assert.equal(src.pendingCount(), 1);
    await src.flushPending();
    assert.equal(src.pendingCount(), 0);
    assert.equal(src.getPathSnapshot('/b').status, 'ready');
  });
});
