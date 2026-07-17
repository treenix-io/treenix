// Pipeline invariants net (cut-series 2026-07, Wave 0 — core-gk8.14 part a).
// Every incident comment in createPipeline (server.ts) becomes an executable
// assert: layer ORDER is behavior, and these are the behaviors that broke when
// the order was wrong. core-tcc1 (late-bound ref rewiring) and core-5fqq
// (wrapper collapse) must keep this file green WITHOUT touching an assert —
// an assert change here means the cut changed behavior.
//
// Covered incidents: R-gk8.29 (migration above mounts), gk8.8 (trash below
// subscriptions; systemTree stays hard — entry shape itself is pinned in
// tree/policy.test.ts), core-dpp (wrapTree above subscriptions, boot writes
// below), $volatile flag inert (feature cut — the checks moved to the merged
// tree with inverted expectations), validation write-barrier atomicity, ACL
// fail-closed, external-watch wiring (inject + cache invalidation).

import { A, createNode, R, register, S, unregister, W, type NodeData } from '#core';
import { OpError } from '#errors';
import type { MountCtx } from '#mount';
import { withAcl } from '#security/acl-tree';
import { type NodeEvent, withSubscriptions } from '#sub';
import { createMemoryTree, type Tree, type TreeWatchScope } from '#tree';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createPipeline } from './server';

// ── helpers ──

const code = (expected: string) => (e: unknown) =>
  e instanceof OpError && e.code === expected;

/** Memory bootstrap with the standard root system grant (same shape the seed
 *  deploys) — the ONLY thing that opens the systemTree identity. */
async function grantedBootstrap(): Promise<Tree> {
  const bootstrap = createMemoryTree();
  const root = createNode('/', 'root', {});
  root.$acl = [{ g: 'system', p: R | W | A | S }];
  await bootstrap.set(root);
  return bootstrap;
}

/** Race-free watch consumer — registration happens synchronously on creation. */
function pump(tree: Tree, scope: TreeWatchScope) {
  const iter = tree.watch!(scope)[Symbol.asyncIterator]();
  const queue: NodeEvent[] = [];
  const waiters: ((e: NodeEvent) => void)[] = [];
  const feed = (r: IteratorResult<NodeEvent>): void => {
    if (r.done) return;
    const w = waiters.shift();
    if (w) w(r.value as NodeEvent);
    else queue.push(r.value as NodeEvent);
    void iter.next().then(feed);
  };
  void iter.next().then(feed);
  return {
    async take(): Promise<NodeEvent> {
      if (queue.length) return queue.shift()!;
      return new Promise<NodeEvent>(res => waiters.push(res));
    },
    stop: () => iter.return?.(),
  };
}

// Static mount adapter shared by mount-based sections: the mount component's
// `key` selects a backing tree. Backing trees speak OUTER paths (withMounts
// forwards the full path).
const backings = new Map<string, Tree>();

// ── R-gk8.29: migration wraps the MOUNTED tree ──
// Nodes served by mount adapters (fs/mongo/federation — the only data that
// outlives code versions) MUST migrate on read (in memory); the corpus
// converges when a migrated node is next written (core-anz4.9 — reads never
// write back).

describe('invariant R-gk8.29: mounted nodes migrate on read', () => {
  before(() => {
    register('inv.mount.backing', 'mount', (mount: { key?: unknown }) => {
      const t = backings.get(String(mount.key));
      if (!t) throw new Error(`no backing registered for key ${String(mount.key)}`);
      return t;
    });
    register('inv.versioned', 'migrate', () => ({
      1: (d: Record<string, unknown>) => {
        d.renamed = d.old;
        delete d.old;
      },
    }));
  });

  after(() => {
    unregister('inv.versioned', 'migrate');
  });

  it('old-shape node behind a mount is served migrated, backing untouched by the read (core-anz4.9)', async () => {
    const backing = createMemoryTree();
    backings.set('versioned', backing);
    await backing.set(createNode('/data/x', 'inv.versioned', { old: 'v' }));
    const rev0 = (await backing.get('/data/x'))?.$rev;

    const bootstrap = await grantedBootstrap();
    await bootstrap.set(createNode('/data', 'test.dir', {}, { mount: { $type: 'inv.mount.backing', key: 'versioned' } }));
    const { tree } = createPipeline(bootstrap);

    const got = await tree.get('/data/x');
    assert.ok(got);
    assert.equal(got.renamed, 'v');
    assert.equal(got.old, undefined);
    assert.equal(got.$v, 1);

    // Read migrates in memory only — the persistent store is untouched.
    const stored = await backing.get('/data/x');
    assert.equal(stored?.old, 'v');
    assert.equal(stored?.renamed, undefined);
    assert.equal(stored?.$v, undefined);
    assert.equal(stored?.$rev, rev0, 'no $rev bump from a read');
  });
});

