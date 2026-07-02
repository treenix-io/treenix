// Pipeline invariants net (cut-series 2026-07, Wave 0 — core-gk8.14 part a).
// Every incident comment in createPipeline (server.ts) becomes an executable
// assert: layer ORDER is behavior, and these are the behaviors that broke when
// the order was wrong. core-tcc1 (late-bound ref rewiring) and core-5fqq
// (wrapper collapse) must keep this file green WITHOUT touching an assert —
// an assert change here means the cut changed behavior.
//
// Covered incidents: R-gk8.29 (migration above mounts), gk8.8 (trash below
// subscriptions; systemTree stays hard — entry shape itself is pinned in
// tree/trash.test.ts), core-dpp (wrapTree above subscriptions, boot writes
// below), volatile isolation, validation write-barrier atomicity, ACL
// fail-closed, external-watch wiring (inject + cache invalidation).

import { A, createNode, R, register, S, unregister, W, type NodeData } from '#core';
import { OpError } from '#errors';
import type { MountCtx } from '#mount';
import { withAcl } from '#security/auth';
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
// outlives code versions) MUST migrate on read, and reads write the migrated
// shape back so the corpus converges.

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

  it('old-shape node behind a mount is served migrated and written back', async () => {
    const backing = createMemoryTree();
    backings.set('versioned', backing);
    await backing.set(createNode('/data/x', 'inv.versioned', { old: 'v' }));

    const bootstrap = await grantedBootstrap();
    await bootstrap.set(createNode('/data', 'test.dir', {}, { mount: { $type: 'inv.mount.backing', key: 'versioned' } }));
    const { tree } = createPipeline(bootstrap);

    const got = await tree.get('/data/x');
    assert.ok(got);
    assert.equal(got.renamed, 'v');
    assert.equal(got.old, undefined);
    assert.equal(got.$v, 1);

    // Write-back converged the PERSISTENT store, not just the response.
    const stored = await backing.get('/data/x');
    assert.equal(stored?.renamed, 'v');
    assert.equal(stored?.old, undefined);
    assert.equal(stored?.$v, 1);
  });
});

// ── volatile: routed to memory, never the backing store ──

describe('invariant: volatile nodes never reach the backing store', () => {
  before(() => {
    register('inv.volatile', 'volatile', () => true);
  });

  after(() => {
    unregister('inv.volatile', 'volatile');
  });

  it('type-registered volatile node is readable but absent from bootstrap', async () => {
    const bootstrap = await grantedBootstrap();
    const { tree } = createPipeline(bootstrap);

    await tree.set(createNode('/vol/x', 'inv.volatile', { n: 1 }));

    assert.equal((await tree.get('/vol/x'))?.n, 1);
    assert.equal(await bootstrap.get('/vol/x'), undefined);

    const listed = await tree.getChildren('/vol');
    assert.deepEqual(listed.items.map(n => n.$path), ['/vol/x']);
    assert.equal((await bootstrap.getChildren('/vol')).total, 0);
  });

  it('instance-level $volatile flag routes the same way', async () => {
    const bootstrap = await grantedBootstrap();
    const { tree } = createPipeline(bootstrap);

    const n: NodeData = { $path: '/vol/y', $type: 'inv.plain', $volatile: true, n: 2 };
    await tree.set(n);

    assert.equal((await tree.get('/vol/y'))?.n, 2);
    assert.equal(await bootstrap.get('/vol/y'), undefined);
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
    assert.equal(await systemTree.remove('/biz/boot'), true);

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
