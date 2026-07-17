import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type NodeEvent } from './index';
import { createWatchManager, type StampedEvent, type WatchCursor } from './watch';

/** Build the resume cursor a client would hold after processing `e`. */
function cursorOf(e: StampedEvent): WatchCursor {
  assert.ok(typeof e.seq === 'number', 'delivered event must be seq-stamped');
  assert.ok(typeof e.epoch === 'string', 'delivered event must carry the stream epoch');
  return { seq: e.seq, epoch: e.epoch };
}

describe('WatchManager', () => {
  it('owns query registration, unwatch, and user cleanup', async () => {
    const watched: unknown[] = [];
    const unwatched: unknown[] = [];
    const removed: string[] = [];
    const wm = createWatchManager({ gracePeriodMs: 5 });
    wm.bindQueryRegistry({
      watchQuery: (reg) => watched.push(reg),
      unwatchQuery: (vp, userId) => unwatched.push({ vp, userId }),
      unwatchAllQueries: (userId) => removed.push(userId),
    });
    wm.connect('c1', 'u1', () => {});
    const query = { plan: { source: '/data', callerWhere: { open: true } }, mountDeps: new Set(['/view']) };

    wm.watch('u1', ['/view'], { children: true, query });
    assert.deepEqual(watched, [{ vp: '/view', userId: 'u1', ...query }]);

    wm.unwatch('u1', ['/view'], { children: true });
    assert.deepEqual(unwatched, [{ vp: '/view', userId: 'u1' }]);

    wm.watch('u1', ['/view'], { children: true, query });
    wm.disconnect('c1');
    await new Promise(resolve => setTimeout(resolve, 15));
    assert.deepEqual(removed, ['u1']);
  });

  it('notify delivers to watching user', () => {
    const wm = createWatchManager();
    const events: NodeEvent[] = [];
    wm.connect('c1', 'u1', (e) => events.push(e));
    wm.watch('u1', ['/a']);
    wm.notify({ type: 'set', path: '/a', node: { $path: '/a', $type: 't' } });
    assert.equal(events.length, 1);
    assert.equal((events[0] as { path: string }).path, '/a');
  });

  it('does not deliver to non-watching user', () => {
    const wm = createWatchManager();
    const events: NodeEvent[] = [];
    wm.connect('c1', 'u1', (e) => events.push(e));
    wm.watch('u1', ['/a']);
    wm.notify({ type: 'set', path: '/b', node: { $path: '/b', $type: 't' } });
    assert.equal(events.length, 0);
  });

  it('unwatch stops delivery', () => {
    const wm = createWatchManager();
    const events: NodeEvent[] = [];
    wm.connect('c1', 'u1', (e) => events.push(e));
    wm.watch('u1', ['/a']);
    wm.unwatch('u1', ['/a']);
    wm.notify({ type: 'set', path: '/a', node: { $path: '/a', $type: 't' } });
    assert.equal(events.length, 0);
  });

  it('disconnect removes all watches when last connection closes', () => {
    const wm = createWatchManager();
    const events: NodeEvent[] = [];
    wm.connect('c1', 'u1', (e) => events.push(e));
    wm.watch('u1', ['/a', '/b', '/c']);
    wm.disconnect('c1');
    wm.notify({ type: 'set', path: '/a', node: { $path: '/a', $type: 't' } });
    assert.equal(events.length, 0);
    assert.equal(wm.clientCount(), 0);
  });

  it('multiple users on same path', () => {
    const wm = createWatchManager();
    const e1: NodeEvent[] = [],
      e2: NodeEvent[] = [];
    wm.connect('c1', 'u1', (e) => e1.push(e));
    wm.connect('c2', 'u2', (e) => e2.push(e));
    wm.watch('u1', ['/a']);
    wm.watch('u2', ['/a']);
    wm.notify({ type: 'set', path: '/a', node: { $path: '/a', $type: 't' } });
    assert.equal(e1.length, 1);
    assert.equal(e2.length, 1);
  });

  it('notify on unwatched path is noop', () => {
    const wm = createWatchManager();
    wm.notify({ type: 'remove', path: '/nowhere' });
  });

  it('reconnect (same connId) preserves watched paths', () => {
    const wm = createWatchManager();
    const e1: NodeEvent[] = [],
      e2: NodeEvent[] = [];
    wm.connect('c1', 'u1', (e) => e1.push(e));
    wm.watch('u1', ['/a']);
    wm.connect('c1', 'u1', (e) => e2.push(e));
    wm.notify({ type: 'set', path: '/a', node: { $path: '/a', $type: 't' } });
    assert.equal(e1.length, 0);
    assert.equal(e2.length, 1);
  });

  it('remove event delivered', () => {
    const wm = createWatchManager();
    const events: NodeEvent[] = [];
    wm.connect('c1', 'u1', (e) => events.push(e));
    wm.watch('u1', ['/a']);
    wm.notify({ type: 'remove', path: '/a' });
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'remove');
  });

  it('multi-tab: both tabs receive events', () => {
    const wm = createWatchManager();
    const tab1: NodeEvent[] = [], tab2: NodeEvent[] = [];
    wm.connect('c1', 'u1', (e) => tab1.push(e));
    wm.connect('c2', 'u1', (e) => tab2.push(e));
    wm.watch('u1', ['/a']);
    wm.notify({ type: 'set', path: '/a', node: { $path: '/a', $type: 't' } });
    assert.equal(tab1.length, 1);
    assert.equal(tab2.length, 1);
  });

  it('multi-tab: closing one tab keeps other alive', () => {
    const wm = createWatchManager();
    const tab1: NodeEvent[] = [], tab2: NodeEvent[] = [];
    wm.connect('c1', 'u1', (e) => tab1.push(e));
    wm.connect('c2', 'u1', (e) => tab2.push(e));
    wm.watch('u1', ['/a']);
    wm.disconnect('c1');
    wm.notify({ type: 'set', path: '/a', node: { $path: '/a', $type: 't' } });
    assert.equal(tab1.length, 0); // disconnected
    assert.equal(tab2.length, 1); // still alive
    assert.equal(wm.clientCount(), 1);
  });

  it('multi-tab: closing all tabs cleans up watches', () => {
    const wm = createWatchManager();
    wm.connect('c1', 'u1', () => {});
    wm.connect('c2', 'u1', () => {});
    wm.watch('u1', ['/a']);
    wm.watch('u1', ['/b'], { children: true });
    wm.disconnect('c1');
    wm.disconnect('c2');
    assert.equal(wm.clientCount(), 0);
    // No crash on notify after full cleanup
    wm.notify({ type: 'set', path: '/a', node: { $path: '/a', $type: 't' } });
  });
});