// ── $volatile: flag is inert — every node persists to the backing store ──
// The per-node volatile feature was cut (owner, core-5fqq 2026-07-03): zero
// runtime writers existed; mem-only subtrees use t.mount.memory. These are the
// former isolation checks ported to the merged tree with INVERTED expectations:
// a legacy write carrying $volatile must not break — it persists like any node.

describe('invariant: $volatile flag is inert, nodes persist to the backing store', () => {
  it('node of a formerly-volatile type is readable AND present in bootstrap', async () => {
    const bootstrap = await grantedBootstrap();
    const { tree } = createPipeline(bootstrap);

    await tree.set(createNode('/vol/x', 'inv.volatile', { n: 1 }));

    assert.equal((await tree.get('/vol/x'))?.n, 1);
    assert.equal((await bootstrap.get('/vol/x'))?.n, 1);

    const listed = await tree.getChildren('/vol');
    assert.deepEqual(listed.items.map(n => n.$path), ['/vol/x']);
    assert.equal((await bootstrap.getChildren('/vol')).total, 1);
  });

  it('instance-level $volatile flag on a legacy write persists the same way', async () => {
    const bootstrap = await grantedBootstrap();
    const { tree } = createPipeline(bootstrap);

    const n: NodeData = { $path: '/vol/y', $type: 'inv.plain', $volatile: true, n: 2 };
    await tree.set(n);

    assert.equal((await tree.get('/vol/y'))?.n, 2);
    assert.equal((await bootstrap.get('/vol/y'))?.n, 2);
  });
});

// ── validation: write-barrier is atomic ──

describe('invariant: invalid writes are rejected whole, nothing lands', () => {
  before(() => {
    register('inv.strict', 'schema', () => ({
      $id: 'inv.strict',
      title: 'Strict',
      type: 'object' as const,
      properties: { n: { type: 'number' as const } },
      required: ['n'],
    }));
  });

  after(() => {
    unregister('inv.strict', 'schema');
  });

  it('invalid set rejects BAD_REQUEST; neither store nor cache holds the node', async () => {
    const bootstrap = await grantedBootstrap();
    const { tree } = createPipeline(bootstrap);

    await assert.rejects(
      () => tree.set(createNode('/biz/bad', 'inv.strict', { n: 'oops' })),
      code('BAD_REQUEST'),
    );

    assert.equal(await bootstrap.get('/biz/bad'), undefined);
    assert.equal(await tree.get('/biz/bad'), undefined);

    await assert.rejects(
      () => tree.set(createNode('/biz/empty', 'inv.strict', {})),
      code('BAD_REQUEST'),
    );
  });

  it('invalid patch rejects and leaves the node byte-identical', async () => {
    const bootstrap = await grantedBootstrap();
    const { tree } = createPipeline(bootstrap);

    await tree.set(createNode('/biz/good', 'inv.strict', { n: 1 }));
    const before = await tree.get('/biz/good');

    await assert.rejects(() => tree.patch('/biz/good', [['r', 'n', 'oops']]), code('BAD_REQUEST'));

    const got = await tree.get('/biz/good');
    assert.equal(got?.n, 1);
    assert.equal(got?.$rev, before!.$rev);

    await tree.patch('/biz/good', [['r', 'n', 2]]);
    assert.equal((await tree.get('/biz/good'))?.n, 2);
  });
});

// ── gk8.8: trash sits BELOW subscriptions, systemTree below trash ──
// The trash entry/copy shape is pinned in tree/trash.test.ts; here we pin the
// EVENT contract: copy-writes are silent, the remove emits, boot-layer ops
// (systemTree) are invisible to subscribers entirely.

