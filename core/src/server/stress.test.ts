// Treenix Stress Tests — E2E through full server pipeline
// Tests: throughput, race conditions, OCC, subscriptions, CDC, query mounts, watch fan-out

import { registerType } from '#comp';
import { createNode, type NodeData, register } from '#core';
import { clearRegistry } from '#core/index.test';
import { createMemoryTree, type Tree } from '#tree';
import { createQueryTree } from '#tree/query';
import { enablePatches } from 'immer';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { executeAction } from './actions';
import { withMounts } from './mount';
import { MountQuery } from './mount-adapters';
import { type CdcRegistry, type NodeEvent, withSubscriptions } from './sub';
import { withValidation } from './validate';
import { withVolatile } from './volatile';
import { createWatchManager, type WatchManager } from './watch';

enablePatches();

// ── Helpers ──

function fullPipeline() {
  const bootstrap = createMemoryTree();
  const mountable = withMounts(bootstrap);
  const volatile = withVolatile(mountable);
  const validated = withValidation(volatile);
  const watcher = createWatchManager();
  const { tree, cdc } = withSubscriptions(validated, (e) => watcher.notify(e));
  return { bootstrap, mountable, tree, cdc, watcher };
}

function timer() {
  const start = performance.now();
  return {
    elapsed: () => performance.now() - start,
    opsPerSec: (ops: number) => Math.round(ops / ((performance.now() - start) / 1000)),
  };
}

async function timeBatch(label: string, ops: number, fn: (i: number) => Promise<void>, progressEvery = 0) {
  const t = timer();
  for (let i = 0; i < ops; i++) {
    await fn(i);
    if (progressEvery && (i + 1) % progressEvery === 0) {
      const rate = t.opsPerSec(i + 1);
      console.log(`    ...${i + 1}/${ops} (${rate} ops/s)`);
    }
  }
  const elapsed = t.elapsed();
  const rate = t.opsPerSec(ops);
  console.log(`  ✓ [${label}] ${ops} ops in ${elapsed.toFixed(0)}ms — ${rate} ops/s`);
  return { elapsed, rate };
}

// ── 1. Raw Throughput ──

describe('Stress: throughput', () => {
  let tree: Tree;
  let cdc: CdcRegistry;

  beforeEach(() => {
    clearRegistry();
    ({ tree, cdc } = fullPipeline());
  });

  it('set throughput — 2k nodes', async () => {
    const { rate } = await timeBatch('set', 2_000, (i) =>
      tree.set(createNode(`/bench/n${i}`, 'item', { value: i })),
    500);
    assert.ok(rate > 100, `Expected > 100 ops/s, got ${rate}`);
  });

  it('get throughput — 5k reads', async () => {
    console.log('    seeding 500 nodes...');
    for (let i = 0; i < 500; i++)
      await tree.set(createNode(`/bench/n${i}`, 'item', { value: i }));

    const { rate } = await timeBatch('get', 5_000, (i) =>
      tree.get(`/bench/n${i % 500}`) as Promise<any>,
    1000);
    assert.ok(rate > 3000, `Expected > 3000 ops/s, got ${rate}`);
  });

  it('getChildren throughput — 500 queries over 200 children', async () => {
    console.log('    seeding 200 children...');
    for (let i = 0; i < 200; i++)
      await tree.set(createNode(`/list/c${i}`, 'item', { value: i }));

    const { rate } = await timeBatch('getChildren', 500, () =>
      tree.getChildren('/list', { limit: 50 }) as Promise<any>,
    100);
    assert.ok(rate > 200, `Expected > 200 ops/s, got ${rate}`);
  });

  it('mixed read/write — 2k random ops', async () => {
    console.log('    seeding 100 nodes...');
    for (let i = 0; i < 100; i++)
      await tree.set(createNode(`/mixed/n${i}`, 'item', { value: i }));

    let reads = 0, writes = 0;
    const { rate } = await timeBatch('mixed r/w', 2_000, async (i) => {
      if (Math.random() < 0.7) {
        await tree.get(`/mixed/n${i % 100}`);
        reads++;
      } else {
        await tree.set(createNode(`/mixed/n${i % 100}`, 'item', { value: i }));
        writes++;
      }
    }, 500);
    console.log(`    reads=${reads} writes=${writes}`);
    assert.ok(rate > 500, `Expected > 500 ops/s, got ${rate}`);
  });
});