describe('WatchManager — children watch', () => {
  it('delivers on direct child', () => {
    const wm = createWatchManager();
    const events: NodeEvent[] = [];
    wm.connect('c1', 'u1', (e) => events.push(e));
    wm.watch('u1', ['/sensors'], { children: true });
    wm.notify({
      type: 'set',
      path: '/sensors/temp1',
      node: { $path: '/sensors/temp1', $type: 'sensor' },
    });
    assert.equal(events.length, 1);
    assert.equal((events[0] as { path: string }).path, '/sensors/temp1');
  });

  it('does NOT deliver on nested descendant (direct only)', () => {
    const wm = createWatchManager();
    const events: NodeEvent[] = [];
    wm.connect('c1', 'u1', (e) => events.push(e));
    wm.watch('u1', ['/a'], { children: true });
    wm.notify({ type: 'set', path: '/a/b/c', node: { $path: '/a/b/c', $type: 't' } });
    assert.equal(events.length, 0);
  });

  it('does NOT deliver on parent itself', () => {
    const wm = createWatchManager();
    const events: NodeEvent[] = [];
    wm.connect('c1', 'u1', (e) => events.push(e));
    wm.watch('u1', ['/sensors'], { children: true });
    wm.notify({ type: 'set', path: '/sensors', node: { $path: '/sensors', $type: 'dir' } });
    assert.equal(events.length, 0);
  });

  it('does NOT deliver on sibling path', () => {
    const wm = createWatchManager();
    const events: NodeEvent[] = [];
    wm.connect('c1', 'u1', (e) => events.push(e));
    wm.watch('u1', ['/sensors'], { children: true });
    wm.notify({ type: 'set', path: '/other/temp1', node: { $path: '/other/temp1', $type: 't' } });
    assert.equal(events.length, 0);
  });

  it('unwatch with children stops delivery', () => {
    const wm = createWatchManager();
    const events: NodeEvent[] = [];
    wm.connect('c1', 'u1', (e) => events.push(e));
    wm.watch('u1', ['/sensors'], { children: true });
    wm.unwatch('u1', ['/sensors'], { children: true });
    wm.notify({
      type: 'set',
      path: '/sensors/temp1',
      node: { $path: '/sensors/temp1', $type: 'sensor' },
    });
    assert.equal(events.length, 0);
  });

  it('disconnect cleans up prefix watches', () => {
    const wm = createWatchManager();
    const events: NodeEvent[] = [];
    wm.connect('c1', 'u1', (e) => events.push(e));
    wm.watch('u1', ['/sensors'], { children: true });
    wm.disconnect('c1');
    wm.notify({
      type: 'set',
      path: '/sensors/temp1',
      node: { $path: '/sensors/temp1', $type: 'sensor' },
    });
    assert.equal(events.length, 0);
  });

  it('exact + children: no duplicate delivery', () => {
    const wm = createWatchManager();
    const events: NodeEvent[] = [];
    wm.connect('c1', 'u1', (e) => events.push(e));
    wm.watch('u1', ['/sensors/temp1']);
    wm.watch('u1', ['/sensors'], { children: true });
    wm.notify({
      type: 'set',
      path: '/sensors/temp1',
      node: { $path: '/sensors/temp1', $type: 'sensor' },
    });
    assert.equal(events.length, 1);
  });

  it('children watch on root delivers for top-level paths', () => {
    const wm = createWatchManager();
    const events: NodeEvent[] = [];
    wm.connect('c1', 'u1', (e) => events.push(e));
    wm.watch('u1', ['/'], { children: true });
    wm.notify({ type: 'set', path: '/sensors', node: { $path: '/sensors', $type: 't' } });
    assert.equal(events.length, 1);
  });

  it('children watch on root does NOT deliver for nested paths', () => {
    const wm = createWatchManager();
    const events: NodeEvent[] = [];
    wm.connect('c1', 'u1', (e) => events.push(e));
    wm.watch('u1', ['/'], { children: true });
    wm.notify({ type: 'set', path: '/a/b', node: { $path: '/a/b', $type: 't' } });
    wm.notify({ type: 'set', path: '/a/b/c', node: { $path: '/a/b/c', $type: 't' } });
    assert.equal(events.length, 0);
  });

  it('autoWatch child does NOT leak into grandchildren', () => {
    const wm = createWatchManager();
    const events: NodeEvent[] = [];
    wm.connect('c1', 'u1', (e) => events.push(e));
    wm.watch('u1', ['/a'], { children: true, autoWatch: true });
    // /a/b arrives → auto-subscribed to exact /a/b
    wm.notify({ type: 'set', path: '/a/b', node: { $path: '/a/b', $type: 't' } });
    assert.equal(events.length, 1);
    // /a/b/c should NOT arrive (no prefix watch on /a/b, only exact on /a/b)
    wm.notify({ type: 'set', path: '/a/b/c', node: { $path: '/a/b/c', $type: 't' } });
    assert.equal(events.length, 1);
    // but /a/b update still arrives via exact
    wm.notify({ type: 'set', path: '/a/b', node: { $path: '/a/b', $type: 't' } });
    assert.equal(events.length, 2);
  });

  it('reconnect preserves prefix watches', () => {
    const wm = createWatchManager();
    const e1: NodeEvent[] = [],
      e2: NodeEvent[] = [];
    wm.connect('c1', 'u1', (e) => e1.push(e));
    wm.watch('u1', ['/sensors'], { children: true });
    wm.connect('c1', 'u1', (e) => e2.push(e));
    wm.notify({
      type: 'set',
      path: '/sensors/temp1',
      node: { $path: '/sensors/temp1', $type: 'sensor' },
    });
    assert.equal(e1.length, 0);
    assert.equal(e2.length, 1);
  });
});

