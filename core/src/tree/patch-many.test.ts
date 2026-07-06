// patchMany contract (core-gk8.15) — atomic multi-node patch under one
// ancestor. Contract suite runs against every concrete adapter (memory, fs);
// combinator/policy/pipeline semantics follow in their own describes.

import { A, createNode, R, register, S, unregister, W } from '#core';
import { OpError } from '#errors';
import { withAcl } from '#security/acl-tree';
import { createPipeline } from '#server/server';
import type { NodeEvent } from '#sub';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { createFsTree } from './fs';
import { createFilterTree, createMemoryTree, createOverlayTree, type Tree, type TreeSource } from './index';
import { withStoragePolicy } from './policy';
import { createRepathTree } from './repath';

const code = (expected: string) => (e: unknown) =>
  e instanceof OpError && e.code === expected;

// ── adapter contract: memory + fs ──

interface Factory {
  name: string;
  setup: () => Promise<TreeSource>;
  teardown: () => Promise<void>;
}

function suite(factory: Factory) {
  describe(`patchMany contract: ${factory.name}`, () => {
    let tree: TreeSource;

    afterEach(async () => {
      await factory.teardown();
    });

    async function seed() {
      tree = await factory.setup();
      await tree.set(createNode('/p', 'dir'));
      await tree.set(createNode('/p/a', 'item', { n: 1 }));
      await tree.set(createNode('/p/b', 'item', { n: 2 }));
      await tree.set(createNode('/p/c', 'item', { n: 3 }));
      return tree;
    }

    it('happy path: N=3 applies all members with a $rev bump each', async () => {
      tree = await seed();
      await tree.patchMany!('/p', [
        { path: '/p/a', ops: [['r', 'n', 10]] },
        { path: '/p/b', ops: [['r', 'n', 20]] },
        { path: '/p/c', ops: [['r', 'n', 30]] },
      ]);

      for (const [p, n] of [['/p/a', 10], ['/p/b', 20], ['/p/c', 30]] as const) {
        const node = await tree.get(p);
        assert.equal(node?.n, n);
        assert.equal(node?.$rev, 2, `${p} bumped once`);
      }
    });

    it('the ancestor itself may be a member', async () => {
      tree = await seed();
      await tree.patchMany!('/p', [
        { path: '/p', ops: [['a', 'label', 'x']] },
        { path: '/p/a', ops: [['r', 'n', 11]] },
      ]);
      assert.equal((await tree.get('/p'))?.label, 'x');
      assert.equal((await tree.get('/p/a'))?.n, 11);
    });

    it('empty batch is rejected', async () => {
      tree = await seed();
      await assert.rejects(tree.patchMany!('/p', []), code('BAD_REQUEST'));
    });

    it('entry outside the ancestor is rejected, nothing written', async () => {
      tree = await seed();
      await assert.rejects(
        tree.patchMany!('/p', [
          { path: '/p/a', ops: [['r', 'n', 10]] },
          { path: '/px/evil', ops: [['r', 'n', 1]] },
        ]),
        code('BAD_REQUEST'),
      );
      assert.equal((await tree.get('/p/a'))?.n, 1);
    });

    it('duplicate entry paths are rejected, nothing written', async () => {
      tree = await seed();
      await assert.rejects(
        tree.patchMany!('/p', [
          { path: '/p/a', ops: [['r', 'n', 10]] },
          { path: '/p/a', ops: [['r', 'n', 99]] },
        ]),
        code('BAD_REQUEST'),
      );
      assert.equal((await tree.get('/p/a'))?.n, 1);
    });

    it('mid-batch failing test op denies the WHOLE batch — earlier member untouched', async () => {
      tree = await seed();
      const before = await tree.get('/p/a');

      await assert.rejects(
        tree.patchMany!('/p', [
          { path: '/p/a', ops: [['r', 'n', 10]] },
          { path: '/p/b', ops: [['t', '$rev', 999], ['r', 'n', 20]] },
        ]),
        code('CONFLICT'),
      );

      assert.deepEqual(await tree.get('/p/a'), before, 'member #1 byte-identical, $rev unchanged');
      assert.equal((await tree.get('/p/b'))?.n, 2);
    });

    it('missing member denies the whole batch with NOT_FOUND, nothing written', async () => {
      tree = await seed();
      await assert.rejects(
        tree.patchMany!('/p', [
          { path: '/p/a', ops: [['r', 'n', 10]] },
          { path: '/p/ghost', ops: [['r', 'n', 1]] },
        ]),
        code('NOT_FOUND'),
      );
      assert.equal((await tree.get('/p/a'))?.n, 1);
    });

    it('test-only member: evaluated but not written, no $rev bump; mutating members commit', async () => {
      tree = await seed();
      await tree.patchMany!('/p', [
        { path: '/p/a', ops: [['t', 'n', 1]] },
        { path: '/p/b', ops: [['r', 'n', 20]] },
      ]);

      const a = await tree.get('/p/a');
      assert.equal(a?.n, 1);
      assert.equal(a?.$rev, 1, 'test-only member keeps its $rev');
      const b = await tree.get('/p/b');
      assert.equal(b?.n, 20);
      assert.equal(b?.$rev, 2);
    });
  });
}