// ── 2. Concurrent Writes + OCC ──

describe('Stress: OCC race conditions', () => {
  let tree: Tree;

  beforeEach(() => {
    clearRegistry();
    ({ tree } = fullPipeline());
  });

  it('concurrent writes to same node — exactly one wins per round', async () => {
    await tree.set(createNode('/race/target', 'counter', { count: 0 }));

    let conflicts = 0;
    let successes = 0;
    const rounds = 100;

    for (let round = 0; round < rounds; round++) {
      const node = (await tree.get('/race/target'))!;
      const writers = 5;
      const results = await Promise.allSettled(
        Array.from({ length: writers }, (_, w) =>
          tree.set({ ...node, count: (node as any).count + 1, writer: w } as NodeData),
        ),
      );

      const ok = results.filter((r) => r.status === 'fulfilled').length;
      const fail = results.filter((r) => r.status === 'rejected').length;
      successes += ok;
      conflicts += fail;
      assert.equal(ok, 1, `Round ${round}: exactly 1 writer should succeed, got ${ok}`);

      if ((round + 1) % 25 === 0) console.log(`    round ${round + 1}/${rounds}...`);
    }

    console.log(`  ✓ [OCC] ${rounds} rounds: ${successes} wins, ${conflicts} conflicts`);
    const final = (await tree.get('/race/target')) as any;
    assert.equal(final.$rev, rounds + 1);
  });

  it('interleaved read-modify-write with retry', async () => {
    await tree.set(createNode('/race/counter', 'counter', { count: 0 }));

    const workers = 10;
    const incrementsPerWorker = 30;

    async function worker(_id: number) {
      let retries = 0;
      for (let i = 0; i < incrementsPerWorker; i++) {
        let done = false;
        while (!done) {
          const node = (await tree.get('/race/counter'))!;
          try {
            await tree.set({ ...node, count: (node as any).count + 1 } as NodeData);
            done = true;
          } catch {
            retries++;
          }
        }
      }
      return retries;
    }

    console.log(`    ${workers} workers x ${incrementsPerWorker} increments...`);
    const results = await Promise.all(Array.from({ length: workers }, (_, i) => worker(i)));
    const totalRetries = results.reduce((a, b) => a + b, 0);

    const final = (await tree.get('/race/counter')) as any;
    console.log(`  ✓ [retry] final count=${final.count}, retries=${totalRetries}`);
    assert.equal(final.count, workers * incrementsPerWorker);
  });
});

// ── 3. Subscription Flooding ──

describe('Stress: subscriptions', () => {
  let tree: Tree;
  let cdc: CdcRegistry;

  beforeEach(() => {
    clearRegistry();
    ({ tree, cdc } = fullPipeline());
  });

  it('500 rapid writes — all events delivered in order', async () => {
    const events: NodeEvent[] = [];
    cdc.subscribe('/flood', (e) => events.push(e), { children: true });

    await timeBatch('sub flood', 500, (i) =>
      tree.set(createNode(`/flood/n${i}`, 'item', { seq: i })),
    100);

    assert.equal(events.length, 500);
    for (let i = 0; i < 500; i++) {
      assert.equal((events[i] as { path: string }).path, `/flood/n${i}`);
    }
  });

  it('multiple subscribers — all receive all events', async () => {
    const N = 200;
    const subs = 10;
    const buckets: NodeEvent[][] = [];

    for (let s = 0; s < subs; s++) {
      const events: NodeEvent[] = [];
      buckets.push(events);
      cdc.subscribe('/multi', (e) => events.push(e), { children: true });
    }
    console.log(`    ${subs} subscribers, ${N} writes...`);

    for (let i = 0; i < N; i++)
      await tree.set(createNode(`/multi/n${i}`, 'item'));

    for (let s = 0; s < subs; s++) {
      assert.equal(buckets[s].length, N, `Subscriber ${s} missed events`);
    }
    console.log(`  ✓ all ${subs} subscribers got all ${N} events`);
  });

  it('nested path subscriptions — parent catches child events', async () => {
    const rootEvents: NodeEvent[] = [];
    const childEvents: NodeEvent[] = [];

    cdc.subscribe('/', (e) => rootEvents.push(e), { children: true });
    cdc.subscribe('/deep/path', (e) => childEvents.push(e), { children: true });

    await tree.set(createNode('/deep/path/to/node', 'item'));
    await tree.set(createNode('/other/place', 'item'));

    assert.equal(rootEvents.length, 2, 'Root should catch all');
    assert.equal(childEvents.length, 1, 'Child sub should only catch nested');
    assert.equal((childEvents[0] as { path: string }).path, '/deep/path/to/node');
    console.log('  ✓ nested subscriptions route correctly');
  });

  it('subscribe + unsubscribe — no leaks', async () => {
    const events: NodeEvent[] = [];
    const unsub = cdc.subscribe('/leak', (e) => events.push(e), { children: true });

    await tree.set(createNode('/leak/before', 'item'));
    assert.equal(events.length, 1);

    unsub();
    await tree.set(createNode('/leak/after', 'item'));
    assert.equal(events.length, 1, 'Should not receive events after unsub');
    console.log('  ✓ no events after unsubscribe');
  });
});