describe('WatchManager — autoWatch', () => {
  it('autoWatch=true: new child gets exact watch, subsequent updates delivered', () => {
    const wm = createWatchManager();
    const events: NodeEvent[] = [];
    wm.connect('c1', 'u1', (e) => events.push(e));
    wm.watch('u1', ['/sensors'], { children: true, autoWatch: true });
    // New child arrives
    wm.notify({
      type: 'set',
      path: '/sensors/temp1',
      node: { $path: '/sensors/temp1', $type: 'sensor' },
    });
    assert.equal(events.length, 1);
    // Now update the same child — should arrive via exact watch
    wm.notify({
      type: 'set',
      path: '/sensors/temp1',
      node: { $path: '/sensors/temp1', $type: 'sensor' },
    });
    assert.equal(events.length, 2);
  });

  it('autoWatch=false: new child NOT auto-subscribed, update not delivered', () => {
    const wm = createWatchManager();
    const events: NodeEvent[] = [];
    wm.connect('c1', 'u1', (e) => events.push(e));
    wm.watch('u1', ['/sensors'], { children: true });
    wm.notify({
      type: 'set',
      path: '/sensors/temp1',
      node: { $path: '/sensors/temp1', $type: 'sensor' },
    });
    assert.equal(events.length, 1);
    // unwatch children — now only exact would deliver, but there's none
    wm.unwatch('u1', ['/sensors'], { children: true });
    wm.notify({
      type: 'set',
      path: '/sensors/temp1',
      node: { $path: '/sensors/temp1', $type: 'sensor' },
    });
    assert.equal(events.length, 1); // no delivery
  });

  it('autoWatch default is false', () => {
    const wm = createWatchManager();
    const events: NodeEvent[] = [];
    wm.connect('c1', 'u1', (e) => events.push(e));
    wm.watch('u1', ['/sensors'], { children: true });
    wm.notify({
      type: 'set',
      path: '/sensors/temp1',
      node: { $path: '/sensors/temp1', $type: 'sensor' },
    });
    wm.unwatch('u1', ['/sensors'], { children: true });
    wm.notify({
      type: 'set',
      path: '/sensors/temp1',
      node: { $path: '/sensors/temp1', $type: 'sensor' },
    });
    assert.equal(events.length, 1);
  });

  it('autoWatch: multiple new children each get subscribed', () => {
    const wm = createWatchManager();
    const events: NodeEvent[] = [];
    wm.connect('c1', 'u1', (e) => events.push(e));
    wm.watch('u1', ['/sensors'], { children: true, autoWatch: true });
    wm.notify({ type: 'set', path: '/sensors/a', node: { $path: '/sensors/a', $type: 's' } });
    wm.notify({ type: 'set', path: '/sensors/b', node: { $path: '/sensors/b', $type: 's' } });
    wm.notify({ type: 'set', path: '/sensors/c', node: { $path: '/sensors/c', $type: 's' } });
    assert.equal(events.length, 3);
    // Now unwatch children — updates still arrive via exact watch
    wm.unwatch('u1', ['/sensors'], { children: true });
    wm.notify({ type: 'set', path: '/sensors/a', node: { $path: '/sensors/a', $type: 's' } });
    wm.notify({ type: 'set', path: '/sensors/b', node: { $path: '/sensors/b', $type: 's' } });
    assert.equal(events.length, 5);
    // But brand new child does NOT arrive (no more prefix watch)
    wm.notify({ type: 'set', path: '/sensors/d', node: { $path: '/sensors/d', $type: 's' } });
    assert.equal(events.length, 5);
  });

  it('autoWatch: remove event also delivered after auto-subscribe', () => {
    const wm = createWatchManager();
    const events: NodeEvent[] = [];
    wm.connect('c1', 'u1', (e) => events.push(e));
    wm.watch('u1', ['/sensors'], { children: true, autoWatch: true });
    wm.notify({
      type: 'set',
      path: '/sensors/temp1',
      node: { $path: '/sensors/temp1', $type: 'sensor' },
    });
    wm.notify({ type: 'remove', path: '/sensors/temp1' });
    assert.equal(events.length, 2);
    assert.equal(events[1].type, 'remove');
  });

  it('autoWatch + exact watch preexisting: no double subscribe', () => {
    const wm = createWatchManager();
    const events: NodeEvent[] = [];
    wm.connect('c1', 'u1', (e) => events.push(e));
    wm.watch('u1', ['/sensors/temp1']);
    wm.watch('u1', ['/sensors'], { children: true, autoWatch: true });
    // Event hits exact first, dedup prevents prefix push — but addTo is idempotent
    wm.notify({
      type: 'set',
      path: '/sensors/temp1',
      node: { $path: '/sensors/temp1', $type: 'sensor' },
    });
    assert.equal(events.length, 1); // still just 1
    wm.unwatch('u1', ['/sensors'], { children: true });
    // exact watch still works
    wm.notify({
      type: 'set',
      path: '/sensors/temp1',
      node: { $path: '/sensors/temp1', $type: 'sensor' },
    });
    assert.equal(events.length, 2);
  });

  it('two users autoWatch same prefix independently', () => {
    const wm = createWatchManager();
    const e1: NodeEvent[] = [],
      e2: NodeEvent[] = [];
    wm.connect('c1', 'u1', (e) => e1.push(e));
    wm.connect('c2', 'u2', (e) => e2.push(e));
    wm.watch('u1', ['/sensors'], { children: true, autoWatch: true });
    wm.watch('u2', ['/sensors'], { children: true });
    wm.notify({
      type: 'set',
      path: '/sensors/temp1',
      node: { $path: '/sensors/temp1', $type: 'sensor' },
    });
    assert.equal(e1.length, 1);
    assert.equal(e2.length, 1);
    // u1 gets updates (autoWatch), u2 does not after unwatch children
    wm.unwatch('u1', ['/sensors'], { children: true });
    wm.unwatch('u2', ['/sensors'], { children: true });
    wm.notify({
      type: 'set',
      path: '/sensors/temp1',
      node: { $path: '/sensors/temp1', $type: 'sensor' },
    });
    assert.equal(e1.length, 2); // via auto-subscribed exact
    assert.equal(e2.length, 1); // nothing
  });

  it('children watch on / with autoWatch: top-level child gets subscribed', () => {
    const wm = createWatchManager();
    const events: NodeEvent[] = [];
    wm.connect('c1', 'u1', (e) => events.push(e));
    wm.watch('u1', ['/'], { children: true, autoWatch: true });
    wm.notify({ type: 'set', path: '/sensors', node: { $path: '/sensors', $type: 't' } });
    wm.unwatch('u1', ['/'], { children: true });
    wm.notify({ type: 'set', path: '/sensors', node: { $path: '/sensors', $type: 't' } });
    assert.equal(events.length, 2); // second via exact
  });
});

// ── Real-life scenarios ──