suite({
  name: 'memory',
  setup: async () => createMemoryTree(),
  teardown: async () => {},
});

{
  let dir: string | undefined;
  suite({
    name: 'fs',
    setup: async () => {
      dir = await mkdtemp(join(tmpdir(), 'treenix-patchmany-fs-'));
      return await createFsTree(dir);
    },
    teardown: async () => {
      if (dir) {
        await rm(dir, { recursive: true, force: true });
        dir = undefined;
      }
    },
  });
}

// ── layer combinators: filter / overlay ──

describe('patchMany: filter/overlay layers', () => {
  it('mixed-layer batch is rejected, nothing written', async () => {
    const upper = createMemoryTree();
    const lower = createMemoryTree();
    const tree = createFilterTree(upper, lower, n => n.up === true);
    await upper.set(createNode('/p/a', 'item', { n: 1, up: true }));
    await lower.set(createNode('/p/b', 'item', { n: 2 }));

    await assert.rejects(
      tree.patchMany!('/p', [
        { path: '/p/a', ops: [['r', 'n', 10]] },
        { path: '/p/b', ops: [['r', 'n', 20]] },
      ]),
      code('BAD_REQUEST'),
    );
    assert.equal((await upper.get('/p/a'))?.n, 1);
    assert.equal((await lower.get('/p/b'))?.n, 2);
  });

  it('single-layer batch forwards and commits', async () => {
    const upper = createMemoryTree();
    const lower = createMemoryTree();
    const tree = createFilterTree(upper, lower, n => n.up === true);
    await lower.set(createNode('/p/a', 'item', { n: 1 }));
    await lower.set(createNode('/p/b', 'item', { n: 2 }));

    await tree.patchMany!('/p', [
      { path: '/p/a', ops: [['r', 'n', 10]] },
      { path: '/p/b', ops: [['r', 'n', 20]] },
    ]);
    assert.equal((await lower.get('/p/a'))?.n, 10);
    assert.equal((await lower.get('/p/b'))?.n, 20);
  });

  it('layer without patchMany fails loud — no silent per-member fallback', async () => {
    const m = createMemoryTree();
    // Hand-built facade WITHOUT patchMany — models a capability-less layer.
    const bare: Tree = {
      get: m.get.bind(m),
      getChildren: m.getChildren.bind(m),
      set: m.set.bind(m),
      remove: m.remove.bind(m),
      patch: m.patch.bind(m),
    };
    const tree = createFilterTree(createMemoryTree(), bare, () => false);
    await bare.set(createNode('/p/a', 'item', { n: 1 }));

    await assert.rejects(
      tree.patchMany!('/p', [{ path: '/p/a', ops: [['r', 'n', 10]] }]),
      code('BAD_REQUEST'),
    );
    assert.equal((await bare.get('/p/a'))?.n, 1);
  });

  it('overlay routes the batch to upper; a lower-only member denies the batch', async () => {
    const upper = createMemoryTree();
    const lower = createMemoryTree();
    const tree = createOverlayTree(upper, lower);
    await upper.set(createNode('/p/a', 'item', { n: 1 }));
    await lower.set(createNode('/p/b', 'item', { n: 2 }));

    // Both visible through the overlay, but /p/b lives only in lower — the
    // write layer (upper) can't own it, so the whole batch is denied.
    await assert.rejects(
      tree.patchMany!('/p', [
        { path: '/p/a', ops: [['r', 'n', 10]] },
        { path: '/p/b', ops: [['r', 'n', 20]] },
      ]),
      code('NOT_FOUND'),
    );
    assert.equal((await upper.get('/p/a'))?.n, 1);

    await tree.patchMany!('/p', [{ path: '/p/a', ops: [['r', 'n', 10]] }]);
    assert.equal((await upper.get('/p/a'))?.n, 10);
  });
});