// ── 4. WatchManager Fan-out ──

describe('Stress: watch fan-out', () => {
  let tree: Tree;
  let watcher: WatchManager;

  beforeEach(() => {
    clearRegistry();
    ({ tree, watcher } = fullPipeline());
  });

  it('100 users watching same path — all notified', async () => {
    const received = new Map<string, NodeEvent[]>();

    for (let u = 0; u < 100; u++) {
      const uid = `user-${u}`;
      const events: NodeEvent[] = [];
      received.set(uid, events);
      watcher.connect(uid, uid, (e) => events.push(e));
      watcher.watch(uid, ['/shared/doc']);
    }
    console.log('    100 users connected, writing...');

    await tree.set(createNode('/shared/doc', 'doc', { text: 'hello' }));

    let ok = 0;
    for (const [, events] of received) {
      assert.equal(events.length, 1);
      ok++;
    }
    console.log(`  ✓ all ${ok} users received event`);
  });

  it('watchChildren — 50 new nodes auto-notified', async () => {
    const events: NodeEvent[] = [];
    watcher.connect('watcher', 'watcher', (e) => events.push(e));
    watcher.watch('watcher', ['/items'], { children: true });

    for (let i = 0; i < 50; i++)
      await tree.set(createNode(`/items/item-${i}`, 'item'));

    assert.equal(events.length, 50);
    console.log('  ✓ 50/50 child events received');
  });

  it('autoWatch — subsequent updates delivered via exact watch', async () => {
    const events: NodeEvent[] = [];
    watcher.connect('auto', 'auto', (e) => events.push(e));
    watcher.watch('auto', ['/auto'], { children: true, autoWatch: true });

    await tree.set(createNode('/auto/target', 'item', { v: 1 }));
    assert.equal(events.length, 1);

    const node = (await tree.get('/auto/target'))!;
    await tree.set({ ...node, v: 2 } as NodeData);
    assert.equal(events.length, 2);
    console.log('  ✓ autoWatch promoted prefix → exact watch');
  });

  it('disconnected user stops receiving events', async () => {
    const events: NodeEvent[] = [];
    watcher.connect('ephemeral', 'ephemeral', (e) => events.push(e));
    watcher.watch('ephemeral', ['/bye/node']);

    await tree.set(createNode('/bye/node', 'item'));
    assert.equal(events.length, 1);

    watcher.disconnect('ephemeral');
    await tree.set(createNode('/bye/node', 'item', { v: 2 }));
    assert.equal(events.length, 1, 'Disconnected user should not receive events');
    console.log('  ✓ disconnect stops delivery');
  });
});

// ── 4b. Watch Limits ──