describe('invariant gk8.8: trash copy-writes are silent, remove emits', () => {
  it('client remove emits exactly one remove event, no /sys/trash spam', async () => {
    const bootstrap = await grantedBootstrap();
    const { tree } = createPipeline(bootstrap);
    const w = pump(tree, { kind: 'all' });

    await tree.set(createNode('/biz', 'test.dir', {}));
    await tree.set(createNode('/biz/doc', 'test.item', { name: 'A' }));
    await tree.remove('/biz/doc');
    await tree.set(createNode('/biz/sentinel', 'test.item', {}));

    const seen = [await w.take(), await w.take(), await w.take(), await w.take()];
    assert.deepEqual(
      seen.map(e => [e.type, e.type === 'reconnect' ? '' : e.path]),
      [
        ['set', '/biz'],
        ['set', '/biz/doc'],
        ['remove', '/biz/doc'],
        ['set', '/biz/sentinel'],
      ],
    );
    w.stop();

    // The copies DID land — silently.
    const { items } = await tree.getChildren('/sys/trash');
    assert.equal(items.length, 1);
  });

  it('systemTree writes and removes below subscriptions stay invisible', async () => {
    const bootstrap = await grantedBootstrap();
    const { tree, systemTree } = createPipeline(bootstrap);
    const w = pump(tree, { kind: 'all' });

    await systemTree.set(createNode('/biz/boot', 'test.item', { name: 'boot' }));
    assert.ok((await systemTree.remove('/biz/boot')).changes?.length);

    // Hard delete: no trash entry either.
    assert.equal((await systemTree.getChildren('/sys/trash')).total, 0);

    await tree.set(createNode('/biz/sentinel', 'test.item', {}));
    const first = await w.take();
    assert.equal(first.type === 'set' && first.path, '/biz/sentinel');
    w.stop();
  });
});

// ── core-dpp: wrapTree (audit) sits above subscriptions, below nothing ──
// tRPC-facing writes flow through the wrap; boot-layer writes (systemTree,
// seed, log) bypass it so audit never storms at startup.

describe('invariant core-dpp: wrapTree audits pipeline writes, not boot writes', () => {
  it('pipeline.tree writes pass the wrap; systemTree writes bypass it', async () => {
    const audited: string[] = [];
    const wrap = (t: Tree): Tree => ({
      ...t,
      async set(n, ctx) {
        audited.push(n.$path);
        return t.set(n, ctx);
      },
    });

    const bootstrap = await grantedBootstrap();
    const { tree, systemTree } = createPipeline(bootstrap, undefined, wrap);

    await tree.set(createNode('/biz/a', 'test.item', {}));
    assert.deepEqual(audited, ['/biz/a']);

    await systemTree.set(createNode('/biz/b', 'test.item', {}));
    assert.deepEqual(audited, ['/biz/a']);
    assert.ok(await tree.get('/biz/b'), 'boot write must still land');
  });

  it('the wrapped tree still watches and scans (read-runtime source)', async () => {
    const wrap = (t: Tree): Tree => ({ ...t });
    const bootstrap = await grantedBootstrap();
    const { tree } = createPipeline(bootstrap, undefined, wrap);

    const w = pump(tree, { kind: 'path', path: '/biz/a' });
    await tree.set(createNode('/biz/a', 'test.item', {}));
    const ev = await w.take();
    assert.equal(ev.type, 'set');
    w.stop();

    assert.equal(typeof tree.scanChildren, 'function');
  });
});

// ── external watch: mount events reach subscribers AND invalidate the cache ──
// This is the exact contract core-tcc1 re-wires (onSelfWrite / injectExternal /
// invalidate refs). Mounts resolve lazily — wiring must be complete by then.

describe('invariant: external mount writes surface through the pipeline', () => {
  before(() => {
    register('inv.mount.ext', 'mount', (_mount: unknown, ctx: MountCtx) => {
      const t = backings.get('ext');
      if (!t) throw new Error('no ext backing');
      if (!ctx.startExternalWatch) throw new Error('pipeline did not hand startExternalWatch to the adapter');
      ctx.startExternalWatch(t, { pathPrefix: '', source: 'inv-ext' });
      return t;
    });
  });

  it('external write is forwarded to watchers and evicts the read cache', async () => {
    // The external store must expose watch — same shape a Mongo adapter has.
    const ext = withSubscriptions(createMemoryTree()).tree;
    backings.set('ext', ext);
    await ext.set(createNode('/ext/doc', 'inv.doc', { v: 1 }));

    const bootstrap = await grantedBootstrap();
    await bootstrap.set(createNode('/ext', 'test.dir', {}, { mount: { $type: 'inv.mount.ext' } }));
    const { tree } = createPipeline(bootstrap);

    // Lazy mount resolution: this get resolves the adapter and starts the
    // external watch long after createPipeline returned — must not throw
    // "pipeline not yet wired". The value is now in the read cache.
    assert.equal((await tree.get('/ext/doc'))?.v, 1);

    const w = pump(tree, { kind: 'path', path: '/ext/doc' });

    // Out-of-band write, as a change stream would observe it.
    await ext.set(createNode('/ext/doc', 'inv.doc', { v: 2 }));

    const ev = await w.take();
    assert.notEqual(ev.type, 'reconnect');
    assert.equal(ev.type !== 'reconnect' && ev.path, '/ext/doc');
    w.stop();

    // Cache was invalidated BEFORE the event was forwarded — a read now
    // must serve the new value, not the cached v:1.
    assert.equal((await tree.get('/ext/doc'))?.v, 2);
  });

  it('control: a mount WITHOUT external watch serves the cached value (staleness is the cache contract)', async () => {
    const backing = createMemoryTree();
    backings.set('static', backing);
    await backing.set(createNode('/ext2/doc', 'inv.doc', { v: 1 }));

    const bootstrap = await grantedBootstrap();
    await bootstrap.set(createNode('/ext2', 'test.dir', {}, { mount: { $type: 'inv.mount.backing', key: 'static' } }));
    const { tree } = createPipeline(bootstrap);

    assert.equal((await tree.get('/ext2/doc'))?.v, 1);

    // Out-of-band write with NO watch wired: the pipeline cache keeps serving
    // the old value. This pins that the /ext test above passes BECAUSE of
    // invalidation, not because caching silently disappeared.
    await backing.set(createNode('/ext2/doc', 'inv.doc', { v: 2 }));
    assert.equal((await tree.get('/ext2/doc'))?.v, 1);
  });
});

