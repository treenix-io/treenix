// patchMany contract (core-gk8.15) — atomic multi-node patch under one
// ancestor. Contract suite runs against every concrete adapter (memory, fs);
// combinator/policy/pipeline semantics follow in their own describes.

import { A, createNode, R, register, S, unregister, W } from '#core';
import { KernelError } from '#errors';
import { withMounts } from '#mount';
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
  e instanceof KernelError && e.code === expected;

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
      await assert.rejects(tree.patchMany!('/p', []), code('INVALID'));
    });

    it('entry outside the ancestor is rejected, nothing written', async () => {
      tree = await seed();
      await assert.rejects(
        tree.patchMany!('/p', [
          { path: '/p/a', ops: [['r', 'n', 10]] },
          { path: '/px/evil', ops: [['r', 'n', 1]] },
        ]),
        code('INVALID'),
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
        code('INVALID'),
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

    // ── set-members (core-gk8.10 stage 2) ──

    it('set-member creates at a new path', async () => {
      tree = await seed();
      await tree.patchMany!('/p', [
        { path: '/p/new', node: createNode('/p/new', 'item', { n: 42 }) },
      ]);
      const created = await tree.get('/p/new');
      assert.equal(created?.n, 42);
      assert.equal(created?.$rev, 1);
    });

    it('set-member OCC mismatch denies the whole batch, nothing written', async () => {
      tree = await seed();
      const stale = createNode('/p/b', 'item', { n: 99 });
      stale.$rev = 999;

      await assert.rejects(
        tree.patchMany!('/p', [
          { path: '/p/a', ops: [['r', 'n', 10]] },
          { path: '/p/new', node: createNode('/p/new', 'item', { n: 5 }) },
          { path: '/p/b', node: stale },
        ]),
        code('CONFLICT'),
      );

      assert.equal((await tree.get('/p/a'))?.n, 1);
      assert.equal(await tree.get('/p/new'), undefined, 'earlier create member unwritten');
      const b = await tree.get('/p/b');
      assert.equal(b?.n, 2);
      assert.equal(b?.$rev, 1);
    });

    it('mixed batch (ops + OCC replace + create) applies atomically', async () => {
      tree = await seed();
      const replacement = createNode('/p/b', 'item', { n: 200 });
      replacement.$rev = 1; // matches stored — OCC set

      await tree.patchMany!('/p', [
        { path: '/p/a', ops: [['r', 'n', 10]] },
        { path: '/p/b', node: replacement },
        { path: '/p/new', node: createNode('/p/new', 'item', { n: 5 }) },
      ]);

      const a = await tree.get('/p/a');
      assert.equal(a?.n, 10);
      assert.equal(a?.$rev, 2);
      const b = await tree.get('/p/b');
      assert.equal(b?.n, 200);
      assert.equal(b?.$rev, 2, 'OCC set bumps the stored $rev');
      assert.equal((await tree.get('/p/new'))?.$rev, 1);
    });

    it('set-member blind upsert replaces an existing node', async () => {
      tree = await seed();
      await tree.patchMany!('/p', [
        { path: '/p/a', node: createNode('/p/a', 'item', { label: 'fresh' }) },
      ]);

      const a = await tree.get('/p/a');
      assert.equal(a?.label, 'fresh');
      assert.equal(a?.n, undefined, 'full-node write, not a merge');
      // Mirrors Tree.set blind upsert: $rev advances from the STORED node
      // (ns6p.4 invariant 24, owner-approved 2026-07-18 — was reset-to-1).
      assert.equal(a?.$rev, 2);
    });

    it('failing later member leaves an earlier set-member unwritten (all-or-nothing)', async () => {
      tree = await seed();
      await assert.rejects(
        tree.patchMany!('/p', [
          { path: '/p/new', node: createNode('/p/new', 'item', { n: 5 }) },
          { path: '/p/ghost', ops: [['r', 'n', 1]] },
        ]),
        code('NOT_FOUND'),
      );
      assert.equal(await tree.get('/p/new'), undefined);
    });

    it('set-member node.$path mismatching its entry path is rejected', async () => {
      tree = await seed();
      await assert.rejects(
        tree.patchMany!('/p', [
          { path: '/p/x', node: createNode('/p/y', 'item', { n: 1 }) },
        ]),
        code('INVALID'),
      );
      assert.equal(await tree.get('/p/x'), undefined);
      assert.equal(await tree.get('/p/y'), undefined);
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
      code('INVALID'),
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
      code('INVALID'),
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

  it('set-member routes by the INCOMING node: creates in upper and in lower', async () => {
    const upper = createMemoryTree();
    const lower = createMemoryTree();
    const tree = createFilterTree(upper, lower, n => n.up === true);

    await tree.patchMany!('/p', [
      { path: '/p/u', node: createNode('/p/u', 'item', { up: true }) },
    ]);
    assert.equal((await upper.get('/p/u'))?.up, true);
    assert.equal(await lower.get('/p/u'), undefined);

    await tree.patchMany!('/p', [
      { path: '/p/l', node: createNode('/p/l', 'item', { n: 1 }) },
    ]);
    assert.equal((await lower.get('/p/l'))?.n, 1);
    assert.equal(await upper.get('/p/l'), undefined);
  });

  it('set-member routed upper + ops-member routed lower denies the batch, nothing written', async () => {
    const upper = createMemoryTree();
    const lower = createMemoryTree();
    const tree = createFilterTree(upper, lower, n => n.up === true);
    await lower.set(createNode('/p/b', 'item', { n: 2 }));

    await assert.rejects(
      tree.patchMany!('/p', [
        { path: '/p/new', node: createNode('/p/new', 'item', { up: true }) },
        { path: '/p/b', ops: [['r', 'n', 20]] },
      ]),
      code('INVALID'),
    );
    assert.equal(await upper.get('/p/new'), undefined);
    assert.equal((await lower.get('/p/b'))?.n, 2);
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

  it('set-member: entry path AND node.$path both translate to the remote namespace', async () => {
    const inner = createMemoryTree();
    await inner.set(createNode('/data/p', 'dir'));
    const tree = createRepathTree(inner, '/app', '/data');

    await tree.patchMany!('/app/p', [
      { path: '/app/p/new', node: createNode('/app/p/new', 'item', { n: 7 }) },
    ]);

    const created = await inner.get('/data/p/new');
    assert.equal(created?.n, 7);
    assert.equal(created?.$path, '/data/p/new');
  });
});

// ── mounts: set-member boundary guard ──
// A set-member under a NESTED mount below the batch ancestor must be denied:
// the dispatcher resolves ONE tree at the ancestor, so forwarding would
// silently create a shadowed node in the outer store.

describe('patchMany: mounts', () => {
  const MOUNT = 'pm.test.mount';

  afterEach(() => {
    try { unregister(MOUNT, 'mount'); } catch { /* not registered in this test */ }
  });

  it('set-member under a nested mount is rejected — no shadow node in the outer store', async () => {
    const outer = createMemoryTree();
    const nested = createMemoryTree();
    register(MOUNT, 'mount', () => nested);
    await outer.set(createNode('/p', 'dir'));
    await outer.set(createNode('/p/m', 'dir', {}, { mount: { $type: MOUNT } }));
    const ms = withMounts(outer);

    await assert.rejects(
      ms.patchMany!('/p', [
        { path: '/p/m/x', node: createNode('/p/m/x', 'item', { n: 1 }) },
      ]),
      code('INVALID'),
    );
    assert.equal(await outer.get('/p/m/x'), undefined, 'no shadow node in the outer store');
    assert.equal(await nested.get('/p/m/x'), undefined);
  });

  it('set-member fully inside the mounted subtree forwards to the nested store', async () => {
    const outer = createMemoryTree();
    const nested = createMemoryTree();
    register(MOUNT, 'mount', () => nested);
    await outer.set(createNode('/p', 'dir'));
    await outer.set(createNode('/p/m', 'dir', {}, { mount: { $type: MOUNT } }));
    const ms = withMounts(outer);

    await ms.patchMany!('/p/m/x', [
      { path: '/p/m/x', node: createNode('/p/m/x', 'item', { n: 1 }) },
    ]);
    assert.equal((await nested.get('/p/m/x'))?.n, 1);
    assert.equal(await outer.get('/p/m/x'), undefined);
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

  it('one invalid member denies the whole batch with INVALID, nothing written', async () => {
    const { inner, tree } = setupValidated();
    await tree.set({ $path: '/v', $type: 'dir' });
    await tree.set({ $path: '/v/a', $type: 'item', '#meta': { $type: META, count: 1 } });
    await tree.set({ $path: '/v/b', $type: 'item', '#meta': { $type: META, count: 2 } });

    await assert.rejects(
      tree.patchMany!('/v', [
        { path: '/v/a', ops: [['r', '#meta.count', 10]] },
        { path: '/v/b', ops: [['r', '#meta.count', 'not-a-number']] },
      ]),
      code('INVALID'),
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
      code('INVALID'),
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