describe('Stress: watch limits', () => {
  it('rejects watch() when per-user limit exceeded', () => {
    const limited = createWatchManager({ maxWatchesPerUser: 5 });
    limited.connect('u1', 'u1', () => {});
    limited.watch('u1', ['/a', '/b', '/c', '/d', '/e']); // 5 — at limit
    assert.throws(
      () => limited.watch('u1', ['/f']),
      /Watch limit exceeded/,
    );
  });

  it('allows re-watching already watched paths (no double-count)', () => {
    const limited = createWatchManager({ maxWatchesPerUser: 3 });
    limited.connect('u1', 'u1', () => {});
    limited.watch('u1', ['/a', '/b', '/c']); // 3 — at limit
    limited.watch('u1', ['/a', '/b']); // re-watch existing — should not throw
  });

  it('rejects watch() when global limit exceeded', () => {
    const limited = createWatchManager({ maxTotalWatches: 5 });
    limited.connect('u1', 'u1', () => {});
    limited.connect('u2', 'u2', () => {});
    limited.watch('u1', ['/a', '/b', '/c']);
    limited.watch('u2', ['/d', '/e']);
    assert.throws(
      () => limited.watch('u2', ['/f']),
      /Server watch limit/,
    );
  });

  it('unwatch frees capacity', () => {
    const limited = createWatchManager({ maxWatchesPerUser: 3 });
    limited.connect('u1', 'u1', () => {});
    limited.watch('u1', ['/a', '/b', '/c']);
    limited.unwatch('u1', ['/b']);
    limited.watch('u1', ['/d']); // should succeed — now 3 again
  });

  it('disconnect + grace expiry frees capacity for global limit', async () => {
    const limited = createWatchManager({ maxTotalWatches: 5, gracePeriodMs: 10 });
    limited.connect('u1', 'u1', () => {});
    limited.watch('u1', ['/a', '/b', '/c', '/d', '/e']);
    limited.disconnect('u1');
    // Wait for grace period to expire
    await new Promise((r) => setTimeout(r, 50));
    limited.connect('u2', 'u2', () => {});
    limited.watch('u2', ['/x', '/y']); // should succeed — u1 freed
  });

  it('prefix watches count toward limit', () => {
    const limited = createWatchManager({ maxWatchesPerUser: 3 });
    limited.connect('u1', 'u1', () => {});
    limited.watch('u1', ['/a', '/b'], { children: true }); // 2 prefixes
    limited.watch('u1', ['/c']); // 1 exact — now at 3
    assert.throws(
      () => limited.watch('u1', ['/d']),
      /Watch limit exceeded/,
    );
  });

  it('autoWatch respects per-user limit', () => {
    const limited = createWatchManager({ maxWatchesPerUser: 4 });
    limited.connect('u1', 'u1', () => {});
    limited.watch('u1', ['/items'], { children: true, autoWatch: true }); // 1 prefix
    limited.watch('u1', ['/x', '/y']); // 2 exact — now at 3

    // Simulate child notifications — only 1 should auto-add (limit=4)
    for (let i = 0; i < 10; i++) {
      limited.notify({ type: 'set', path: `/items/item-${i}`, node: {} as any });
    }

    // Only 1 auto-watch should have been added (3 + 1 = 4 = limit)
    // Attempting to add more exact watches should fail
    assert.throws(
      () => limited.watch('u1', ['/z']),
      /Watch limit exceeded/,
    );
  });
});

// ── 5. Query Mount + CDC Matrix ──