describe('WatchManager — NodeEditor browse lifecycle', () => {
  it('open folder → watch children → click node → navigate back → different folder', () => {
    const wm = createWatchManager();
    const events: NodeEvent[] = [];
    wm.connect('c1', 'admin', (e) => events.push(e));

    // 1. Admin opens /orders folder — watches children + autoWatch for live list
    wm.watch('admin', ['/orders'], { children: true, autoWatch: true });

    // New order appears while browsing
    wm.notify({ type: 'set', path: '/orders/o1', node: { $path: '/orders/o1', $type: 'order' } });
    assert.equal(events.length, 1);

    // 2. Admin clicks into /orders/o1 — already exact-watched via autoWatch
    //    Update to o1 arrives (e.g. status change by kitchen)
    wm.notify({ type: 'patch', path: '/orders/o1', patches: [['r', 'status', 'cooking' ]] });
    assert.equal(events.length, 2);

    // 3. Admin navigates back to /orders — new order o2 still arrives
    wm.notify({ type: 'set', path: '/orders/o2', node: { $path: '/orders/o2', $type: 'order' } });
    assert.equal(events.length, 3);

    // 4. Admin navigates to /products — unwatch orders children
    wm.unwatch('admin', ['/orders'], { children: true });
    wm.watch('admin', ['/products'], { children: true });

    // o1 updates still arrive (exact watch from autoWatch persists)
    wm.notify({ type: 'patch', path: '/orders/o1', patches: [['r', 'status', 'done' ]] });
    assert.equal(events.length, 4);

    // New order o3 does NOT arrive (children watch removed)
    wm.notify({ type: 'set', path: '/orders/o3', node: { $path: '/orders/o3', $type: 'order' } });
    assert.equal(events.length, 4);

    // Products children arrive
    wm.notify({ type: 'set', path: '/products/p1', node: { $path: '/products/p1', $type: 'product' } });
    assert.equal(events.length, 5);
  });

  it('open node detail + list side-by-side, close detail panel', () => {
    const wm = createWatchManager();
    const events: NodeEvent[] = [];
    wm.connect('c1', 'admin', (e) => events.push(e));

    // List view: children watch on /tasks
    wm.watch('admin', ['/tasks'], { children: true });
    // Detail panel: exact watch on specific task
    wm.watch('admin', ['/tasks/t42']);

    // Both list and detail get the same event (deduped to 1)
    wm.notify({ type: 'patch', path: '/tasks/t42', patches: [['r', 'done', true ]] });
    assert.equal(events.length, 1);

    // Close detail panel — unwatch exact only
    wm.unwatch('admin', ['/tasks/t42']);

    // t42 still visible via children watch
    wm.notify({ type: 'patch', path: '/tasks/t42', patches: [['r', 'assignee', 'bob' ]] });
    assert.equal(events.length, 2);

    // Close list too
    wm.unwatch('admin', ['/tasks'], { children: true });
    wm.notify({ type: 'patch', path: '/tasks/t42', patches: [['r', 'done', false ]] });
    assert.equal(events.length, 2); // nothing
  });
});

describe('WatchManager — SSE reconnect with grace period', () => {
  it('reconnect within grace: watches preserved, new push receives events', (t) => {
    const wm = createWatchManager({ gracePeriodMs: 100 });
    const events1: NodeEvent[] = [];
    const events2: NodeEvent[] = [];

    wm.connect('c1', 'u1', (e) => events1.push(e));
    wm.watch('u1', ['/doc']);
    wm.watch('u1', ['/items'], { children: true });

    // Network blip — SSE disconnects
    wm.disconnect('c1');

    // Reconnect with new push channel (same userId)
    const preserved = wm.connect('c2', 'u1', (e) => events2.push(e));
    assert.equal(preserved, true, 'should report watches were preserved');

    // Events go to new push, not old
    wm.notify({ type: 'set', path: '/doc', node: { $path: '/doc', $type: 'doc' } });
    wm.notify({ type: 'set', path: '/items/x', node: { $path: '/items/x', $type: 'item' } });
    assert.equal(events1.length, 0, 'old push should not receive');
    assert.equal(events2.length, 2, 'new push receives both exact and children');
  });

  it('grace expires: watches cleaned up, reconnect starts fresh', async () => {
    const removed: string[] = [];
    const wm = createWatchManager({
      gracePeriodMs: 30,
      onUserRemoved: (uid) => removed.push(uid),
    });

    wm.connect('c1', 'u1', (e) => {});
    wm.watch('u1', ['/doc']);
    wm.disconnect('c1');

    // Wait for grace to expire
    await new Promise(r => setTimeout(r, 50));

    assert.deepEqual(removed, ['u1']);

    // Late reconnect — starts fresh
    const events: NodeEvent[] = [];
    const preserved = wm.connect('c2', 'u1', (e) => events.push(e));
    assert.equal(preserved, false, 'watches were not preserved');

    // Old watch is gone
    wm.notify({ type: 'set', path: '/doc', node: { $path: '/doc', $type: 'doc' } });
    assert.equal(events.length, 0);
  });
});

describe('WatchManager — breakContinuity (core-pxlu, delegated execute)', () => {
  it('active connection receives the reset event immediately', () => {
    const wm = createWatchManager();
    const events: NodeEvent[] = [];
    wm.connect('c1', 'u1', (e) => events.push(e));
    wm.watch('u1', ['/doc']);

    wm.breakContinuity();

    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'reconnect');
    assert.equal((events[0] as { preserved?: boolean }).preserved, false);
  });

  it('unrelated user with different watches also resets (deliberate v1 global reset)', () => {
    const wm = createWatchManager();
    const other: NodeEvent[] = [];
    wm.connect('c1', 'u1', () => {});
    wm.watch('u1', ['/fed/w']);
    wm.connect('c2', 'u2', (e) => other.push(e));
    wm.watch('u2', ['/completely/elsewhere']);

    wm.breakContinuity();

    assert.equal(other.length, 1);
    assert.equal(other[0].type, 'reconnect');
  });

  it('client disconnected during the break reconnects with preserved:false (grace window)', () => {
    const wm = createWatchManager({ gracePeriodMs: 10_000 });
    wm.connect('c1', 'u1', () => {});
    wm.watch('u1', ['/doc']);
    wm.disconnect('c1');

    wm.breakContinuity();

    // Legacy reconnect (no since): missedOffline forces an honest refetch.
    const preserved = wm.connect('c2', 'u1', () => {});
    assert.equal(preserved, false);
  });

  it('resume across a break fails closed — the break re-mints the epoch, a pre-break cursor is refused', () => {
    const wm = createWatchManager({ gracePeriodMs: 10_000 });
    const before: StampedEvent[] = [];
    wm.connect('c1', 'u1', (e) => before.push(e));
    wm.watch('u1', ['/doc']);
    wm.notify({ type: 'set', path: '/doc', node: { $path: '/doc', $type: 'doc' } });
    const preBreak = cursorOf(before[0]);
    wm.disconnect('c1');

    wm.breakContinuity();

    // anz4.10/11: the break invalidated the whole pre-break seq space — the
    // cursor is answered false with NO replay, the client full-refetches.
    const replayed: NodeEvent[] = [];
    const covered = wm.connect('c2', 'u1', (e) => replayed.push(e), preBreak);
    assert.equal(covered, false);
    assert.deepEqual(replayed, []);
  });

  it('user with no watches and no ring history is untouched (no crash, fresh connect unaffected)', () => {
    const wm = createWatchManager();
    wm.breakContinuity();

    const preserved = wm.connect('c1', 'u1', () => {});
    assert.equal(preserved, false, 'fresh user — nothing preserved by definition');
  });
});