// ── repath ──

describe('patchMany: repath', () => {
  it('translates ancestor and every member path to the remote namespace', async () => {
    const inner = createMemoryTree();
    await inner.set(createNode('/data/p', 'dir'));
    await inner.set(createNode('/data/p/a', 'item', { n: 1 }));
    await inner.set(createNode('/data/p/b', 'item', { n: 2 }));
    const tree = createRepathTree(inner, '/app', '/data');

    await tree.patchMany!('/app/p', [
      { path: '/app/p/a', ops: [['r', 'n', 10]] },
      { path: '/app/p/b', ops: [['r', 'n', 20]] },
    ]);
    assert.equal((await inner.get('/data/p/a'))?.n, 10);
    assert.equal((await inner.get('/data/p/b'))?.n, 20);
  });
});

// ── storage policy: validation + $refs ──

const META = 'pm.test.meta';

describe('patchMany: storage policy', () => {
  afterEach(() => {
    try { unregister(META, 'schema'); } catch { /* not registered in this test */ }
  });

  function setupValidated() {
    register(META, 'schema', () => ({
      title: 'PM',
      type: 'object',
      properties: { count: { type: 'number' } },
    }));
    const inner = createMemoryTree();
    const { tree } = withStoragePolicy(inner);
    return { inner, tree };
  }

  it('one invalid member denies the whole batch with BAD_REQUEST, nothing written', async () => {
    const { inner, tree } = setupValidated();
    await tree.set({ $path: '/v', $type: 'dir' });
    await tree.set({ $path: '/v/a', $type: 'item', '#meta': { $type: META, count: 1 } });
    await tree.set({ $path: '/v/b', $type: 'item', '#meta': { $type: META, count: 2 } });

    await assert.rejects(
      tree.patchMany!('/v', [
        { path: '/v/a', ops: [['r', '#meta.count', 10]] },
        { path: '/v/b', ops: [['r', '#meta.count', 'not-a-number']] },
      ]),
      code('BAD_REQUEST'),
    );

    assert.deepEqual((await inner.get('/v/a'))?.['#meta'], { $type: META, count: 1 });
    assert.deepEqual((await inner.get('/v/b'))?.['#meta'], { $type: META, count: 2 });
  });

  it('all invalid members are collected into ONE rejection', async () => {
    const { inner, tree } = setupValidated();
    await tree.set({ $path: '/v', $type: 'dir' });
    await tree.set({ $path: '/v/a', $type: 'item', '#meta': { $type: META, count: 1 } });
    await tree.set({ $path: '/v/b', $type: 'item', '#meta': { $type: META, count: 2 } });

    await assert.rejects(
      tree.patchMany!('/v', [
        { path: '/v/a', ops: [['r', '#meta.count', 'bad-a']] },
        { path: '/v/b', ops: [['r', '#meta.count', 'bad-b']] },
      ]),
      code('BAD_REQUEST'),
    );
    assert.equal((await inner.get('/v/a'))?.$rev, 1);
    assert.equal((await inner.get('/v/b'))?.$rev, 1);
  });

  it('$refs re-derived per member: added ref lands in the same commit, cleared ref drops the index', async () => {
    const { tree } = withStoragePolicy(createMemoryTree());
    await tree.set({ $path: '/r', $type: 'dir' });
    await tree.set({ $path: '/r/plain', $type: 'item' });
    await tree.set({ $path: '/r/linked', $type: 'item', friend: { $type: 'ref', $ref: '/r/plain' } });
    assert.ok((await tree.get('/r/linked'))?.$refs, 'sanity: set() derived the index');

    await tree.patchMany!('/r', [
      { path: '/r/plain', ops: [['a', 'friend', { $type: 'ref', $ref: '/r/linked' }]] },
      { path: '/r/linked', ops: [['d', 'friend']] },
    ]);

    const plain = await tree.get('/r/plain');
    assert.ok(plain?.$refs?.some(r => r.t === '/r/linked' && r.f === 'friend'));
    const linked = await tree.get('/r/linked');
    assert.equal(linked?.$refs, undefined);
  });

  it('test-only member through the policy neither writes nor bumps $rev', async () => {
    const { inner, tree } = setupValidated();
    await tree.set({ $path: '/v', $type: 'dir' });
    await tree.set({ $path: '/v/a', $type: 'item', '#meta': { $type: META, count: 1 } });
    await tree.set({ $path: '/v/b', $type: 'item', '#meta': { $type: META, count: 2 } });

    await tree.patchMany!('/v', [
      { path: '/v/a', ops: [['t', '#meta.count', 1]] },
      { path: '/v/b', ops: [['r', '#meta.count', 20]] },
    ]);

    assert.equal((await inner.get('/v/a'))?.$rev, 1, 'test-only member untouched');
    const b = await inner.get('/v/b');
    assert.deepEqual(b?.['#meta'], { $type: META, count: 20 });
    assert.equal(b?.$rev, 2);
  });
});