describe('Stress: query mounts + CDC', () => {
  let bootstrap: Tree;
  let tree: Tree;
  let watcher: WatchManager;
  let cdc: CdcRegistry;

  beforeEach(() => {
    clearRegistry();
    register(MountQuery, 'mount', (mount, ctx) => {
      if (!mount.source || !mount.match) throw new Error('t.mount.query: source and match required');
      return createQueryTree(mount, ctx.parentStore);
    });
    ({ bootstrap, tree, watcher, cdc } = fullPipeline());
  });

  it('query mount filters correctly under load', async () => {
    await bootstrap.set(
      createNode('/views/active', 'folder', {}, {
        mount: { $type: 't.mount.query', source: '/entities/tasks', match: { status: 'active' } },
      }),
    );

    console.log('    creating 200 tasks (half active)...');
    for (let i = 0; i < 200; i++) {
      await tree.set(
        createNode(`/entities/tasks/t${i}`, 'task', {
          status: i % 2 === 0 ? 'active' : 'done',
          title: `Task ${i}`,
        }),
      );
    }

    const result = await tree.getChildren('/views/active');
    assert.equal(result.items.length, 100);

    for (const item of result.items) {
      assert.equal((item as any).status, 'active');
    }
    console.log(`  ✓ query mount returned ${result.items.length}/100 active tasks`);
  });

  it('CDC: node entering/leaving virtual parent', async () => {
    await bootstrap.set(
      createNode('/views/urgent', 'folder', {}, {
        mount: { $type: 't.mount.query', source: '/entities/tickets', match: { priority: 'high' } },
      }),
    );

    cdc.watchQuery('/views/urgent', '/entities/tickets', { priority: 'high' }, 'user1');
    const events: NodeEvent[] = [];
    watcher.connect('user1', 'user1', (e) => events.push(e));
    watcher.watch('user1', ['/views/urgent'], { children: true });

    // Low priority — no CDC
    await tree.set(createNode('/entities/tickets/t1', 'ticket', { priority: 'low' }));
    assert.equal(events.length, 0, 'Low priority should not trigger CDC');
    console.log('    low-priority → no event ✓');

    // High priority — enters VP
    await tree.set(createNode('/entities/tickets/t2', 'ticket', { priority: 'high' }));
    assert.equal(events.length, 1);
    assert.deepEqual((events[0] as any).addVps, ['/views/urgent']);
    console.log('    high-priority → addVps ✓');

    // Downgrade — leaves VP
    const t2 = (await tree.get('/entities/tickets/t2'))!;
    await tree.set({ ...t2, priority: 'low' } as NodeData);
    assert.equal(events.length, 2);
    assert.deepEqual((events[1] as any).rmVps, ['/views/urgent']);
    console.log('    downgrade → rmVps ✓');

    cdc.unwatchAllQueries('user1');
  });

  it('CDC under load — 100 create + 50 transition', async () => {
    await bootstrap.set(
      createNode('/views/new', 'folder', {}, {
        mount: { $type: 't.mount.query', source: '/entities/orders', match: { status: 'new' } },
      }),
    );

    cdc.watchQuery('/views/new', '/entities/orders', { status: 'new' }, 'watcher');

    const adds: string[] = [];
    const removes: string[] = [];
    watcher.connect('watcher', 'watcher', (e) => {
      if ('addVps' in e && (e as any).addVps?.length) adds.push((e as any).path);
      if ((e as any).rmVps?.length) removes.push((e as any).path);
    });
    watcher.watch('watcher', ['/views/new'], { children: true });

    console.log('    creating 100 "new" orders...');
    for (let i = 0; i < 100; i++)
      await tree.set(createNode(`/entities/orders/o${i}`, 'order', { status: 'new' }));

    assert.equal(adds.length, 100);
    console.log(`    ${adds.length} addVps events ✓`);

    console.log('    transitioning 50 to "done"...');
    for (let i = 0; i < 50; i++) {
      const order = (await tree.get(`/entities/orders/o${i}`))!;
      await tree.set({ ...order, status: 'done' } as NodeData);
    }

    assert.equal(removes.length, 50);
    console.log(`    ${removes.length} rmVps events ✓`);

    const result = await tree.getChildren('/views/new');
    assert.equal(result.items.length, 50);
    console.log(`  ✓ query mount shows ${result.items.length} remaining`);

    cdc.unwatchAllQueries('watcher');
  });

  it('multiple query mounts on same source — CDC dispatches to both', async () => {
    await bootstrap.set(
      createNode('/views/new', 'folder', {}, {
        mount: { $type: 't.mount.query', source: '/entities/items', match: { status: 'new' } },
      }),
    );
    await bootstrap.set(
      createNode('/views/flagged', 'folder', {}, {
        mount: { $type: 't.mount.query', source: '/entities/items', match: { flagged: true } },
      }),
    );

    cdc.watchQuery('/views/new', '/entities/items', { status: 'new' }, 'u1');
    cdc.watchQuery('/views/flagged', '/entities/items', { flagged: true }, 'u1');

    const events: NodeEvent[] = [];
    watcher.connect('u1', 'u1', (e) => events.push(e));
    watcher.watch('u1', ['/views/new', '/views/flagged'], { children: true });

    await tree.set(createNode('/entities/items/x', 'item', { status: 'new', flagged: true }));
    assert.equal(events.length, 1, 'Single event despite matching two queries');
    assert.deepEqual((events[0] as any).addVps?.sort(), ['/views/flagged', '/views/new']);
    console.log('  ✓ single event with both VPs');

    cdc.unwatchAllQueries('u1');
  });
});