describe('WatchManager — edge cases', () => {
  it('watch before connect: no crash, events delivered after connect', () => {
    const wm = createWatchManager();
    // tRPC handler races: watch arrives before SSE connect
    wm.watch('u1', ['/x']);

    const events: NodeEvent[] = [];
    wm.connect('c1', 'u1', (e) => events.push(e));

    wm.notify({ type: 'set', path: '/x', node: { $path: '/x', $type: 't' } });
    assert.equal(events.length, 1);
  });

  it('unwatch on unknown user is noop', () => {
    const wm = createWatchManager();
    // No crash
    wm.unwatch('ghost', ['/a']);
    wm.unwatch('ghost', ['/a'], { children: true });
  });

  it('disconnect unknown connId is noop', () => {
    const wm = createWatchManager();
    wm.disconnect('nonexistent');
    assert.equal(wm.clientCount(), 0);
  });

  it('double watch same path is idempotent', () => {
    const wm = createWatchManager();
    const events: NodeEvent[] = [];
    wm.connect('c1', 'u1', (e) => events.push(e));
    wm.watch('u1', ['/a']);
    wm.watch('u1', ['/a']); // duplicate
    wm.notify({ type: 'set', path: '/a', node: { $path: '/a', $type: 't' } });
    assert.equal(events.length, 1, 'should not deliver twice');
  });

  it('double watch children same path is idempotent', () => {
    const wm = createWatchManager();
    const events: NodeEvent[] = [];
    wm.connect('c1', 'u1', (e) => events.push(e));
    wm.watch('u1', ['/a'], { children: true });
    wm.watch('u1', ['/a'], { children: true }); // duplicate
    wm.notify({ type: 'set', path: '/a/b', node: { $path: '/a/b', $type: 't' } });
    assert.equal(events.length, 1, 'should not deliver twice');
  });

  it('notify reconnect broadcasts to all connected users (refetch signal)', () => {
    // Mid-session reconnect{preserved:false} from external sources (Mongo
    // invalidate, change-stream error, delete-without-preimage) must reach
    // every connected client so caches refetch. Per-scope routing isn't
    // possible — the source can't tell which paths each user holds.
    const wm = createWatchManager();
    const ev1: NodeEvent[] = [];
    const ev2: NodeEvent[] = [];
    wm.connect('c1', 'u1', (e) => ev1.push(e));
    wm.connect('c2', 'u2', (e) => ev2.push(e));
    // No watches registered — still must receive the broadcast.
    wm.notify({ type: 'reconnect', preserved: false });
    assert.equal(ev1.length, 1);
    assert.equal(ev1[0].type, 'reconnect');
    if (ev1[0].type === 'reconnect') assert.equal(ev1[0].preserved, false);
    assert.equal(ev2.length, 1);
  });

  it('notify reconnect reaches users with multiple connections (tabs)', () => {
    const wm = createWatchManager();
    const tab1: NodeEvent[] = [];
    const tab2: NodeEvent[] = [];
    wm.connect('c1', 'u1', (e) => tab1.push(e));
    wm.connect('c2', 'u1', (e) => tab2.push(e));
    wm.notify({ type: 'reconnect', preserved: true });
    assert.equal(tab1.length, 1);
    assert.equal(tab2.length, 1);
  });
});

describe('WatchManager — invalidateVps narrowed per user (core-cnr.8 C26)', () => {
  it('each vp watcher receives only the vps it registered', () => {
    const wm = createWatchManager();
    const e1: NodeEvent[] = [], e2: NodeEvent[] = [];
    wm.connect('c1', 'u1', (e) => e1.push(e));
    wm.connect('c2', 'u2', (e) => e2.push(e));
    wm.watch('u1', ['/views/a'], { children: true });
    wm.watch('u2', ['/views/b'], { children: true });

    wm.notify({ type: 'set', path: '/data/x', node: { $type: 't' }, invalidateVps: ['/views/a', '/views/b'] });

    assert.equal(e1.length, 1);
    assert.deepEqual(e1[0].invalidateVps, ['/views/a']);
    assert.equal(e2.length, 1);
    assert.deepEqual(e2[0].invalidateVps, ['/views/b']);
  });

  it('recipient with no vp watch gets the event stripped of foreign vps', () => {
    const wm = createWatchManager();
    const events: NodeEvent[] = [];
    wm.connect('c1', 'u1', (e) => events.push(e));
    wm.watch('u1', ['/data/x']);

    wm.notify({ type: 'set', path: '/data/x', node: { $type: 't' }, invalidateVps: ['/views/other-user'] });

    assert.equal(events.length, 1);
    assert.equal(events[0].invalidateVps, undefined);
  });

  it('exact + own vp watch: keeps own vp, drops the foreign one', () => {
    const wm = createWatchManager();
    const events: NodeEvent[] = [];
    wm.connect('c1', 'u1', (e) => events.push(e));
    wm.watch('u1', ['/data/x']);
    wm.watch('u1', ['/views/mine'], { children: true });

    wm.notify({ type: 'set', path: '/data/x', node: { $type: 't' }, invalidateVps: ['/views/mine', '/views/theirs'] });

    assert.equal(events.length, 1);
    assert.deepEqual(events[0].invalidateVps, ['/views/mine']);
  });

  it('ring replay after grace delivers the narrowed event, not the union', () => {
    const wm = createWatchManager();
    const live: StampedEvent[] = [];
    wm.connect('c1', 'u1', (e) => live.push(e));
    wm.watch('u1', ['/views/a'], { children: true });
    wm.notify({ type: 'set', path: '/data/x', node: { $type: 't' }, invalidateVps: ['/views/a'] });
    const cursor = cursorOf(live[0]);
    wm.disconnect('c1');

    wm.notify({ type: 'set', path: '/data/x', node: { $type: 't' }, invalidateVps: ['/views/a', '/views/b'] });

    const replayed: NodeEvent[] = [];
    const covered = wm.connect('c2', 'u1', (e) => replayed.push(e), cursor);
    assert.equal(covered, true);
    assert.equal(replayed.length, 1);
    assert.deepEqual(replayed[0].invalidateVps, ['/views/a']);
  });
});