// ── ACL: fail closed ──
// No grant = deny. There is NO code-level bypass for the system identity —
// its power comes exclusively from the seeded root grant.

describe('invariant: ACL fails closed', () => {
  it('zero grants anywhere denies everyone — including the system identity', async () => {
    const bare = createMemoryTree();
    await bare.set(createNode('/doc', 'test.item', { name: 'A' }));

    const sys = withAcl(bare, 'system', ['system']);
    await assert.rejects(() => sys.get('/doc'), code('FORBIDDEN'));
    await assert.rejects(() => sys.getChildren('/'), code('FORBIDDEN'));
    await assert.rejects(() => sys.set(createNode('/doc2', 'test.item', {})), code('FORBIDDEN'));
    await assert.rejects(() => sys.remove('/doc'), code('FORBIDDEN'));
    await assert.rejects(() => sys.patch('/doc', [['r', 'name', 'B']]), code('FORBIDDEN'));
  });

  it('claims matching no grant are denied; the granted identity passes', async () => {
    const granted = await grantedBootstrap();
    await granted.set(createNode('/doc', 'test.item', { name: 'A' }));

    const user = withAcl(granted, 'u1', ['authenticated', 'public']);
    await assert.rejects(() => user.get('/doc'), code('FORBIDDEN'));

    const sys = withAcl(granted, 'system', ['system']);
    assert.equal((await sys.get('/doc'))?.name, 'A');
  });
});

// ── core-ns6p.2: commit receipt — ONE coherent image, ZERO rereads ──
// The bd acceptance contract: the revision the cache serves, the wrap (audit)
// journals, and observers receive is the SAME adapter-committed image, with no
// post-write reads of the written node anywhere in the pipeline. Counts are
// pinned per TARGET path — ancestor reads (mount resolution, ACL inheritance)
// are config walks, orthogonal to the receipt and unchanged by it.