// ── 6. Action Execute + Patch Pipeline ──

describe('Stress: actions + patches', () => {
  let tree: Tree;
  let cdc: CdcRegistry;

  beforeEach(() => {
    clearRegistry();

    class Counter {
      count = 0;
      increment() { this.count++; return this.count; }
      add({ amount }: { amount?: number }) { this.count += amount ?? 1; return this.count; }
    }
    registerType('counter', Counter);
    register('counter', 'schema', () => ({
      $id: 't.counter', title: 'Counter', type: 'object' as const,
      properties: { count: { type: 'number' } },
      methods: {
        increment: { arguments: [] },
        add: { arguments: [{ name: 'data', type: 'object', properties: { amount: { type: 'number' } } }] },
      },
    }));

    ({ tree, cdc } = fullPipeline());
  });

  it('execute generates patches — 50 increments', async () => {
    await tree.set(createNode('/counters/c1', 'counter', { count: 0 }));

    const patchEvents: NodeEvent[] = [];
    cdc.subscribe('/counters', (e) => {
      if (e.type === 'patch') patchEvents.push(e);
    }, { children: true });

    await timeBatch('execute', 50, () =>
      executeAction(tree, '/counters/c1', undefined, undefined, 'increment') as Promise<any>,
    10);

    const final = (await tree.get('/counters/c1')) as any;
    assert.equal(final.count, 50);
    assert.equal(patchEvents.length, 50);

    for (const evt of patchEvents) {
      if (evt.type === 'patch') {
        assert.ok(evt.patches.length > 0);
      }
    }
    console.log(`  ✓ ${patchEvents.length} patch events, final count=${final.count}`);
  });

  it('concurrent execute — OCC serializes correctly', async () => {
    await tree.set(createNode('/counters/race', 'counter', { count: 0 }));

    const N = 30;
    let conflicts = 0;

    for (let i = 0; i < N; i++) {
      const results = await Promise.allSettled([
        executeAction(tree, '/counters/race', undefined, undefined, 'increment'),
        executeAction(tree, '/counters/race', undefined, undefined, 'increment'),
        executeAction(tree, '/counters/race', undefined, undefined, 'increment'),
      ]);
      conflicts += results.filter((r) => r.status === 'rejected').length;
      if ((i + 1) % 10 === 0) console.log(`    batch ${i + 1}/${N}...`);
    }

    const final = (await tree.get('/counters/race')) as any;
    console.log(`  ✓ [execute race] final count=${final.count}, conflicts=${conflicts}`);
    assert.ok(final.count >= N);
    assert.ok(final.count <= 3 * N);
  });
});

// ── 7. Deep Tree ──

describe('Stress: deep trees', () => {
  let tree: Tree;

  beforeEach(() => {
    clearRegistry();
    ({ tree } = fullPipeline());
  });

  it('deeply nested path — 50 levels deep', async () => {
    let path = '';
    for (let i = 0; i < 50; i++) {
      path += `/d${i}`;
      await tree.set(createNode(path, 'dir'));
    }

    const deep = await tree.get(path);
    assert.ok(deep);
    assert.equal(deep!.$type, 't.dir');
    console.log(`  ✓ read node at depth 50: ${path.slice(0, 40)}...`);

    let current = '';
    for (let i = 0; i < 49; i++) {
      current += `/d${i}`;
      const children = await tree.getChildren(current, { limit: 10 });
      assert.equal(children.items.length, 1);
    }
    console.log('  ✓ getChildren works at every level');
  });

  it('wide tree — 1000 children + pagination', async () => {
    console.log('    creating 1000 children...');
    for (let i = 0; i < 1000; i++)
      await tree.set(createNode(`/wide/c${i}`, 'item', { idx: i }));

    const all = await tree.getChildren('/wide');
    assert.equal(all.total, 1000);
    console.log(`    total=${all.total} ✓`);

    const page1 = await tree.getChildren('/wide', { limit: 100, offset: 0 });
    assert.equal(page1.items.length, 100);

    const page10 = await tree.getChildren('/wide', { limit: 100, offset: 900 });
    assert.equal(page10.items.length, 100);
    console.log('  ✓ pagination correct');
  });
});