describe('WatchManager — auto-watch lifecycle on remove (core-cnr.8 C27)', () => {
  it('churning children under autoWatch do not exhaust the watch budget', () => {
    const wm = createWatchManager({ maxWatchesPerUser: 5 });
    const events: NodeEvent[] = [];
    wm.connect('c1', 'u1', (e) => events.push(e));
    wm.watch('u1', ['/dir'], { children: true, autoWatch: true });

    for (let i = 0; i < 20; i++) {
      wm.notify({ type: 'set', path: `/dir/x${i}`, node: { $type: 't' } });
      wm.notify({ type: 'remove', path: `/dir/x${i}` });
    }
    assert.equal(events.length, 40); // every set and remove delivered

    // Without pruning, user.paths held 20 dead watches and this threw.
    wm.watch('u1', ['/elsewhere']);
    wm.notify({ type: 'set', path: '/elsewhere', node: { $type: 't' } });
    assert.equal(events.length, 41);
  });

  it('remove does not promote: vp-routed remove leaves no exact watch behind', () => {
    const wm = createWatchManager();
    const events: NodeEvent[] = [];
    wm.connect('c1', 'u1', (e) => events.push(e));
    wm.watch('u1', ['/views/q'], { children: true, autoWatch: true });

    wm.notify({ type: 'remove', path: '/data/x', invalidateVps: ['/views/q'] });
    assert.equal(events.length, 1);

    // No exact watch was installed on the removed node — silence.
    wm.notify({ type: 'set', path: '/data/x', node: { $type: 't' } });
    assert.equal(events.length, 1);
  });

  it('explicit exact watch survives remove and sees the recreate', () => {
    const wm = createWatchManager();
    const events: NodeEvent[] = [];
    wm.connect('c1', 'u1', (e) => events.push(e));
    wm.watch('u1', ['/a']);

    wm.notify({ type: 'remove', path: '/a' });
    wm.notify({ type: 'set', path: '/a', node: { $type: 't' } });
    assert.equal(events.length, 2);
  });

  it('auto-watched child pruned on remove, re-promoted on recreate via prefix', () => {
    const wm = createWatchManager();
    const events: NodeEvent[] = [];
    wm.connect('c1', 'u1', (e) => events.push(e));
    wm.watch('u1', ['/dir'], { children: true, autoWatch: true });

    wm.notify({ type: 'set', path: '/dir/a', node: { $type: 't' } });   // promoted
    wm.notify({ type: 'remove', path: '/dir/a' });                       // delivered, pruned
    wm.notify({ type: 'set', path: '/dir/a', node: { $type: 't' } });   // via prefix, re-promoted
    wm.notify({ type: 'set', path: '/dir/a', node: { $type: 't' } });   // via exact
    assert.equal(events.length, 4);
  });

  it('explicit watch on an auto-watched path upgrades it — survives remove', () => {
    const wm = createWatchManager();
    const events: NodeEvent[] = [];
    wm.connect('c1', 'u1', (e) => events.push(e));
    wm.watch('u1', ['/dir'], { children: true, autoWatch: true });

    wm.notify({ type: 'set', path: '/dir/a', node: { $type: 't' } });   // auto-promoted
    wm.watch('u1', ['/dir/a']);                                          // now explicit
    wm.unwatch('u1', ['/dir'], { children: true });

    wm.notify({ type: 'remove', path: '/dir/a' });
    wm.notify({ type: 'set', path: '/dir/a', node: { $type: 't' } });   // explicit survives
    assert.equal(events.length, 3);
  });
});

describe('WatchManager — seq / ring / resume (core-gk8.1)', () => {
  const setEvent = (path: string): NodeEvent => ({ type: 'set', path, node: { $type: 't' } });
  const seqOf = (e: NodeEvent) => (e.type === 'reconnect' ? undefined : e.seq);

  it('stamps per-user monotonic seq on delivered events', () => {
    const wm = createWatchManager();
    const e1: NodeEvent[] = [];
    const e2: NodeEvent[] = [];
    wm.connect('c1', 'u1', (e) => e1.push(e));
    wm.watch('u1', ['/a']);
    wm.notify(setEvent('/a'));
    wm.notify(setEvent('/a'));
    wm.connect('c2', 'u2', (e) => e2.push(e));
    wm.watch('u2', ['/a']);
    wm.notify(setEvent('/a'));
    assert.deepEqual(e1.map(seqOf), [1, 2, 3]);
    assert.deepEqual(e2.map(seqOf), [1]); // per-user stream, not global
  });

  it('connect(cursor) replays grace-window events — preserved means continuity', () => {
    const wm = createWatchManager();
    const a: StampedEvent[] = [];
    wm.connect('c1', 'u1', (e) => a.push(e));
    wm.watch('u1', ['/a']);
    wm.notify(setEvent('/a')); // seq 1, delivered live
    const cursor = cursorOf(a[0]);
    wm.disconnect('c1');
    wm.notify(setEvent('/a')); // seq 2 — offline, ringed
    wm.notify(setEvent('/a')); // seq 3 — offline, ringed

    const b: NodeEvent[] = [];
    const preserved = wm.connect('c2', 'u1', (e) => b.push(e), cursor);
    assert.equal(preserved, true);
    assert.deepEqual(b.map(seqOf), [2, 3]); // exactly the gap, in order
  });

  it('cursor at the head of the stream: covered, nothing replayed (happy path)', () => {
    const wm = createWatchManager();
    const a: StampedEvent[] = [];
    wm.connect('c1', 'u1', (e) => a.push(e));
    wm.watch('u1', ['/a']);
    wm.notify(setEvent('/a'));
    wm.notify(setEvent('/a'));
    const cursor = cursorOf(a[1]);
    wm.disconnect('c1');

    const b: NodeEvent[] = [];
    const preserved = wm.connect('c2', 'u1', (e) => b.push(e), cursor);
    assert.equal(preserved, true);
    assert.deepEqual(b, []);
  });

  it('ring overflow → preserved false, no partial replay', () => {
    const wm = createWatchManager({ ringSize: 2 });
    const a: StampedEvent[] = [];
    wm.connect('c1', 'u1', (e) => a.push(e));
    wm.watch('u1', ['/a']);
    wm.notify(setEvent('/a')); // seq 1
    const cursor = cursorOf(a[0]);
    wm.disconnect('c1');
    wm.notify(setEvent('/a')); // 2
    wm.notify(setEvent('/a')); // 3
    wm.notify(setEvent('/a')); // 4 — ring now [3,4], seq 2 evicted

    const b: NodeEvent[] = [];
    const preserved = wm.connect('c2', 'u1', (e) => b.push(e), cursor);
    assert.equal(preserved, false); // gap not covered — client must refetch
    assert.deepEqual(b, []);        // never replay a hole silently
  });

  it('legacy reconnect (no since): false exactly when events were missed offline', () => {
    const wm = createWatchManager();
    wm.connect('c1', 'u1', () => {});
    wm.watch('u1', ['/a']);
    wm.disconnect('c1');
    assert.equal(wm.connect('c2', 'u1', () => {}), true); // nothing missed

    wm.disconnect('c2');
    wm.notify(setEvent('/a')); // missed while offline
    assert.equal(wm.connect('c3', 'u1', () => {}), false); // old preserved:true lie is gone
  });

  it('multi-tab: shared seq stream; resuming tab replays only to itself', () => {
    const wm = createWatchManager();
    const tab1: NodeEvent[] = [];
    const tab2: StampedEvent[] = [];
    wm.connect('c1', 'u1', (e) => tab1.push(e));
    wm.connect('c2', 'u1', (e) => tab2.push(e));
    wm.watch('u1', ['/a']);
    wm.notify(setEvent('/a')); // seq 1 → both tabs
    const cursor = cursorOf(tab2[0]);
    wm.disconnect('c2');
    wm.notify(setEvent('/a')); // seq 2 → tab1 only (user online — not "missed")

    const tab2b: NodeEvent[] = [];
    const preserved = wm.connect('c2b', 'u1', (e) => tab2b.push(e), cursor);
    assert.equal(preserved, true);
    assert.deepEqual(tab2b.map(seqOf), [2]); // replayed to the new tab
    assert.deepEqual(tab1.map(seqOf), [1, 2]); // no duplicates to the live tab
  });
});