describe('invariant core-ns6p.2: commit receipt — one image, zero rereads', () => {
  /** Bootstrap that counts adapter reads per path. */
  async function countingBootstrap() {
    const mem = createMemoryTree();
    const reads = new Map<string, number>();
    const counted: Tree = {
      ...mem,
      get: (p, c) => { reads.set(p, (reads.get(p) ?? 0) + 1); return mem.get(p, c); },
    };
    const root = createNode('/', 'root', {});
    root.$acl = [{ g: 'system', p: R | W | A | S }];
    await counted.set(root);
    reads.clear();
    return { counted, reads };
  }

  it('set: one adapter read of the target (prepareForStore), cache/wrap/observer all see the committed $rev', async () => {
    const { counted, reads } = await countingBootstrap();
    const wrapRevs: (number | undefined)[] = [];
    const wrap = (t: Tree): Tree => ({
      ...t,
      async set(n, ctx) {
        const r = await t.set(n, ctx);
        wrapRevs.push(r.changes?.[0]?.after?.$rev);
        return r;
      },
    });
    const { tree } = createPipeline(counted, undefined, wrap);
    const w = pump(tree, { kind: 'path', path: '/biz/doc' });

    const receipt = await tree.set(createNode('/biz/doc', 'test.item', { v: 1 }));

    // Exactly ONE target read: policy base.set's prepareForStore existing-get.
    // The old pipeline added up to 4 more (subs before, cache re-get, subs
    // stored-get, audit before) — all deleted by the receipt.
    assert.equal(reads.get('/biz/doc'), 1, 'set = one pre-write read of the target, zero rereads');

    const committedRev = receipt.changes?.[0]?.after?.$rev;
    assert.ok(committedRev, 'receipt carries the committed rev');
    assert.equal(wrapRevs[0], committedRev, 'wrap (audit position) sees the same rev');

    const ev = await w.take();
    assert.equal(ev.type, 'set');
    assert.equal(ev.type === 'set' && (ev.node as { $rev?: number }).$rev, committedRev, 'observer event carries the committed rev');
    w.stop();

    // The cache serves the receipt image — no adapter read for it.
    reads.clear();
    assert.equal((await tree.get('/biz/doc'))?.$rev, committedRev);
    assert.equal(reads.get('/biz/doc'), undefined, 'post-write get is served from the receipt-populated cache');
  });

  it('patch: one target read, observer patch event carries the committed rev', async () => {
    const { counted, reads } = await countingBootstrap();
    const { tree } = createPipeline(counted);
    await tree.set(createNode('/biz/p', 'test.item', { v: 1 }));

    const w = pump(tree, { kind: 'path', path: '/biz/p' });
    reads.clear();
    const receipt = await tree.patch('/biz/p', [['r', 'v', 2]]);

    // withCache.patch = patchViaSet: the pre-image comes from the cache (hit),
    // so the only target read is again prepareForStore inside base.set.
    assert.equal(reads.get('/biz/p'), 1, 'patch = one pre-write read of the target, zero rereads');

    const committedRev = receipt.changes?.[0]?.after?.$rev;
    assert.ok(committedRev);
    const ev = await w.take();
    assert.equal(ev.type, 'patch');
    assert.equal(ev.type === 'patch' && ev.rev, committedRev, 'patch event rev == receipt rev');
    w.stop();

    reads.clear();
    assert.equal((await tree.get('/biz/p'))?.$rev, committedRev);
    assert.equal(reads.get('/biz/p'), undefined);
  });

  it('patchMany: one staging read per member, per-member events carry committed revs', async () => {
    const { counted, reads } = await countingBootstrap();
    const { tree } = createPipeline(counted);
    await tree.set(createNode('/biz/a', 'test.item', { v: 1 }));
    await tree.set(createNode('/biz/b', 'test.item', { v: 1 }));

    const w = pump(tree, { kind: 'children', path: '/biz' });
    reads.clear();
    const receipt = await tree.patchMany!('/biz', [
      { path: '/biz/a', ops: [['r', 'v', 2]] },
      { path: '/biz/b', ops: [['r', 'v', 2]] },
    ]);

    // policy patchMany stages each ops-member against a fresh backing read
    // (migration convergence) — one pre-write read per member, ZERO after.
    assert.equal(reads.get('/biz/a'), 1, 'one staging read for /biz/a, zero rereads');
    assert.equal(reads.get('/biz/b'), 1, 'one staging read for /biz/b, zero rereads');

    const revs = new Map(receipt.changes!.map(c => [c.path, c.after?.$rev]));
    for (let i = 0; i < 2; i++) {
      const ev = await w.take();
      assert.equal(ev.type, 'patch');
      if (ev.type === 'patch') {
        assert.equal(ev.rev, revs.get(ev.path), `event rev for ${ev.path} == receipt rev`);
      }
    }
    w.stop();

    reads.clear();
    assert.equal((await tree.get('/biz/a'))?.$rev, revs.get('/biz/a'));
    assert.equal(reads.get('/biz/a'), undefined, 'members were cache-populated from the receipt');
  });

  it('remove: receipt before-image feeds the caller — zero reads of the target', async () => {
    const { counted, reads } = await countingBootstrap();
    const { systemTree } = createPipeline(counted);
    // systemTree (policy.base): hard delete, no trash copy — isolates the
    // receipt path from the trash machinery's own legitimate reads.
    await systemTree.set(createNode('/biz/gone', 'test.item', { v: 1 }));

    reads.clear();
    const receipt = await systemTree.remove('/biz/gone');
    assert.equal(reads.get('/biz/gone'), undefined, 'remove = zero reads of the target (before-image from the receipt)');
    assert.equal(receipt.changes?.[0]?.before?.v, 1, 'receipt carries the removed image');
    assert.equal(receipt.changes?.[0]?.after, null);
  });
});