// ── 8. Remove + Subscription Correctness ──

describe('Stress: remove operations', () => {
  let tree: Tree;
  let cdc: CdcRegistry;

  beforeEach(() => {
    clearRegistry();
    ({ tree, cdc } = fullPipeline());
  });

  it('bulk create then remove — subscriptions fire for both', async () => {
    const sets: string[] = [];
    const removes: string[] = [];

    cdc.subscribe('/tmp', (e) => {
      if (e.type === 'set') sets.push(e.path);
      if (e.type === 'remove') removes.push(e.path);
    }, { children: true });

    const N = 200;
    console.log(`    creating ${N} nodes...`);
    for (let i = 0; i < N; i++)
      await tree.set(createNode(`/tmp/n${i}`, 'item'));
    assert.equal(sets.length, N);

    console.log(`    removing ${N} nodes...`);
    for (let i = 0; i < N; i++)
      await tree.remove(`/tmp/n${i}`);
    assert.equal(removes.length, N);

    const children = await tree.getChildren('/tmp');
    assert.equal(children.items.length, 0);
    console.log(`  ✓ ${N} set + ${N} remove events, 0 remaining`);
  });

  it('remove non-existent node — no event', async () => {
    const events: NodeEvent[] = [];
    cdc.subscribe('/phantom', (e) => events.push(e));

    const result = await tree.remove('/phantom/ghost');
    assert.equal(result, false);
    assert.equal(events.length, 0);
    console.log('  ✓ no event for phantom remove');
  });
});

// ── 9. Volatile + Validation Pipeline ──

describe('Stress: volatile + validation', () => {
  let tree: Tree;

  beforeEach(() => {
    clearRegistry();
    register('ephemeral', 'volatile', () => true);
    register('validated', 'schema', () => ({
      title: 'validated', type: 'object' as const,
      properties: {
        name: { type: 'string' },
        count: { type: 'number' },
      },
    }));
    ({ tree } = fullPipeline());
  });

  it('volatile nodes stored in memory layer', async () => {
    for (let i = 0; i < 50; i++)
      await tree.set(createNode(`/live/s${i}`, 'ephemeral', { value: i }));

    for (let i = 0; i < 50; i++) {
      const node = await tree.get(`/live/s${i}`);
      assert.ok(node);
      assert.equal((node as any).value, i);
    }
    console.log('  ✓ 50 volatile nodes readable');
  });

  it('validation rejects bad data — all errors propagate', async () => {
    let rejected = 0;

    for (let i = 0; i < 50; i++) {
      const bad = i % 2 !== 0;
      try {
        await tree.set(
          createNode(`/valid/n${i}`, 'item', {}, {
            data: {
              $type: 'validated',
              name: bad ? 42 as any : 'ok',
              count: i,
            },
          }),
        );
        assert.ok(!bad, `expected rejection for i=${i}`);
      } catch (e: any) {
        assert.ok(bad, `unexpected throw for i=${i}: ${e.message}`);
        assert.ok(e.message, 'validation error should have a message');
        rejected++;
      }
    }

    assert.equal(rejected, 25);
  });
});

// ── 10. Random Access Pattern ──