// ── P1 continuity bundle (core-anz4.10 / 4.11 / 4.12) ──

describe('WatchManager — resume epoch (core-anz4.10)', () => {
  const setEvent = (path: string): NodeEvent => ({ type: 'set', path, node: { $type: 't' } });

  it('two tabs sleep; A resets the entry; B\'s stale cursor is refused — never silently covered', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const wm = createWatchManager({ gracePeriodMs: 100 });
    const b: StampedEvent[] = [];
    wm.connect('cA', 'u1', () => {});
    wm.connect('cB', 'u1', (e) => b.push(e));
    wm.watch('u1', ['/doc']);
    for (let i = 0; i < 5; i++) wm.notify(setEvent('/doc')); // both tabs at seq 5
    const staleCursor = cursorOf(b[4]);
    wm.disconnect('cA');
    wm.disconnect('cB');
    t.mock.timers.tick(100); // grace expires → entry (and its seq space) is gone

    // Tab A returns first: honest refetch, re-registers, the NEW entry counts 1..3.
    assert.equal(wm.connect('cA2', 'u1', () => {}), false);
    wm.watch('u1', ['/doc']);
    wm.notify(setEvent('/doc'));
    wm.notify(setEvent('/doc'));
    wm.notify(setEvent('/doc'));

    // Tab B resumes with its pre-sleep cursor: seq 5 >= 3 numerically — the
    // old seq-only compare answered covered=true and B silently kept a cache
    // missing EVERYTHING (including removes). Epoch mismatch refuses it.
    const b2: NodeEvent[] = [];
    assert.equal(wm.connect('cB2', 'u1', (e) => b2.push(e), staleCursor), false);
    assert.deepEqual(b2, []);
  });

  it('cursor without epoch (legacy bare number) fails closed even when seq looks covered', () => {
    const wm = createWatchManager();
    wm.connect('c1', 'u1', () => {});
    wm.watch('u1', ['/a']);
    wm.notify(setEvent('/a'));
    wm.notify(setEvent('/a'));
    wm.disconnect('c1');

    assert.equal(wm.connect('c2', 'u1', () => {}, 2), false);
  });

  it('cursor ahead of the stream under the live epoch fails closed (corrupt client)', () => {
    const wm = createWatchManager();
    const a: StampedEvent[] = [];
    wm.connect('c1', 'u1', (e) => a.push(e));
    wm.watch('u1', ['/a']);
    wm.notify(setEvent('/a'));
    const { epoch } = cursorOf(a[0]);
    wm.disconnect('c1');

    assert.equal(wm.connect('c2', 'u1', () => {}, { seq: 99, epoch }), false);
  });
});

describe('WatchManager — external continuity break (core-anz4.11)', () => {
  const setEvent = (path: string): NodeEvent => ({ type: 'set', path, node: { $type: 't' } });

  it('external reconnect{preserved:false} invalidates every pre-break cursor', () => {
    const wm = createWatchManager({ gracePeriodMs: 10_000 });
    const a: StampedEvent[] = [];
    wm.connect('c1', 'u1', (e) => a.push(e));
    wm.watch('u1', ['/doc']);
    wm.notify(setEvent('/doc'));
    const preBreak = cursorOf(a[0]);
    wm.disconnect('c1');

    // The signal external-watch forwards on a change-stream error / fs-watcher
    // drop — previously broadcast-only, invisible to the seq/ring accounting.
    wm.notify({ type: 'reconnect', preserved: false });

    const replayed: NodeEvent[] = [];
    assert.equal(wm.connect('c2', 'u1', (e) => replayed.push(e), preBreak), false);
    assert.deepEqual(replayed, []);
  });

  it('live client adopts the post-break epoch from the stamped reset and resumes covered later', () => {
    const wm = createWatchManager({ gracePeriodMs: 10_000 });
    const a: StampedEvent[] = [];
    wm.connect('c1', 'u1', (e) => a.push(e));
    wm.watch('u1', ['/doc']);
    wm.notify(setEvent('/doc'));            // seq 1, epoch E1
    const preBreak = cursorOf(a[0]);

    wm.notify({ type: 'reconnect', preserved: false }); // seq 2, stamped epoch E2
    const breakEvent = a[1];
    assert.equal(breakEvent.type, 'reconnect');
    const postBreak = cursorOf(breakEvent);
    assert.notEqual(postBreak.epoch, preBreak.epoch);

    wm.notify(setEvent('/doc'));            // seq 3 under E2 — client stays current
    const head = cursorOf(a[2]);
    assert.equal(head.epoch, postBreak.epoch);
    wm.disconnect('c1');

    const b: NodeEvent[] = [];
    assert.equal(wm.connect('c2', 'u1', (e) => b.push(e), head), true);
    assert.deepEqual(b, []);
  });

  it('preserved:true reconnect is informational — continuity (and epoch) intact', () => {
    const wm = createWatchManager({ gracePeriodMs: 10_000 });
    const a: StampedEvent[] = [];
    wm.connect('c1', 'u1', (e) => a.push(e));
    wm.watch('u1', ['/doc']);
    wm.notify(setEvent('/doc'));
    const cursor = cursorOf(a[0]);

    wm.notify({ type: 'reconnect', preserved: true });
    wm.disconnect('c1');

    assert.equal(wm.connect('c2', 'u1', () => {}, cursor), true);
  });

  it('break while offline: legacy no-cursor reconnect is answered false (missedOffline)', () => {
    const wm = createWatchManager({ gracePeriodMs: 10_000 });
    wm.connect('c1', 'u1', () => {});
    wm.watch('u1', ['/doc']);
    wm.disconnect('c1');

    wm.notify({ type: 'reconnect', preserved: false });

    assert.equal(wm.connect('c2', 'u1', () => {}), false);
  });
});