// ── full pipeline: ACL, events, $refs ──

describe('patchMany: full pipeline', () => {
  async function pipelineSetup() {
    const bootstrap = createMemoryTree();
    const root = createNode('/', 'root', {});
    root.$acl = [{ g: 'system', p: R | W | A | S }, { g: 'users', p: R | W }];
    await bootstrap.set(root);
    const pipeline = createPipeline(bootstrap);
    await pipeline.tree.set(createNode('/dir', 'dir', {}));
    await pipeline.tree.set(createNode('/dir/a', 'item', { n: 1 }));
    await pipeline.tree.set(createNode('/dir/b', 'item', { n: 2 }));
    return pipeline;
  }

  it('commits through the pipeline and emits exactly N patch events after success', async () => {
    const { tree, cdc } = await pipelineSetup();
    assert.ok(tree.patchMany, 'capability flows through every pipeline layer');

    const events: NodeEvent[] = [];
    cdc.subscribe('/dir', e => events.push(e), { children: true });

    await tree.patchMany!('/dir', [
      { path: '/dir/a', ops: [['r', 'n', 10]] },
      { path: '/dir/b', ops: [['r', 'n', 20]] },
    ]);

    assert.equal(events.length, 2);
    assert.deepEqual(events.map(e => e.type), ['patch', 'patch']);
    const paths = events.map(e => e.type === 'patch' ? e.path : e.type).sort();
    assert.deepEqual(paths, ['/dir/a', '/dir/b']);
    assert.equal((await tree.get('/dir/a'))?.n, 10);
    assert.equal((await tree.get('/dir/b'))?.$rev, 2);
  });

  it('failed batch emits nothing and writes nothing', async () => {
    const { tree, cdc } = await pipelineSetup();
    const events: NodeEvent[] = [];
    cdc.subscribe('/dir', e => events.push(e), { children: true });

    await assert.rejects(
      tree.patchMany!('/dir', [
        { path: '/dir/a', ops: [['r', 'n', 10]] },
        { path: '/dir/b', ops: [['t', '$rev', 999]] },
      ]),
      code('CONFLICT'),
    );

    assert.equal(events.length, 0, 'no events for a denied batch');
    assert.equal((await tree.get('/dir/a'))?.n, 1);
  });

  it('ACL: an unwritable member denies the whole batch with FORBIDDEN, nothing written', async () => {
    const { tree } = await pipelineSetup();
    // Deny-all for 'users' on /dir/b — the per-member R+W gate must fail.
    await tree.patch('/dir/b', [['a', '$acl', [{ g: 'users', p: 0 }]]]);

    const user = withAcl(tree, 'u1', ['users']);
    await assert.rejects(
      user.patchMany!('/dir', [
        { path: '/dir/a', ops: [['r', 'n', 10]] },
        { path: '/dir/b', ops: [['r', 'n', 20]] },
      ]),
      code('FORBIDDEN'),
    );
    assert.equal((await tree.get('/dir/a'))?.n, 1);
    assert.equal((await tree.get('/dir/b'))?.n, 2);

    // Sanity: the writable member alone commits for the same actor.
    await user.patchMany!('/dir', [{ path: '/dir/a', ops: [['r', 'n', 10]] }]);
    assert.equal((await tree.get('/dir/a'))?.n, 10);
  });

  it('$refs recomputed for a member whose ops add a ref', async () => {
    const { tree } = await pipelineSetup();

    await tree.patchMany!('/dir', [
      { path: '/dir/a', ops: [['a', 'link', { $type: 'ref', $ref: '/dir/b' }]] },
    ]);

    const a = await tree.get('/dir/a');
    assert.ok(a?.$refs?.some(r => r.t === '/dir/b' && r.f === 'link'));
  });
});