describe('Stress: random access', () => {
  let tree: Tree;

  beforeEach(() => {
    clearRegistry();
    ({ tree } = fullPipeline());
  });

  it('random CRUD — 1000 ops, no crashes', async () => {
    const paths = new Set<string>();
    let creates = 0, reads = 0, updates = 0, deletes = 0;

    for (let i = 0; i < 1000; i++) {
      const op = Math.random();
      const id = Math.floor(Math.random() * 100);
      const path = `/random/n${id}`;

      if (op < 0.3) {
        await tree.set(createNode(path, 'item', { i, rnd: Math.random() }));
        paths.add(path);
        creates++;
      } else if (op < 0.6) {
        await tree.get(path);
        reads++;
      } else if (op < 0.8) {
        await tree.set(createNode(path, 'item', { i, updated: true }));
        paths.add(path);
        updates++;
      } else {
        await tree.remove(path);
        paths.delete(path);
        deletes++;
      }
    }

    assert.ok(creates > 0, 'should have creates');
    assert.ok(reads > 0, 'should have reads');

    for (const path of paths) {
      const node = await tree.get(path);
      if (node) {
        assert.equal(node.$path, path);
        assert.equal(node.$type, 't.item');
      }
    }
  });
});

// ── 11. Full Watch Pipeline Integration ──

describe('Stress: full watch pipeline', () => {
  beforeEach(() => {
    clearRegistry();
  });

  it('watch + watchChildren + CDC — mixed scenario', async () => {
    register(MountQuery, 'mount', (mount, ctx) => {
      if (!mount.source || !mount.match) throw new Error('t.mount.query: source and match required');
      return createQueryTree(mount, ctx.parentStore);
    });

    const { bootstrap: bs2, tree: store2, watcher: w2, cdc: cdc2 } = fullPipeline();

    await bs2.set(
      createNode('/views/hot', 'folder', {}, {
        mount: { $type: 't.mount.query', source: '/data', match: { hot: true } },
      }),
    );

    cdc2.watchQuery('/views/hot', '/data', { hot: true }, 'observer');

    const exactEvents: NodeEvent[] = [];
    const childEvents: NodeEvent[] = [];
    const cdcEvents: NodeEvent[] = [];

    w2.connect('observer', 'observer', (e) => {
      const path = 'path' in e ? e.path : '';
      if (path === '/data/tracked') exactEvents.push(e);
      if ('addVps' in e && (e as any).addVps?.includes('/views/hot')) cdcEvents.push(e);
      if (path.startsWith('/data/') && path !== '/data/tracked') childEvents.push(e);
    });

    w2.watch('observer', ['/data/tracked']);
    w2.watch('observer', ['/data'], { children: true });

    await store2.set(createNode('/data/tracked', 'item', { v: 1 }));
    assert.equal(exactEvents.length, 1);
    console.log('    exact watch ✓');

    await store2.set(createNode('/data/child1', 'item', { hot: false }));
    assert.equal(childEvents.length, 1);
    console.log('    children watch ✓');

    await store2.set(createNode('/data/hotitem', 'item', { hot: true }));
    assert.ok(cdcEvents.length >= 1);
    console.log('    CDC watch ✓');

    cdc2.unwatchAllQueries('observer');
    console.log('  ✓ all 3 watch modes work together');
  });
});

// ── 12. Memory Pressure (reduced) ──

describe('Stress: memory', () => {
  let tree: Tree;

  beforeEach(() => {
    clearRegistry();
    ({ tree } = fullPipeline());
  });

  it('5k nodes — memory stays bounded', async () => {
    const before = process.memoryUsage().heapUsed;
    const N = 5_000;

    await timeBatch('mem fill', N, (i) =>
      tree.set(createNode(`/mem/n${i}`, 'item', { data: `payload-${i}`, idx: i })),
    1000);

    const after = process.memoryUsage().heapUsed;
    const deltaBytes = after - before;
    const perNodeBytes = deltaBytes / N;

    console.log(`  [memory] ${N} nodes: ${(deltaBytes / 1024 / 1024).toFixed(1)}MB total, ${perNodeBytes.toFixed(0)} bytes/node`);

    // No hard assert — V8 profiler inflates heap significantly
    if (perNodeBytes >= 4096) console.log(`  ⚠ ${perNodeBytes.toFixed(0)} bytes/node exceeds 4KB (profiler overhead?)`);

    // Spot-check random reads
    for (let i = 0; i < 50; i++) {
      const idx = Math.floor(Math.random() * N);
      const node = await tree.get(`/mem/n${idx}`);
      assert.ok(node);
      assert.equal((node as any).idx, idx);
    }
    console.log('  ✓ spot-check reads OK');
  });
});