describe('WatchManager — token-scoped watch ownership (core-anz4.12)', () => {
  const setEvent = (path: string): NodeEvent => ({ type: 'set', path, node: { $type: 't' } });

  it('two consumers, same user+path: first release keeps the second receiving', () => {
    const wm = createWatchManager();
    const got: NodeEvent[] = [];
    wm.connect('c1', 'u1', (e) => got.push(e), undefined, 't1');
    wm.connect('c2', 'u1', () => {}, undefined, 't2');
    wm.watch('u1', ['/a'], { token: 't1' });
    wm.watch('u1', ['/a'], { token: 't2' });

    wm.unwatch('u1', ['/a'], { token: 't1' });
    wm.notify(setEvent('/a'));
    assert.equal(got.length, 1, 'registration must survive the co-holder\'s release');

    wm.unwatch('u1', ['/a'], { token: 't2' });
    wm.notify(setEvent('/a'));
    assert.equal(got.length, 1, 'last holder released — watch gone');
  });

  it('children watch co-held: first unwatch keeps the prefix AND its query registration', () => {
    const unwatchedQueries: string[] = [];
    const wm = createWatchManager();
    wm.bindQueryRegistry({
      watchQuery: () => {},
      unwatchQuery: (vp) => unwatchedQueries.push(vp),
      unwatchAllQueries: () => {},
    });
    const got: NodeEvent[] = [];
    wm.connect('c1', 'u1', (e) => got.push(e));
    const query = { plan: { source: '/data' }, mountDeps: new Set(['/view']) };
    wm.watch('u1', ['/view'], { children: true, query, token: 't1' });
    wm.watch('u1', ['/view'], { children: true, query, token: 't2' });

    wm.unwatch('u1', ['/view'], { children: true, token: 't1' });
    assert.deepEqual(unwatchedQueries, [], 'query watch must survive the co-holder\'s release');
    wm.notify(setEvent('/view/x'));
    assert.equal(got.length, 1);

    wm.unwatch('u1', ['/view'], { children: true, token: 't2' });
    assert.deepEqual(unwatchedQueries, ['/view']);
  });

  it('token disconnect releases ALL its registrations after grace; co-held path survives', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const wm = createWatchManager({ gracePeriodMs: 100 });
    const got: NodeEvent[] = [];
    wm.connect('c1', 'u1', () => {}, undefined, 't1');
    wm.connect('c2', 'u1', (e) => got.push(e), undefined, 't2');
    wm.watch('u1', ['/x', '/y'], { token: 't1' });
    wm.watch('u1', ['/shared'], { token: 't1' });
    wm.watch('u1', ['/shared'], { token: 't2' });

    wm.disconnect('c1');
    wm.disconnect('c1'); // idempotent — second disconnect of the same lane is a no-op
    t.mock.timers.tick(100);

    wm.notify(setEvent('/x'));
    wm.notify(setEvent('/y'));
    assert.equal(got.length, 0, 't1\'s exclusive registrations released exactly once');
    wm.notify(setEvent('/shared'));
    assert.equal(got.length, 1, 'co-held registration survives t1\'s death');
  });

  it('token reconnect within grace keeps its registrations', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const wm = createWatchManager({ gracePeriodMs: 100 });
    const got: NodeEvent[] = [];
    wm.connect('c1', 'u1', () => {}, undefined, 't1');
    wm.connect('cKeep', 'u1', (e) => got.push(e), undefined, 'tKeep'); // keeps the user entry alive
    wm.watch('u1', ['/x'], { token: 't1' });

    wm.disconnect('c1');
    t.mock.timers.tick(50);
    wm.connect('c1b', 'u1', () => {}, undefined, 't1'); // same tab, new lane
    t.mock.timers.tick(100); // past the original grace deadline

    wm.notify(setEvent('/x'));
    assert.equal(got.length, 1, 'watch survives — the tab came back in time');
  });

  it('double release cannot underflow the budget', () => {
    const wm = createWatchManager({ maxWatchesPerUser: 2 });
    wm.connect('c1', 'u1', () => {}, undefined, 't1');
    wm.watch('u1', ['/a'], { token: 't1' });
    wm.watch('u1', ['/b'], { token: 't1' });

    wm.unwatch('u1', ['/a'], { token: 't1' });
    wm.unwatch('u1', ['/a'], { token: 't1' }); // double release — must be a no-op

    wm.watch('u1', ['/c'], { token: 't1' });   // back at the limit of 2
    // An underflow would have freed a phantom slot and let this succeed.
    assert.throws(() => wm.watch('u1', ['/d'], { token: 't1' }));
  });

  it('refetch re-registration never moves the count (the previous refcount leak)', () => {
    const wm = createWatchManager({ maxWatchesPerUser: 2 });
    wm.connect('c1', 'u1', () => {}, undefined, 't1');
    for (let i = 0; i < 50; i++) wm.watch('u1', ['/a'], { token: 't1' }); // refetch loop
    wm.watch('u1', ['/b'], { token: 't1' }); // still fits — count is 2, not 51

    assert.throws(() => wm.watch('u1', ['/c'], { token: 't1' }));

    // And the single release still frees exactly one slot.
    wm.unwatch('u1', ['/a'], { token: 't1' });
    wm.watch('u1', ['/c'], { token: 't1' });
    assert.throws(() => wm.watch('u1', ['/d'], { token: 't1' }));
  });

  it('auto-promotion is owned by the promoting token; explicit co-hold survives its release', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const wm = createWatchManager({ gracePeriodMs: 100 });
    const got: NodeEvent[] = [];
    wm.connect('c1', 'u1', () => {}, undefined, 't1');
    wm.connect('c2', 'u1', (e) => got.push(e), undefined, 't2');
    wm.watch('u1', ['/dir'], { children: true, autoWatch: true, token: 't1' });
    wm.watch('u1', ['/dir/a'], { token: 't2' }); // explicit hold by the other tab

    wm.notify(setEvent('/dir/a')); // t1 gains an auto hold alongside t2's explicit
    assert.equal(got.length, 1);

    wm.disconnect('c1');
    t.mock.timers.tick(100); // t1 dies with its prefix watch and auto holds

    wm.notify(setEvent('/dir/a'));
    assert.equal(got.length, 2, 't2\'s explicit watch must survive t1\'s auto hold');
    wm.notify(setEvent('/dir/b'));
    assert.equal(got.length, 2, 't1\'s prefix watch is gone');
  });
});
