// Storage-policy step tests (core-5fqq). The per-wrapper unit suites
// (migration/validation/refs/trash) became policy-step tests against the one
// implementation — owner decision 2026-07-03: independent composability was
// never exercised. Contracts are unchanged; only the composition surface is.

import { A, createNode, type NodeData, R, register, S, unregister, W } from '#core';
import { OpError } from '#errors';
import { createPipeline } from '#server/server';
import { clearRegistry } from '#testing';
import { withMounts } from '#mount';
import { createMemoryTree, type Tree } from '#tree';
import { createFsTree } from '#tree/fs';
import { isUlid, ulid } from '#util/ulid';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { isTrashExempt, sweepTrash, TRASH_ENTRY_TYPE, TRASH_ROOT, withStoragePolicy } from './policy';

// ── migration step (base + client path) ──

const TEST_TYPE = 'test.migrated';
const COMP_TYPE = 'test.comp.migrated';
const UNREL_TYPE = 'test.unrelated-bump';

describe('policy: migration step', () => {
  afterEach(() => {
    for (const t of [TEST_TYPE, COMP_TYPE, UNREL_TYPE]) {
      try { unregister(t, 'migrate'); } catch { /* not registered in this test */ }
    }
  });

  it('passes through nodes without migrations', async () => {
    const inner = createMemoryTree();
    const { base: tree } = withStoragePolicy(inner);
    await inner.set(createNode('/a', 'dir', { label: 'hi' }));

    const got = await tree.get('/a');
    assert.equal(got?.label, 'hi');
    assert.equal(got?.$v, undefined);
  });

  it('runs the migration ladder on read and stamps $v', async () => {
    register(TEST_TYPE, 'migrate', () => ({
      1: (n: Record<string, unknown>) => { n.items = Array.isArray(n.items) ? n.items : []; },
      2: (n: Record<string, unknown>) => { n.label ??= 'default'; },
    }));

    const inner = createMemoryTree();
    const { base: tree } = withStoragePolicy(inner);
    await inner.set(createNode('/a', TEST_TYPE, { items: 'old-string' }));

    const got = await tree.get('/a');
    assert.deepEqual(got?.items, []);
    assert.equal(got?.label, 'default');
    assert.equal(got?.$v, 2);
  });

  it('skips steps at or below the stored $v', async () => {
    let ran1 = 0;
    register(TEST_TYPE, 'migrate', () => ({
      1: () => { ran1++; },
      2: (n: Record<string, unknown>) => { n.upgraded = true; },
    }));

    const inner = createMemoryTree();
    const { base: tree } = withStoragePolicy(inner);
    const node = createNode('/a', TEST_TYPE, {});
    node.$v = 1;
    await inner.set(node);

    const got = await tree.get('/a');
    assert.equal(ran1, 0);
    assert.equal(got?.upgraded, true);
    assert.equal(got?.$v, 2);
  });

  it('migrates # components by their own ladder; bare $type values are data and stay untouched', async () => {
    register(COMP_TYPE, 'migrate', () => ({
      1: (n: Record<string, unknown>) => { n.renamed = n.old; delete n.old; },
    }));

    const inner = createMemoryTree();
    const { base: tree } = withStoragePolicy(inner);
    // Bare $type-carrying value = node-body DATA (a stored snapshot), not a
    // component — held in a variable so the codemod's literal scan stays clean.
    const storedSnapshot = { $type: COMP_TYPE, old: 7 };
    await inner.set({
      $path: '/a', $type: 'dir',
      '#stats': { $type: COMP_TYPE, old: 42 },
      snapshot: storedSnapshot,
    });

    const got = await tree.get('/a');
    const stats = got?.['#stats'] as Record<string, unknown>;
    assert.equal(stats.renamed, 42);
    assert.equal(stats.$v, 1);

    const snapshot = got?.snapshot as Record<string, unknown>;
    assert.equal(snapshot.old, 7);
    assert.equal(snapshot.$v, undefined, 'bare $type value is plain data — never migrated');
  });

  it('read migrates in memory but does NOT write back — raw stays old, converges on next write (core-anz4.9)', async () => {
    register(TEST_TYPE, 'migrate', () => ({
      1: (n: Record<string, unknown>) => { n.fixed = true; },
    }));

    const inner = createMemoryTree();
    const { base: tree } = withStoragePolicy(inner);
    await inner.set(createNode('/a', TEST_TYPE, {}));
    const rev0 = (await inner.get('/a'))?.$rev;

    const got = await tree.get('/a');
    assert.equal(got?.fixed, true, 'caller sees the migrated shape');

    const raw = await inner.get('/a');
    assert.equal(raw?.fixed, undefined, 'storage untouched by the read');
    assert.equal(raw?.$v, undefined);
    assert.equal(raw?.$rev, rev0, 'no $rev bump from a read');

    // Convergence happens on the next ordinary write, not on the read.
    await tree.set(got!);
    const converged = await inner.get('/a');
    assert.equal(converged?.fixed, true);
    assert.equal(converged?.$v, 1);
    assert.equal(converged?.$rev, (rev0 ?? 0) + 1, 'write persists migrated shape N -> N+1');
  });

  it('set() stamps $v on node and # components', async () => {
    register(TEST_TYPE, 'migrate', () => ({ 1: () => {} }));
    register(COMP_TYPE, 'migrate', () => ({ 1: () => {}, 2: () => {} }));

    const inner = createMemoryTree();
    const { base: tree } = withStoragePolicy(inner);
    await tree.set({
      $path: '/a', $type: TEST_TYPE,
      '#stats': { $type: COMP_TYPE },
    });

    const raw = await inner.get('/a');
    assert.equal(raw?.$v, 1);
    assert.equal((raw?.['#stats'] as Record<string, unknown>).$v, 2);
  });

  it('getChildren and scanChildren serve migrated nodes', async () => {
    register(TEST_TYPE, 'migrate', () => ({
      1: (n: Record<string, unknown>) => { n.migrated = true; },
    }));

    const inner = createMemoryTree();
    const { base: tree } = withStoragePolicy(inner);
    await inner.set(createNode('/', 'root', {}));
    await inner.set(createNode('/a', TEST_TYPE, {}));
    await inner.set(createNode('/b', TEST_TYPE, {}));

    const { items } = await tree.getChildren('/');
    for (const n of items.filter(n => n.$type === TEST_TYPE)) {
      assert.equal(n.migrated, true);
      assert.equal(n.$v, 1);
    }

    assert.ok(tree.scanChildren, 'memory tree exposes scanChildren — the policy base must too');
    for await (const entry of tree.scanChildren('/')) {
      if (entry.node.$type !== TEST_TYPE) continue;
      assert.equal(entry.node.migrated, true);
      assert.equal(entry.node.$v, 1);
    }
  });

  it('does not touch types with no registered migrations when others have them', async () => {
    register(UNREL_TYPE, 'migrate', () => ({
      1: (n: Record<string, unknown>) => { n.bumped = true; },
    }));

    const inner = createMemoryTree();
    const { base: tree } = withStoragePolicy(inner);
    await inner.set(createNode('/plain', 'dir', { label: 'x' }));

    const got = await tree.get('/plain');
    assert.equal(got?.bumped, undefined);
    assert.equal(got?.$v, undefined);
  });

  it('patchMany persists the migrated post-image, not ops against the stale stored shape (core-anz4.9)', async () => {
    register(TEST_TYPE, 'migrate', () => ({
      1: (n: Record<string, unknown>) => { n.body = n.text; delete n.text; },
    }));

    const inner = createMemoryTree();
    const { tree } = withStoragePolicy(inner);
    await inner.set(createNode('/p', 'dir', {}));
    await inner.set(createNode('/p/a', TEST_TYPE, { text: 'hi', count: 1 }));
    const rev0 = (await inner.get('/p/a'))?.$rev;

    assert.ok(tree.patchMany, 'memory-backed policy exposes patchMany');
    await tree.patchMany('/p', [{ path: '/p/a', ops: [['r', 'count', 2]] }]);

    // Reads no longer converge storage, so the stored node was still v0 when the
    // batch ran. The mutation-member must ship the migrated post-image, not ops
    // applied to the stale shape (which would leave `text` and drop the rename).
    const raw = await inner.get('/p/a');
    assert.equal(raw?.body, 'hi', 'migrated: text renamed to body');
    assert.equal(raw?.text, undefined, 'old field gone');
    assert.equal(raw?.count, 2, 'mutation applied');
    assert.equal(raw?.$v, 1, 'stamped to current version');
    assert.equal(raw?.$rev, (rev0 ?? 0) + 1, 'converted set-member passes OCC and bumps exactly once');
  });

  it('patchMany mixed batch: set-member, mutation on a v0 node, and test-only member in one commit (core-anz4.9)', async () => {
    register(TEST_TYPE, 'migrate', () => ({
      1: (n: Record<string, unknown>) => { n.body = n.text; delete n.text; },
    }));

    const inner = createMemoryTree();
    const { tree } = withStoragePolicy(inner);
    await inner.set(createNode('/p', 'dir', {}));
    await inner.set(createNode('/p/a', TEST_TYPE, { text: 'hi', count: 1 }));
    await inner.set(createNode('/p/b', 'dir', { flag: 'x' }));
    const aRev = (await inner.get('/p/a'))?.$rev;
    const bRev = (await inner.get('/p/b'))?.$rev;

    await tree.patchMany!('/p', [
      { path: '/p/new', node: createNode('/p/new', 'dir', { label: 'n' }) },
      { path: '/p/a', ops: [['r', 'count', 2]] },
      { path: '/p/b', ops: [['t', 'flag', 'x']] },
    ]);

    const created = await inner.get('/p/new');
    assert.equal(created?.label, 'n');
    assert.ok(isUlid(created?.$id ?? ''), 'set-member minted identity');

    const a = await inner.get('/p/a');
    assert.equal(a?.body, 'hi', 'mutation-member converged the migrated shape');
    assert.equal(a?.count, 2);
    assert.equal(a?.$v, 1);
    assert.equal(a?.$rev, (aRev ?? 0) + 1, 'mutation-member bumps exactly once');

    const b = await inner.get('/p/b');
    assert.equal(b?.$rev, bRev, 'test-only member does not write or bump');
  });

  it('test-only member preconditions evaluate against the MIGRATED shape (core-anz4.9)', async () => {
    register(TEST_TYPE, 'migrate', () => ({
      1: (n: Record<string, unknown>) => { n.body = n.text; delete n.text; },
    }));

    const inner = createMemoryTree();
    const { tree } = withStoragePolicy(inner);
    await inner.set(createNode('/p', 'dir', {}));
    await inner.set(createNode('/p/a', TEST_TYPE, { text: 'hi' }));
    const rev0 = (await inner.get('/p/a'))?.$rev;

    // Precondition on a field that only exists AFTER migration: must pass even
    // though raw storage still holds `text`, and must write nothing.
    await tree.patchMany!('/p', [{ path: '/p/a', ops: [['t', 'body', 'hi']] }]);
    const raw = await inner.get('/p/a');
    assert.equal(raw?.text, 'hi', 'test-only member wrote nothing');
    assert.equal(raw?.$rev, rev0, 'no $rev bump');

    await assert.rejects(
      () => tree.patchMany!('/p', [{ path: '/p/a', ops: [['t', 'body', 'nope']] }]),
      (e: OpError) => e.code === 'CONFLICT',
    );
  });

  it('concurrent write during a batch: migration-pending member denies the whole batch, converged member merges (core-anz4.9)', async () => {
    register(TEST_TYPE, 'migrate', () => ({
      1: (n: Record<string, unknown>) => { n.body = n.text; delete n.text; },
    }));

    const mem = createMemoryTree();
    await mem.set(createNode('/p', 'dir', {}));
    await mem.set(createNode('/p/a', TEST_TYPE, { text: 'hi', count: 1 }));
    await mem.set(createNode('/p/c', 'dir', { count: 1 }));

    // Interpose the backing: a concurrent writer lands right after the policy's
    // pre-read returns its (stale) snapshot.
    let inject: string | undefined;
    const backing: Tree = {
      ...mem,
      async get(path, ctx) {
        const n = await mem.get(path, ctx);
        if (path === inject) {
          inject = undefined;
          await mem.set({ ...(await mem.get(path))!, note: 'concurrent' });
        }
        return n;
      },
    };
    const { tree } = withStoragePolicy(backing);

    // Migration pending → converted set-member carries the pre-read $rev → OCC
    // denies the whole batch; the concurrent write survives untouched.
    inject = '/p/a';
    await assert.rejects(
      () => tree.patchMany!('/p', [{ path: '/p/a', ops: [['r', 'count', 2]] }]),
      (e: OpError) => e.code === 'CONFLICT',
    );
    const a = await mem.get('/p/a');
    assert.equal(a?.note, 'concurrent', 'concurrent write preserved');
    assert.equal(a?.text, 'hi', 'denied batch left storage untouched');
    assert.equal(a?.count, 1);

    // Converged node → ops-member forwarded → the adapter merges against
    // CURRENT storage under its lock (old semantics, no implicit OCC).
    inject = '/p/c';
    await tree.patchMany!('/p', [{ path: '/p/c', ops: [['r', 'count', 2]] }]);
    const c = await mem.get('/p/c');
    assert.equal(c?.note, 'concurrent', 'concurrent write merged, not clobbered');
    assert.equal(c?.count, 2, 'batch op applied on top');
  });

  it('system path (base) converges a migration-pending node on patch and patchMany (core-anz4.9)', async () => {
    register(TEST_TYPE, 'migrate', () => ({
      1: (n: Record<string, unknown>) => { n.body = n.text; delete n.text; },
    }));

    const inner = createMemoryTree();
    const { base } = withStoragePolicy(inner);
    await inner.set(createNode('/p', 'dir', {}));
    await inner.set(createNode('/p/a', TEST_TYPE, { text: 'hi', count: 1 }));
    await inner.set(createNode('/p/b', TEST_TYPE, { text: 'yo', count: 1 }));
    const aRev = (await inner.get('/p/a'))?.$rev;

    // patch: ops built against a migrated read must not land on the old shape.
    await base.patch('/p/a', [['r', 'count', 2]]);
    const a = await inner.get('/p/a');
    assert.equal(a?.body, 'hi', 'patch converged the migrated shape');
    assert.equal(a?.text, undefined);
    assert.equal(a?.count, 2);
    assert.equal(a?.$v, 1);
    assert.equal(a?.$rev, (aRev ?? 0) + 1, 'exactly one bump');

    // patchMany test-only against a migrated field (v0 in storage), then mutation.
    await base.patchMany!('/p', [{ path: '/p/b', ops: [['t', 'body', 'yo']] }]);
    assert.equal((await inner.get('/p/b'))?.text, 'yo', 'test-only member wrote nothing');

    await base.patchMany!('/p', [{ path: '/p/b', ops: [['r', 'count', 2]] }]);
    const b = await inner.get('/p/b');
    assert.equal(b?.body, 'yo', 'patchMany converged the migrated shape');
    assert.equal(b?.text, undefined);
    assert.equal(b?.count, 2);
    assert.equal(b?.$v, 1);
  });

  it('revisionless legacy fs node: pending-migration mutation converges via blind upsert — documented residual (core-anz4.9)', async () => {
    register(TEST_TYPE, 'migrate', () => ({
      1: (n: Record<string, unknown>) => { n.body = n.text; delete n.text; },
    }));

    const dir = await mkdtemp(join(tmpdir(), 'treenix-policy-revless-'));
    try {
      // Hand-written legacy file: no $rev, no $v — fs serves it as-is.
      await writeFile(join(dir, 'a.json'), JSON.stringify({ $type: TEST_TYPE, text: 'hi', count: 1 }) + '\n');
      const fsTree = await createFsTree(dir);

      let fired = false;
      const backing: Tree = {
        ...fsTree,
        async get(path, ctx) {
          const n = await fsTree.get(path, ctx);
          if (path === '/a' && !fired) {
            fired = true;
            await fsTree.set({ ...(await fsTree.get(path))!, note: 'concurrent' });
          }
          return n;
        },
      };
      const { tree } = withStoragePolicy(backing);

      // No $rev on the pre-read snapshot → the converted set-member has no OCC
      // token → blind upsert: the migrated post-image wins and the concurrent
      // write is lost. Documented residual — narrower than the pre-anz4.9
      // writeback, which blind-upserted the same nodes on every read.
      await tree.patchMany!('/', [{ path: '/a', ops: [['r', 'count', 2]] }]);
      const raw = await fsTree.get('/a');
      assert.equal(raw?.body, 'hi', 'migrated shape converged on disk');
      assert.equal(raw?.text, undefined);
      assert.equal(raw?.count, 2);
      assert.equal(raw?.$v, 1);
      assert.equal(raw?.note, undefined, 'residual: revisionless blind upsert clobbers the concurrent write');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ── validation step (write-barrier, client path only) ──

describe('policy: validation step (Write-Barrier)', () => {
  let inner: ReturnType<typeof createMemoryTree>;
  let tree: Tree;

  beforeEach(() => {
    clearRegistry();
    inner = createMemoryTree();
    ({ tree } = withStoragePolicy(inner));

    register('metadata', 'schema', () => ({
      title: 'Metadata',
      type: 'object',
      properties: {
        title: { type: 'string', title: 'Title' },
        count: { type: 'number', title: 'Count' },
        active: { type: 'boolean', title: 'Active' },
      },
    }));
  });

  it('allows valid components', async () => {
    await tree.set({
      $path: '/a', $type: 'item',
      '#metadata': { $type: 'metadata', title: 'Hello', count: 5, active: true },
    } as NodeData);

    const node = await tree.get('/a');
    assert.equal((node?.['#metadata'] as any).title, 'Hello');
  });

  it('rejects wrong type: string expected, got number', async () => {
    await assert.rejects(
      () => tree.set({
        $path: '/a', $type: 'item',
        '#metadata': { $type: 'metadata', title: 42 },
      } as NodeData),
    );
  });

  it('rejects wrong type: number expected, got string', async () => {
    await assert.rejects(
      () => tree.set({
        $path: '/a', $type: 'item',
        '#metadata': { $type: 'metadata', count: 'not a number' },
      } as NodeData),
    );
  });

  it('allows missing optional fields', async () => {
    // Only title set, count and active missing — fine
    await tree.set({
      $path: '/a', $type: 'item',
      '#metadata': { $type: 'metadata', title: 'Hello' },
    } as NodeData);
    assert.ok(await tree.get('/a'));
  });

  it('passes through nodes without schemas', async () => {
    await tree.set({
      $path: '/a', $type: 'item',
      '#custom': { $type: 'no-schema-type', anything: 'goes' },
    } as NodeData);
    assert.ok(await tree.get('/a'));
  });

  it('skips system fields', async () => {
    // $path, $type, $rev etc should not trigger validation
    await tree.set(createNode('/a', 'item'));
    assert.ok(await tree.get('/a'));
  });

  it('rejects patch that produces invalid state', async () => {
    await tree.set({
      $path: '/a', $type: 'item',
      '#metadata': { $type: 'metadata', title: 'Hello', count: 5 },
    } as NodeData);
    // Patch count to a string — violates schema (number expected)
    await assert.rejects(
      () => tree.patch('/a', [['r', '#metadata.count', 'not-a-number']]),
      (e: Error) => e.name === 'OpError' && e.message.includes('Validation'),
    );
  });

  it('allows valid patch', async () => {
    await tree.set({
      $path: '/a', $type: 'item',
      '#metadata': { $type: 'metadata', title: 'Hello', count: 5 },
    } as NodeData);
    // Patch count to a valid number
    await tree.patch('/a', [['r', '#metadata.count', 10]]);
    const node = await tree.get('/a');
    assert.equal((node?.['#metadata'] as any).count, 10);
  });

  it('patch never writes invalid data to underlying tree', async () => {
    await tree.set({
      $path: '/a', $type: 'item',
      '#metadata': { $type: 'metadata', title: 'Hello', count: 5 },
    } as NodeData);

    // Spy on inner tree to detect any writes
    let innerSetCalls = 0;
    const origSet = inner.set.bind(inner);
    inner.set = async (node, ctx) => { innerSetCalls++; return origSet(node, ctx); };
    innerSetCalls = 0;

    // Invalid patch — should throw without writing to inner tree
    await assert.rejects(
      () => tree.patch('/a', [['r', '#metadata.count', 'not-a-number']]),
    );
    assert.equal(innerSetCalls, 0, 'no writes should reach inner tree on validation failure');

    // Verify the original data is intact
    const node = await inner.get('/a');
    assert.equal((node?.['#metadata'] as any).count, 5);
  });

  it('get/getChildren/remove pass through', async () => {
    await inner.set(createNode('/a', 'item'));
    assert.ok(await tree.get('/a'));
    const children = await tree.getChildren('/');
    assert.equal(children.items.length, 1);
    assert.equal(await tree.remove('/a'), true);
  });
});

// ── $refs step (derived index on set) ──

describe('policy: $refs step', () => {
  function setup() {
    return withStoragePolicy(createMemoryTree()).tree;
  }

  it('extracts $ref fields into $refs', async () => {
    const tree = setup();
    await tree.set({
      $path: '/order/1',
      $type: 'cafe.order',
      '#customer': { $type: 'ref', $ref: '/customers/ivan' },
      items: [{ $type: 'ref', $ref: '/menu/latte' }],
    });

    const node = await tree.get('/order/1');
    assert.ok(node?.$refs);
    assert.equal(node.$refs.length, 2);
    assert.ok(node.$refs.some(r => r.t === '/customers/ivan' && r.f === '#customer'));
    assert.ok(node.$refs.some(r => r.t === '/menu/latte' && r.f === 'items.0'));
  });

  it('preserves standalone refs (no f:)', async () => {
    const tree = setup();
    await tree.set({
      $path: '/factory',
      $type: 'mfg.factory',
      $refs: [{ t: '/suppliers/bob', d: { $type: 'supplies', since: '2025-01' } }],
    });

    const node = await tree.get('/factory');
    assert.ok(node?.$refs);
    assert.equal(node.$refs.length, 1);
    assert.equal(node.$refs[0].t, '/suppliers/bob');
    assert.equal(node.$refs[0].d?.$type, 'supplies');
    assert.equal(node.$refs[0].f, undefined);
  });

  it('merges standalone + derived refs', async () => {
    const tree = setup();
    await tree.set({
      $path: '/order/2',
      $type: 'cafe.order',
      '#customer': { $type: 'ref', $ref: '/customers/ivan' },
      $refs: [{ t: '/promos/summer', d: { $type: 'applied-promo' } }],
    });

    const node = await tree.get('/order/2');
    assert.ok(node?.$refs);
    assert.equal(node.$refs.length, 2);
    // standalone first, then derived
    assert.equal(node.$refs[0].t, '/promos/summer');
    assert.equal(node.$refs[1].t, '/customers/ivan');
  });

  it('returns undefined $refs when no refs exist', async () => {
    const tree = setup();
    await tree.set({ $path: '/plain', $type: 'dir' });

    const node = await tree.get('/plain');
    assert.equal(node?.$refs, undefined);
    assert.equal(Object.hasOwn(node!, '$refs'), false);
  });

  it('scans nested component refs', async () => {
    const tree = setup();
    await tree.set({
      $path: '/node',
      $type: 'test',
      '#delivery': {
        $type: 'logistics.delivery',
        courier: { $type: 'ref', $ref: '/couriers/alex' },
        warehouse: { $type: 'ref', $ref: '/warehouses/main' },
      },
    });

    const node = await tree.get('/node');
    assert.ok(node?.$refs);
    assert.equal(node.$refs.length, 2);
    assert.ok(node.$refs.some(r => r.t === '/couriers/alex' && r.f === '#delivery.courier'));
    assert.ok(node.$refs.some(r => r.t === '/warehouses/main' && r.f === '#delivery.warehouse'));
  });

  it('updates $refs after patch (single write)', async () => {
    const tree = setup();
    await tree.set({
      $path: '/order/3', $type: 'cafe.order',
      '#customer': { $type: 'ref', $ref: '/customers/alice' },
    });

    await tree.patch('/order/3', [
      ['r', '#customer', { $type: 'ref', $ref: '/customers/bob' }],
    ]);

    const node = await tree.get('/order/3');
    assert.ok(node?.$refs);
    assert.equal(node.$refs.length, 1);
    assert.equal(node.$refs[0].t, '/customers/bob');
    assert.equal(node.$refs[0].f, '#customer');
  });

  it('removes $refs when patch clears all refs', async () => {
    const tree = setup();
    await tree.set({
      $path: '/order/4', $type: 'cafe.order',
      '#customer': { $type: 'ref', $ref: '/customers/alice' },
    });

    await tree.patch('/order/4', [['d', '#customer']]);

    const node = await tree.get('/order/4');
    assert.equal(node?.$refs, undefined);
  });

  it('test-only patch does not write or bump $rev', async () => {
    const tree = setup();
    await tree.set({ $path: '/x', $type: 't', value: 1 });
    const before = await tree.get('/x');

    await tree.patch('/x', [['t', 'value', 1]]);

    const after = await tree.get('/x');
    assert.equal(after?.$rev, before?.$rev);
  });
});

// ── trash step (soft-delete on remove) ──

const DAY = 86_400_000;

async function trashSetup(): Promise<{ inner: Tree; tree: Tree }> {
  const inner = createMemoryTree();
  await inner.set(createNode('/', 'root', {}));
  await inner.set(createNode('/clients', 'dir', {}));
  await inner.set(createNode('/clients/acme', 'crm.client', { name: 'Acme' }));
  await inner.set(createNode('/clients/acme', 'crm.client', { name: 'Acme Corp' })); // $rev → 2
  await inner.set(createNode('/clients/acme/deal', 'crm.deal', { sum: 100 }));
  await inner.set(createNode('/clients/acme/deal/note', 'doc.note', { text: 'hi' }));
  return { inner, tree: withStoragePolicy(inner).tree };
}

async function trashEntries(tree: Tree) {
  const { items } = await tree.getChildren(TRASH_ROOT, { depth: 1 });
  return items;
}

describe('policy: trash step', () => {
  it('moves the removed node into /sys/trash and reports the origin', async () => {
    const { inner, tree } = await trashSetup();

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
    const { inner, tree } = await trashSetup();
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
    const { inner, tree } = await trashSetup();
    await tree.remove('/clients/acme');
    const [entry] = await trashEntries(inner);

    // core-anz4.8 regression: the copied payload subtree must go with the marker.
    await inner.set(createNode(`${entry.$path}/acme/deal`, 'crm.deal', { sum: 100 }));

    assert.equal(await tree.remove(entry.$path), true);
    assert.deepEqual(await trashEntries(inner), []);
    assert.equal(await inner.get(`${entry.$path}/acme`), undefined);
    assert.equal(await inner.get(`${entry.$path}/acme/deal`), undefined);
  });

  it('returns false for a missing node and writes nothing', async () => {
    const { inner, tree } = await trashSetup();
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

describe('policy: sweepTrash', () => {
  afterEach(() => {
    delete process.env.TREENIX_TRASH_TTL_DAYS;
  });

  it('purges entries older than the TTL, keeps fresh ones', async () => {
    const { inner, tree } = await trashSetup();

    await tree.remove('/clients/acme');
    const oldPath = `${TRASH_ROOT}/${Date.now() - 40 * DAY}-0-old~node`;
    await inner.set({ $path: oldPath, $type: TRASH_ENTRY_TYPE, from: '/old/node', removedAt: 'past' });

    const purged = await sweepTrash(inner, 30 * DAY);
    assert.equal(purged, 1);

    const left = await trashEntries(inner);
    assert.equal(left.length, 1);
    assert.equal(left[0].from, '/clients/acme');
  });

  it('purges the whole entry subtree, not just the marker (core-anz4.8)', async () => {
    const { inner, tree } = await trashSetup();

    await tree.remove('/clients/acme');
    const [entry] = await trashEntries(inner);
    // Deep payload under the entry — mirrors an entry trashed with descendants.
    await inner.set(createNode(`${entry.$path}/acme/deal`, 'crm.deal', { sum: 100 }));
    await inner.set(createNode(`${entry.$path}/acme/deal/note`, 'doc.note', { text: 'hi' }));

    const purged = await sweepTrash(inner, -1); // cutoff in the future — everything is stale
    assert.equal(purged, 1);

    assert.deepEqual(await trashEntries(inner), []);
    const { items: leftovers } = await inner.getChildren(TRASH_ROOT, { depth: -1 });
    assert.deepEqual(leftovers, [], 'no orphaned payload nodes under the purged entry');
    assert.equal(await inner.get(`${entry.$path}/acme`), undefined);
    assert.equal(await inner.get(`${entry.$path}/acme/deal/note`), undefined);
  });

  it('rejects an invalid TTL env instead of silently skipping GC', async () => {
    const { inner } = await trashSetup();
    process.env.TREENIX_TRASH_TTL_DAYS = 'soon';
    await assert.rejects(async () => sweepTrash(inner));
  });

  it('is a no-op on an empty or absent trash root', async () => {
    const inner = createMemoryTree();
    await inner.set(createNode('/', 'root', {}));
    assert.equal(await sweepTrash(inner, DAY), 0);
  });
});

// core-anz4.8: a trashed MOUNT POINT keeps its mount component in its
// /sys/trash copy. If GC resolved that mount it would activate the adapter,
// enumerate EXTERNAL content, and delete data in the external store. Trash must
// be mount-inert — the copied subtree is plain rootStore data.
describe('policy: trash GC is mount-inert (core-anz4.8)', () => {
  const FAKE_MOUNT = 't.mount.fake.anz48';

  afterEach(() => {
    try { unregister(FAKE_MOUNT, 'mount'); } catch { /* not registered in this test */ }
  });

  it('purging a trashed mount point never touches the external adapter', async () => {
    const spy = { getChildren: 0, remove: 0 };
    const fake: Tree = {
      async get() { return undefined; },
      async getChildren(path: string) {
        spy.getChildren++;
        // One synthetic external child at the enumerated leaf so a buggy GC
        // would recurse into it and issue a remove against this adapter.
        const items: NodeData[] = path.endsWith('/ext')
          ? [createNode(`${path}/EXTERNAL`, 'ext.doc', {})]
          : [];
        return { items, total: items.length };
      },
      async set() {},
      async remove() { spy.remove++; return true; },
      async patch() {},
    };
    register(FAKE_MOUNT, 'mount', () => fake);

    const inner = createMemoryTree();
    await inner.set(createNode('/', 'root', {}));
    const { base, tree } = withStoragePolicy(withMounts(inner));

    // A live mount point in the business tree, then soft-delete it: the copy
    // under /sys/trash carries the #mount component.
    await tree.set(createNode('/ext', 'dir', {}, { mount: { $type: FAKE_MOUNT } }));
    assert.equal(await tree.remove('/ext'), true);

    const [entry] = (await base.getChildren(TRASH_ROOT, { depth: 1 })).items;
    assert.ok(entry, 'a trash entry exists');

    // Future cutoff → the entry is stale → subtree purge runs.
    assert.equal(await sweepTrash(base, -1), 1);

    const { items: leftovers } = await base.getChildren(TRASH_ROOT, { depth: -1 });
    assert.deepEqual(leftovers, [], 'the local trash copy is gone');
    assert.equal(spy.getChildren, 0, 'GC never enumerated the external adapter');
    assert.equal(spy.remove, 0, 'GC never deleted external adapter data');
  });
});

describe('policy: trash through the pipeline (e2e)', () => {
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

    // Internal path: the system base sits below the trash step — hard delete, no new entry.
    await systemTree.set(createNode('/board/t2', 'task', { title: 'y' }));
    assert.equal(await systemTree.remove('/board/t2'), true);
    const after = await systemTree.getChildren(TRASH_ROOT, { depth: 1 });
    assert.equal(after.items.length, 1);
  });
});

// ── $id identity step (core-gk8.10, Stage 1) ──

describe('policy: $id identity (gk8.10)', () => {
  function setup() {
    const inner = createMemoryTree();
    const { base, tree } = withStoragePolicy(inner);
    return { inner, base, tree };
  }

  it('mints a ULID at first persist — client and system paths both stamp', async () => {
    const { inner, base, tree } = setup();

    await tree.set(createNode('/a', 'doc', { title: 'hi' }));
    await base.set(createNode('/b', 'doc', {}));

    const a = await inner.get('/a');
    const b = await inner.get('/b');
    assert.ok(isUlid(a?.$id), 'client path stamps');
    assert.ok(isUlid(b?.$id), 'system path stamps');
    assert.notEqual(a?.$id, b?.$id);
  });

  it('preserves the stored $id on a blind upsert without one (legacy echo)', async () => {
    const { inner, tree } = setup();
    await tree.set(createNode('/a', 'doc', { title: 'v1' }));
    const minted = (await inner.get('/a'))?.$id;

    await tree.set(createNode('/a', 'doc', { title: 'v2' }));

    const after = await inner.get('/a');
    assert.equal(after?.title, 'v2');
    assert.equal(after?.$id, minted, 'identity survives the id-less rewrite');
  });

  it('accepts a matching echo and rejects a different incoming $id', async () => {
    const { inner, tree } = setup();
    await tree.set(createNode('/a', 'doc', {}));
    const stored = await inner.get('/a');
    assert.ok(stored?.$id);

    await tree.set({ ...stored, title: 'echoed' });
    assert.equal((await inner.get('/a'))?.title, 'echoed');

    await assert.rejects(
      () => tree.set({ ...stored, $id: ulid(), $rev: undefined }),
      (e: unknown) => e instanceof OpError && e.code === 'BAD_REQUEST',
    );
  });

  it('accepts a carried $id on a new path — restore/import relocates identity', async () => {
    const { inner, tree } = setup();
    const carried = ulid();

    await tree.set({ ...createNode('/restored', 'doc', {}), $id: carried });

    assert.equal((await inner.get('/restored'))?.$id, carried);
  });

  it('trash copy keeps the identity — restore brings the same $id back', async () => {
    const { inner, tree } = setup();
    await inner.set(createNode('/', 'root', {}));
    await tree.set(createNode('/thing', 'doc', { name: 'x' }));
    const id = (await inner.get('/thing'))?.$id;
    assert.ok(id);

    await tree.remove('/thing');
    const { items } = await inner.getChildren(TRASH_ROOT, { depth: 1 });
    const copy = await inner.get(`${items[0].$path}/thing`);
    assert.equal(copy?.$id, id, 'identity survives the trash copy');
  });

  it('patch preserves $id (cache patch = get -> apply -> policied set)', async () => {
    const { inner, tree } = setup();
    await tree.set(createNode('/a', 'doc', { n: 1 }));
    const id = (await inner.get('/a'))?.$id;

    await tree.patch('/a', [['r', 'n', 2]]);

    const after = await inner.get('/a');
    assert.equal(after?.n, 2);
    assert.equal(after?.$id, id);
  });
});
