import { createNode, type NodeData } from '#core';
import { KernelError } from '#errors';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';
import { BRANCH_DELTA_TYPE, BRANCH_WHITEOUT_TYPE, createBranchTree, isBranchDelta } from './branch';
import { createFsTree } from './fs';
import { createMemoryTree, type Tree } from './index';
import { PatchTestError } from './patch';

const isCode = (code: string) => (e: unknown) => e instanceof KernelError && e.code === code;

async function collect(iter: AsyncIterable<{ node: NodeData; cursor: string }>): Promise<NodeData[]> {
  const out: NodeData[] = [];
  for await (const e of iter) out.push(e.node);
  return out;
}

describe('createBranchTree (memory)', () => {
  let upper: Tree;
  let lower: Tree;
  let branch: Tree;

  beforeEach(async () => {
    upper = createMemoryTree();
    lower = createMemoryTree();
    await lower.set(createNode('/a', 'doc', { title: 'live-a', kind: 'x' }));
    await lower.set(createNode('/b', 'doc', { title: 'live-b' }));
    await lower.set(createNode('/d', 'dir'));
    await lower.set(createNode('/d/c1', 'doc', { title: 'live-c1' }));
    branch = createBranchTree(upper, lower);
  });

  it('falls through to lower on untouched paths', async () => {
    const node = await branch.get('/a');
    assert.equal(node?.title, 'live-a');
    const { items } = await branch.getChildren('/');
    assert.deepEqual(items.map(n => n.$path).sort(), ['/a', '/b', '/d']);
  });

  it('set isolates the write: branch sees new, lower keeps old', async () => {
    await branch.set(createNode('/a', 'doc', { title: 'branch-a' }));
    assert.equal((await branch.get('/a'))?.title, 'branch-a');
    assert.equal((await lower.get('/a'))?.title, 'live-a');

    const wrapper = await upper.get('/a');
    assert.equal(wrapper?.$type, BRANCH_DELTA_TYPE);
    assert.equal(wrapper?.baseRev, 1);
  });

  it('create in branch: baseRev null, invisible in lower', async () => {
    await branch.set(createNode('/new', 'doc', { title: 'n' }));
    assert.equal((await branch.get('/new'))?.title, 'n');
    assert.equal(await lower.get('/new'), undefined);
    assert.equal((await upper.get('/new'))?.baseRev, null);
  });

  it('shadowing: rewritten node appears once in children', async () => {
    await branch.set(createNode('/a', 'doc', { title: 'branch-a' }));
    const { items } = await branch.getChildren('/');
    const as = items.filter(n => n.$path === '/a');
    assert.equal(as.length, 1);
    assert.equal(as[0].title, 'branch-a');
  });

  it('query applies to the merged view, not stale lower versions', async () => {
    await branch.set(createNode('/a', 'doc', { title: 'branch-a', kind: 'y' }));

    const xs = await branch.getChildren('/', { query: { kind: 'x' } });
    assert.deepEqual(xs.items.map(n => n.$path), []);

    const ys = await branch.getChildren('/', { query: { kind: 'y' } });
    assert.deepEqual(ys.items.map(n => n.$path), ['/a']);
    assert.equal(ys.items[0].title, 'branch-a');
  });

  it('remove writes a whiteout: invisible in branch, intact in lower', async () => {
    assert.ok((await branch.remove('/a')).changes?.length);
    assert.equal(await branch.get('/a'), undefined);
    assert.equal((await lower.get('/a'))?.title, 'live-a');

    const { items } = await branch.getChildren('/');
    assert.ok(!items.some(n => n.$path === '/a'));

    const wrapper = await upper.get('/a');
    assert.equal(wrapper?.$type, BRANCH_WHITEOUT_TYPE);
    assert.equal(wrapper?.baseRev, 1);

    assert.deepEqual((await branch.remove('/a')).changes, []);
  });

  it('remove of nonexistent path returns false, writes nothing', async () => {
    assert.deepEqual((await branch.remove('/nope')).changes, []);
    assert.equal(await upper.get('/nope'), undefined);
  });

  it('create-then-delete leaves a baseRev:null whiteout', async () => {
    await branch.set(createNode('/tmp', 'doc', {}));
    assert.ok((await branch.remove('/tmp')).changes?.length);
    assert.equal(await branch.get('/tmp'), undefined);
    const wrapper = await upper.get('/tmp');
    assert.equal(wrapper?.$type, BRANCH_WHITEOUT_TYPE);
    assert.equal(wrapper?.baseRev, null);
  });

  it('re-create after remove keeps the ORIGINAL baseRev', async () => {
    await branch.remove('/a');
    await branch.set(createNode('/a', 'doc', { title: 'reborn' }));
    assert.equal((await branch.get('/a'))?.title, 'reborn');
    assert.equal((await upper.get('/a'))?.baseRev, 1);
  });

  it('double set keeps the original baseRev (capture-once)', async () => {
    await branch.set(createNode('/a', 'doc', { title: 'v1' }));
    await branch.set(createNode('/a', 'doc', { title: 'v2' }));
    const wrapper = await upper.get('/a');
    assert.equal(wrapper?.baseRev, 1);
    assert.equal((await branch.get('/a'))?.title, 'v2');
  });

  it('view-level OCC: stale $rev conflicts, current $rev passes', async () => {
    // Untouched path: visible rev is the live rev.
    const live = await branch.get('/a');
    await branch.set({ ...live!, title: 'occ-1' });
    // Touched path: visible rev is the wrapper storage rev.
    const v1 = await branch.get('/a');
    assert.equal(typeof v1?.$rev, 'number');
    await branch.set({ ...v1!, title: 'occ-2' });

    await assert.rejects(branch.set({ ...v1!, title: 'occ-3' }), isCode('CONFLICT'));

    await branch.remove('/b');
    const b = createNode('/b', 'doc', { title: 'x' });
    await assert.rejects(branch.set({ ...b, $rev: 1 }), isCode('CONFLICT'));
  });

  it('patch: NOT_FOUND on missing, applies onto lower-only node', async () => {
    await assert.rejects(branch.patch('/nope', [['r', 'title', 'x']]), isCode('NOT_FOUND'));

    await branch.patch('/b', [['r', 'title', 'patched']]);
    assert.equal((await branch.get('/b'))?.title, 'patched');
    assert.equal((await lower.get('/b'))?.title, 'live-b');
    assert.equal((await upper.get('/b'))?.baseRev, 1);
  });

  it('patch: failed test op throws, test-only ops do not write', async () => {
    await assert.rejects(
      branch.patch('/b', [['t', 'title', 'wrong'], ['r', 'title', 'x']]),
      (e: unknown) => e instanceof PatchTestError,
    );
    assert.equal(await upper.get('/b'), undefined);

    await branch.patch('/b', [['t', 'title', 'live-b']]);
    assert.equal(await upper.get('/b'), undefined);
  });

  it('scanChildren: ordered merge, whiteouts suppress, rewrites win', async () => {
    await branch.set(createNode('/ab', 'doc', { title: 'added' }));
    await branch.set(createNode('/b', 'doc', { title: 'rewritten' }));
    await branch.remove('/a');

    const nodes = await collect(branch.scanChildren!('/', { depth: -1 }));
    const paths = nodes.map(n => n.$path);
    assert.deepEqual(paths, ['/ab', '/b', '/d', '/d/c1']);
    assert.equal(nodes.find(n => n.$path === '/b')?.title, 'rewritten');
    assert.deepEqual([...paths].sort(), paths); // ASC order held
  });

  it('scanChildren: cursor resume fails loud', async () => {
    const iter = branch.scanChildren!('/', { after: '/a' })[Symbol.asyncIterator]();
    await assert.rejects(iter.next(), isCode('INVALID'));
  });

  it('scanChildren: early break closes both layer iterators', async () => {
    const closed: string[] = [];
    const instrument = (tree: Tree, tag: string): Tree => ({
      ...tree,
      async *scanChildren(parent, opts, ctx) {
        try {
          yield* tree.scanChildren!(parent, opts, ctx);
        } finally {
          closed.push(tag);
        }
      },
    });
    const b = createBranchTree(instrument(upper, 'upper'), instrument(lower, 'lower'));
    await b.set(createNode('/z1', 'doc', {}));

    for await (const _ of b.scanChildren!('/', { depth: -1 })) break;
    assert.deepEqual(closed.sort(), ['lower', 'upper']);
  });

  it('depth>1 children merge nested branch writes over live', async () => {
    await branch.set(createNode('/d/c2', 'doc', { title: 'branch-c2' }));
    const { items } = await branch.getChildren('/', { depth: -1 });
    const paths = items.map(n => n.$path).sort();
    assert.deepEqual(paths, ['/a', '/b', '/d', '/d/c1', '/d/c2']);

    const direct = await branch.getChildren('/d');
    assert.deepEqual(direct.items.map(n => n.$path).sort(), ['/d/c1', '/d/c2']);
  });

  it('bookkeeping never leaks through reads', async () => {
    await branch.set(createNode('/a', 'doc', { title: 'branch-a' }));
    const node = await branch.get('/a');
    assert.equal(node?.$type, 't.doc'); // createNode normalizes dot-less types
    assert.ok(!('node' in node!));
    assert.ok(!('baseRev' in node!));

    const { items } = await branch.getChildren('/');
    const scanned = await collect(branch.scanChildren!('/', { depth: -1 }));
    for (const n of [...items, ...scanned]) {
      assert.notEqual(n.$type, BRANCH_DELTA_TYPE);
      assert.notEqual(n.$type, BRANCH_WHITEOUT_TYPE);
    }
  });

  it('foreign node in delta subtree fails loud', async () => {
    await upper.set(createNode('/x', 'doc', { title: 'junk' }));
    await assert.rejects(branch.get('/x'), isCode('CONFLICT'));
  });

  it('isBranchDelta narrows wrapper shape', async () => {
    await branch.set(createNode('/a', 'doc', { title: 'v' }));
    const wrapper = await upper.get('/a');
    assert.ok(wrapper && isBranchDelta(wrapper));
    assert.equal(wrapper.node.title, 'v');
  });
});

describe('createBranchTree (fs adapters)', () => {
  let dir: string;

  after(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('write isolation + whiteout + scan over fs upper/lower', async () => {
    dir = await mkdtemp(join(tmpdir(), 'treenix-branch-test-'));
    const lower = await createFsTree(join(dir, 'live'));
    const upper = await createFsTree(join(dir, 'delta'));
    await lower.set(createNode('/a', 'doc', { title: 'live-a' }));
    await lower.set(createNode('/b', 'doc', { title: 'live-b' }));
    const branch = createBranchTree(upper, lower);

    await branch.set(createNode('/a', 'doc', { title: 'branch-a' }));
    await branch.remove('/b');
    await branch.set(createNode('/c', 'doc', { title: 'created' }));

    assert.equal((await branch.get('/a'))?.title, 'branch-a');
    assert.equal((await lower.get('/a'))?.title, 'live-a');
    assert.equal(await branch.get('/b'), undefined);
    assert.equal((await lower.get('/b'))?.title, 'live-b');

    const nodes = await collect(branch.scanChildren!('/', { depth: -1 }));
    assert.deepEqual(nodes.map(n => n.$path), ['/a', '/c']);
    assert.equal((await upper.get('/a'))?.baseRev, 1);
  });
});
