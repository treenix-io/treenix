import { createNode } from '#core';
import { createMemoryTree } from '#tree';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { withSubscriptions, type NodeEvent } from './index';
import { createWatchManager, type RouteEnvelope, type StampedEvent, type WatchCursor } from './watch';

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
      watchQuery: (reg) => { watched.push(reg); return null; },
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
    wm.connect('c1', 'u1', (e) => events.push(e.event));
    wm.watch('u1', ['/a']);
    wm.notify({ type: 'set', path: '/a', node: { $path: '/a', $type: 't' } });
    assert.equal(events.length, 1);
    assert.equal((events[0] as { path: string }).path, '/a');
  });

  it('does not deliver to non-watching user', () => {
    const wm = createWatchManager();
    const events: NodeEvent[] = [];
    wm.connect('c1', 'u1', (e) => events.push(e.event));
    wm.watch('u1', ['/a']);
    wm.notify({ type: 'set', path: '/b', node: { $path: '/b', $type: 't' } });
    assert.equal(events.length, 0);
  });

  it('unwatch stops delivery', () => {
    const wm = createWatchManager();
    const events: NodeEvent[] = [];
    wm.connect('c1', 'u1', (e) => events.push(e.event));
    wm.watch('u1', ['/a']);
    wm.unwatch('u1', ['/a']);
    wm.notify({ type: 'set', path: '/a', node: { $path: '/a', $type: 't' } });
    assert.equal(events.length, 0);
  });

  it('disconnect removes all watches when last connection closes', () => {
    const wm = createWatchManager();
    const events: NodeEvent[] = [];
    wm.connect('c1', 'u1', (e) => events.push(e.event));
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
    wm.connect('c1', 'u1', (e) => e1.push(e.event));
    wm.connect('c2', 'u2', (e) => e2.push(e.event));
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
    wm.connect('c1', 'u1', (e) => e1.push(e.event));
    wm.watch('u1', ['/a']);
    wm.connect('c1', 'u1', (e) => e2.push(e.event));
    wm.notify({ type: 'set', path: '/a', node: { $path: '/a', $type: 't' } });
    assert.equal(e1.length, 0);
    assert.equal(e2.length, 1);
  });

  it('remove event delivered', () => {
    const wm = createWatchManager();
    const events: NodeEvent[] = [];
    wm.connect('c1', 'u1', (e) => events.push(e.event));
    wm.watch('u1', ['/a']);
    wm.notify({ type: 'remove', path: '/a' });
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'remove');
  });

  it('multi-tab: both tabs receive events', () => {
    const wm = createWatchManager();
    const tab1: NodeEvent[] = [], tab2: NodeEvent[] = [];
    wm.connect('c1', 'u1', (e) => tab1.push(e.event));
    wm.connect('c2', 'u1', (e) => tab2.push(e.event));
    wm.watch('u1', ['/a']);
    wm.notify({ type: 'set', path: '/a', node: { $path: '/a', $type: 't' } });
    assert.equal(tab1.length, 1);
    assert.equal(tab2.length, 1);
  });

  it('multi-tab: closing one tab keeps other alive', () => {
    const wm = createWatchManager();
    const tab1: NodeEvent[] = [], tab2: NodeEvent[] = [];
    wm.connect('c1', 'u1', (e) => tab1.push(e.event));
    wm.connect('c2', 'u1', (e) => tab2.push(e.event));
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
    wm.connect('c1', 'u1', (e) => events.push(e.event));
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
    wm.connect('c1', 'u1', (e) => events.push(e.event));
    wm.watch('u1', ['/a'], { children: true });
    wm.notify({ type: 'set', path: '/a/b/c', node: { $path: '/a/b/c', $type: 't' } });
    assert.equal(events.length, 0);
  });

  it('does NOT deliver on parent itself', () => {
    const wm = createWatchManager();
    const events: NodeEvent[] = [];
    wm.connect('c1', 'u1', (e) => events.push(e.event));
    wm.watch('u1', ['/sensors'], { children: true });
    wm.notify({ type: 'set', path: '/sensors', node: { $path: '/sensors', $type: 'dir' } });
    assert.equal(events.length, 0);
  });

  it('does NOT deliver on sibling path', () => {
    const wm = createWatchManager();
    const events: NodeEvent[] = [];
    wm.connect('c1', 'u1', (e) => events.push(e.event));
    wm.watch('u1', ['/sensors'], { children: true });
    wm.notify({ type: 'set', path: '/other/temp1', node: { $path: '/other/temp1', $type: 't' } });
    assert.equal(events.length, 0);
  });

  it('unwatch with children stops delivery', () => {
    const wm = createWatchManager();
    const events: NodeEvent[] = [];
    wm.connect('c1', 'u1', (e) => events.push(e.event));
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
    wm.connect('c1', 'u1', (e) => events.push(e.event));
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
    wm.connect('c1', 'u1', (e) => events.push(e.event));
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
    wm.connect('c1', 'u1', (e) => events.push(e.event));
    wm.watch('u1', ['/'], { children: true });
    wm.notify({ type: 'set', path: '/sensors', node: { $path: '/sensors', $type: 't' } });
    assert.equal(events.length, 1);
  });

  it('children watch on root does NOT deliver for nested paths', () => {
    const wm = createWatchManager();
    const events: NodeEvent[] = [];
    wm.connect('c1', 'u1', (e) => events.push(e.event));
    wm.watch('u1', ['/'], { children: true });
    wm.notify({ type: 'set', path: '/a/b', node: { $path: '/a/b', $type: 't' } });
    wm.notify({ type: 'set', path: '/a/b/c', node: { $path: '/a/b/c', $type: 't' } });
    assert.equal(events.length, 0);
  });

  it('autoWatch child does NOT leak into grandchildren', () => {
    const wm = createWatchManager();
    const events: NodeEvent[] = [];
    wm.connect('c1', 'u1', (e) => events.push(e.event));
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
    wm.connect('c1', 'u1', (e) => e1.push(e.event));
    wm.watch('u1', ['/sensors'], { children: true });
    wm.connect('c1', 'u1', (e) => e2.push(e.event));
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
    wm.connect('c1', 'u1', (e) => events.push(e.event));
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
    wm.connect('c1', 'u1', (e) => events.push(e.event));
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
    wm.connect('c1', 'u1', (e) => events.push(e.event));
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
    wm.connect('c1', 'u1', (e) => events.push(e.event));
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
    wm.connect('c1', 'u1', (e) => events.push(e.event));
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
    wm.connect('c1', 'u1', (e) => events.push(e.event));
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
    wm.connect('c1', 'u1', (e) => e1.push(e.event));
    wm.connect('c2', 'u2', (e) => e2.push(e.event));
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
    wm.connect('c1', 'u1', (e) => events.push(e.event));
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
    wm.connect('c1', 'admin', (e) => events.push(e.event));

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
    wm.connect('c1', 'admin', (e) => events.push(e.event));

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

    wm.connect('c1', 'u1', (e) => events1.push(e.event));
    wm.watch('u1', ['/doc']);
    wm.watch('u1', ['/items'], { children: true });

    // Network blip — SSE disconnects
    wm.disconnect('c1');

    // Reconnect with new push channel (same userId)
    const { preserved } = wm.connect('c2', 'u1', (e) => events2.push(e.event));
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
    const { preserved } = wm.connect('c2', 'u1', (e) => events.push(e.event));
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
    wm.connect('c1', 'u1', (e) => events.push(e.event));
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
    wm.connect('c2', 'u2', (e) => other.push(e.event));
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
    const { preserved } = wm.connect('c2', 'u1', () => {});
    assert.equal(preserved, false);
  });

  it('resume across a break fails closed — the break re-mints the epoch, a pre-break cursor is refused', () => {
    const wm = createWatchManager({ gracePeriodMs: 10_000 });
    const before: StampedEvent[] = [];
    wm.connect('c1', 'u1', (e) => before.push(e.event));
    wm.watch('u1', ['/doc']);
    wm.notify({ type: 'set', path: '/doc', node: { $path: '/doc', $type: 'doc' } });
    const preBreak = cursorOf(before[0]);
    wm.disconnect('c1');

    wm.breakContinuity();

    // anz4.10/11: the break invalidated the whole pre-break seq space — the
    // cursor is answered false with NO replay, the client full-refetches.
    const replayed: NodeEvent[] = [];
    const { preserved: covered } = wm.connect('c2', 'u1', (e) => replayed.push(e.event), preBreak);
    assert.equal(covered, false);
    assert.deepEqual(replayed, []);
  });

  it('user with no watches and no ring history is untouched (no crash, fresh connect unaffected)', () => {
    const wm = createWatchManager();
    wm.breakContinuity();

    const { preserved } = wm.connect('c1', 'u1', () => {});
    assert.equal(preserved, false, 'fresh user — nothing preserved by definition');
  });
});

describe('WatchManager — edge cases', () => {
  it('watch before connect: no crash, events delivered after connect', () => {
    const wm = createWatchManager();
    // tRPC handler races: watch arrives before SSE connect
    wm.watch('u1', ['/x']);

    const events: NodeEvent[] = [];
    wm.connect('c1', 'u1', (e) => events.push(e.event));

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
    wm.connect('c1', 'u1', (e) => events.push(e.event));
    wm.watch('u1', ['/a']);
    wm.watch('u1', ['/a']); // duplicate
    wm.notify({ type: 'set', path: '/a', node: { $path: '/a', $type: 't' } });
    assert.equal(events.length, 1, 'should not deliver twice');
  });

  it('double watch children same path is idempotent', () => {
    const wm = createWatchManager();
    const events: NodeEvent[] = [];
    wm.connect('c1', 'u1', (e) => events.push(e.event));
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
    wm.connect('c1', 'u1', (e) => ev1.push(e.event));
    wm.connect('c2', 'u2', (e) => ev2.push(e.event));
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
    wm.connect('c1', 'u1', (e) => tab1.push(e.event));
    wm.connect('c2', 'u1', (e) => tab2.push(e.event));
    wm.notify({ type: 'reconnect', preserved: true });
    assert.equal(tab1.length, 1);
    assert.equal(tab2.length, 1);
  });
});

describe('WatchManager — invalidateVps narrowed per user (core-cnr.8 C26)', () => {
  it('each vp watcher receives only the vps it registered', () => {
    const wm = createWatchManager();
    const e1: NodeEvent[] = [], e2: NodeEvent[] = [];
    wm.connect('c1', 'u1', (e) => e1.push(e.event));
    wm.connect('c2', 'u2', (e) => e2.push(e.event));
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
    wm.connect('c1', 'u1', (e) => events.push(e.event));
    wm.watch('u1', ['/data/x']);

    wm.notify({ type: 'set', path: '/data/x', node: { $type: 't' }, invalidateVps: ['/views/other-user'] });

    assert.equal(events.length, 1);
    assert.equal(events[0].invalidateVps, undefined);
  });

  it('exact + own vp watch: keeps own vp, drops the foreign one', () => {
    const wm = createWatchManager();
    const events: NodeEvent[] = [];
    wm.connect('c1', 'u1', (e) => events.push(e.event));
    wm.watch('u1', ['/data/x']);
    wm.watch('u1', ['/views/mine'], { children: true });

    wm.notify({ type: 'set', path: '/data/x', node: { $type: 't' }, invalidateVps: ['/views/mine', '/views/theirs'] });

    assert.equal(events.length, 1);
    assert.deepEqual(events[0].invalidateVps, ['/views/mine']);
  });

  it('ring replay after grace delivers the narrowed event, not the union', () => {
    const wm = createWatchManager();
    const live: StampedEvent[] = [];
    wm.connect('c1', 'u1', (e) => live.push(e.event));
    wm.watch('u1', ['/views/a'], { children: true });
    wm.notify({ type: 'set', path: '/data/x', node: { $type: 't' }, invalidateVps: ['/views/a'] });
    const cursor = cursorOf(live[0]);
    wm.disconnect('c1');

    wm.notify({ type: 'set', path: '/data/x', node: { $type: 't' }, invalidateVps: ['/views/a', '/views/b'] });

    const replayed: NodeEvent[] = [];
    const { preserved: covered } = wm.connect('c2', 'u1', (e) => replayed.push(e.event), cursor);
    assert.equal(covered, true);
    assert.equal(replayed.length, 1);
    assert.deepEqual(replayed[0].invalidateVps, ['/views/a']);
  });
});

describe('WatchManager — auto-watch lifecycle on remove (core-cnr.8 C27)', () => {
  it('churning children under autoWatch do not exhaust the watch budget', () => {
    const wm = createWatchManager({ maxWatchesPerUser: 5 });
    const events: NodeEvent[] = [];
    wm.connect('c1', 'u1', (e) => events.push(e.event));
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
    wm.connect('c1', 'u1', (e) => events.push(e.event));
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
    wm.connect('c1', 'u1', (e) => events.push(e.event));
    wm.watch('u1', ['/a']);

    wm.notify({ type: 'remove', path: '/a' });
    wm.notify({ type: 'set', path: '/a', node: { $type: 't' } });
    assert.equal(events.length, 2);
  });

  it('auto-watched child pruned on remove, re-promoted on recreate via prefix', () => {
    const wm = createWatchManager();
    const events: NodeEvent[] = [];
    wm.connect('c1', 'u1', (e) => events.push(e.event));
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
    wm.connect('c1', 'u1', (e) => events.push(e.event));
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
    wm.connect('c1', 'u1', (e) => e1.push(e.event));
    wm.watch('u1', ['/a']);
    wm.notify(setEvent('/a'));
    wm.notify(setEvent('/a'));
    wm.connect('c2', 'u2', (e) => e2.push(e.event));
    wm.watch('u2', ['/a']);
    wm.notify(setEvent('/a'));
    assert.deepEqual(e1.map(seqOf), [1, 2, 3]);
    assert.deepEqual(e2.map(seqOf), [1]); // per-user stream, not global
  });

  it('connect(cursor) replays grace-window events — preserved means continuity', () => {
    const wm = createWatchManager();
    const a: StampedEvent[] = [];
    wm.connect('c1', 'u1', (e) => a.push(e.event));
    wm.watch('u1', ['/a']);
    wm.notify(setEvent('/a')); // seq 1, delivered live
    const cursor = cursorOf(a[0]);
    wm.disconnect('c1');
    wm.notify(setEvent('/a')); // seq 2 — offline, ringed
    wm.notify(setEvent('/a')); // seq 3 — offline, ringed

    const b: NodeEvent[] = [];
    const { preserved } = wm.connect('c2', 'u1', (e) => b.push(e.event), cursor);
    assert.equal(preserved, true);
    assert.deepEqual(b.map(seqOf), [2, 3]); // exactly the gap, in order
  });

  it('cursor at the head of the stream: covered, nothing replayed (happy path)', () => {
    const wm = createWatchManager();
    const a: StampedEvent[] = [];
    wm.connect('c1', 'u1', (e) => a.push(e.event));
    wm.watch('u1', ['/a']);
    wm.notify(setEvent('/a'));
    wm.notify(setEvent('/a'));
    const cursor = cursorOf(a[1]);
    wm.disconnect('c1');

    const b: NodeEvent[] = [];
    const { preserved } = wm.connect('c2', 'u1', (e) => b.push(e.event), cursor);
    assert.equal(preserved, true);
    assert.deepEqual(b, []);
  });

  it('ring overflow → preserved false, no partial replay', () => {
    const wm = createWatchManager({ ringSize: 2 });
    const a: StampedEvent[] = [];
    wm.connect('c1', 'u1', (e) => a.push(e.event));
    wm.watch('u1', ['/a']);
    wm.notify(setEvent('/a')); // seq 1
    const cursor = cursorOf(a[0]);
    wm.disconnect('c1');
    wm.notify(setEvent('/a')); // 2
    wm.notify(setEvent('/a')); // 3
    wm.notify(setEvent('/a')); // 4 — ring now [3,4], seq 2 evicted

    const b: NodeEvent[] = [];
    const { preserved } = wm.connect('c2', 'u1', (e) => b.push(e.event), cursor);
    assert.equal(preserved, false); // gap not covered — client must refetch
    assert.deepEqual(b, []);        // never replay a hole silently
  });

  it('legacy reconnect (no since): false exactly when events were missed offline', () => {
    const wm = createWatchManager();
    wm.connect('c1', 'u1', () => {});
    wm.watch('u1', ['/a']);
    wm.disconnect('c1');
    assert.equal(wm.connect('c2', 'u1', () => {}).preserved, true); // nothing missed

    wm.disconnect('c2');
    wm.notify(setEvent('/a')); // missed while offline
    assert.equal(wm.connect('c3', 'u1', () => {}).preserved, false); // old preserved:true lie is gone
  });

  it('multi-tab: shared seq stream; resuming tab replays only to itself', () => {
    const wm = createWatchManager();
    const tab1: NodeEvent[] = [];
    const tab2: StampedEvent[] = [];
    wm.connect('c1', 'u1', (e) => tab1.push(e.event));
    wm.connect('c2', 'u1', (e) => tab2.push(e.event));
    wm.watch('u1', ['/a']);
    wm.notify(setEvent('/a')); // seq 1 → both tabs
    const cursor = cursorOf(tab2[0]);
    wm.disconnect('c2');
    wm.notify(setEvent('/a')); // seq 2 → tab1 only (user online — not "missed")

    const tab2b: NodeEvent[] = [];
    const { preserved } = wm.connect('c2b', 'u1', (e) => tab2b.push(e.event), cursor);
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
    wm.connect('cB', 'u1', (e) => b.push(e.event));
    wm.watch('u1', ['/doc']);
    for (let i = 0; i < 5; i++) wm.notify(setEvent('/doc')); // both tabs at seq 5
    const staleCursor = cursorOf(b[4]);
    wm.disconnect('cA');
    wm.disconnect('cB');
    t.mock.timers.tick(100); // grace expires → entry (and its seq space) is gone

    // Tab A returns first: honest refetch, re-registers, the NEW entry counts 1..3.
    assert.equal(wm.connect('cA2', 'u1', () => {}).preserved, false);
    wm.watch('u1', ['/doc']);
    wm.notify(setEvent('/doc'));
    wm.notify(setEvent('/doc'));
    wm.notify(setEvent('/doc'));

    // Tab B resumes with its pre-sleep cursor: seq 5 >= 3 numerically — the
    // old seq-only compare answered covered=true and B silently kept a cache
    // missing EVERYTHING (including removes). Epoch mismatch refuses it.
    const b2: NodeEvent[] = [];
    assert.equal(wm.connect('cB2', 'u1', (e) => b2.push(e.event), staleCursor).preserved, false);
    assert.deepEqual(b2, []);
  });

  it('cursor without epoch (legacy bare number) fails closed even when seq looks covered', () => {
    const wm = createWatchManager();
    wm.connect('c1', 'u1', () => {});
    wm.watch('u1', ['/a']);
    wm.notify(setEvent('/a'));
    wm.notify(setEvent('/a'));
    wm.disconnect('c1');

    assert.equal(wm.connect('c2', 'u1', () => {}, 2).preserved, false);
  });

  it('cursor ahead of the stream under the live epoch fails closed (corrupt client)', () => {
    const wm = createWatchManager();
    const a: StampedEvent[] = [];
    wm.connect('c1', 'u1', (e) => a.push(e.event));
    wm.watch('u1', ['/a']);
    wm.notify(setEvent('/a'));
    const { epoch } = cursorOf(a[0]);
    wm.disconnect('c1');

    assert.equal(wm.connect('c2', 'u1', () => {}, { seq: 99, epoch }).preserved, false);
  });
});

describe('WatchManager — external continuity break (core-anz4.11)', () => {
  const setEvent = (path: string): NodeEvent => ({ type: 'set', path, node: { $type: 't' } });

  it('external reconnect{preserved:false} invalidates every pre-break cursor', () => {
    const wm = createWatchManager({ gracePeriodMs: 10_000 });
    const a: StampedEvent[] = [];
    wm.connect('c1', 'u1', (e) => a.push(e.event));
    wm.watch('u1', ['/doc']);
    wm.notify(setEvent('/doc'));
    const preBreak = cursorOf(a[0]);
    wm.disconnect('c1');

    // The signal external-watch forwards on a change-stream error / fs-watcher
    // drop — previously broadcast-only, invisible to the seq/ring accounting.
    wm.notify({ type: 'reconnect', preserved: false });

    const replayed: NodeEvent[] = [];
    assert.equal(wm.connect('c2', 'u1', (e) => replayed.push(e.event), preBreak).preserved, false);
    assert.deepEqual(replayed, []);
  });

  it('live client adopts the post-break epoch from the stamped reset and resumes covered later', () => {
    const wm = createWatchManager({ gracePeriodMs: 10_000 });
    const a: StampedEvent[] = [];
    wm.connect('c1', 'u1', (e) => a.push(e.event));
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
    assert.equal(wm.connect('c2', 'u1', (e) => b.push(e.event), head).preserved, true);
    assert.deepEqual(b, []);
  });

  it('preserved:true reconnect is informational — continuity (and epoch) intact', () => {
    const wm = createWatchManager({ gracePeriodMs: 10_000 });
    const a: StampedEvent[] = [];
    wm.connect('c1', 'u1', (e) => a.push(e.event));
    wm.watch('u1', ['/doc']);
    wm.notify(setEvent('/doc'));
    const cursor = cursorOf(a[0]);

    wm.notify({ type: 'reconnect', preserved: true });
    wm.disconnect('c1');

    assert.equal(wm.connect('c2', 'u1', () => {}, cursor).preserved, true);
  });

  it('break while offline: legacy no-cursor reconnect is answered false (missedOffline)', () => {
    const wm = createWatchManager({ gracePeriodMs: 10_000 });
    wm.connect('c1', 'u1', () => {});
    wm.watch('u1', ['/doc']);
    wm.disconnect('c1');

    wm.notify({ type: 'reconnect', preserved: false });

    assert.equal(wm.connect('c2', 'u1', () => {}).preserved, false);
  });
});

describe('WatchManager — token-scoped watch ownership (core-anz4.12)', () => {
  const setEvent = (path: string): NodeEvent => ({ type: 'set', path, node: { $type: 't' } });

  it('two consumers, same user+path: first release keeps the second receiving', () => {
    const wm = createWatchManager();
    const got: NodeEvent[] = [];
    wm.connect('c1', 'u1', (e) => got.push(e.event), undefined, 't1');
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
      watchQuery: () => null,
      unwatchQuery: (vp) => unwatchedQueries.push(vp),
      unwatchAllQueries: () => {},
    });
    const got: NodeEvent[] = [];
    wm.connect('c1', 'u1', (e) => got.push(e.event));
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
    wm.connect('c2', 'u1', (e) => got.push(e.event), undefined, 't2');
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
    wm.connect('cKeep', 'u1', (e) => got.push(e.event), undefined, 'tKeep'); // keeps the user entry alive
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
    wm.connect('c2', 'u1', (e) => got.push(e.event), undefined, 't2');
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

// ── ns6p.4 slice 1: connect verdict {seq, epoch} + route provenance ──

describe('WatchManager — connect verdict + route envelope (ns6p.4 slice 1)', () => {
  const setEvent = (path: string, extra?: { invalidateVps?: string[] }): NodeEvent =>
    ({ type: 'set', path, node: { $type: 't' }, ...extra });

  it('connect verdict carries the current {seq, epoch} — the lane can stamp its initial frame', () => {
    const wm = createWatchManager();
    const a: StampedEvent[] = [];
    const v0 = wm.connect('c1', 'u1', (e) => a.push(e.event));
    assert.equal(v0.preserved, false, 'fresh user — nothing preserved by definition');
    assert.equal(v0.seq, 0);
    assert.equal(typeof v0.epoch, 'string');

    wm.watch('u1', ['/a']);
    wm.notify(setEvent('/a')); // seq 1
    assert.equal(a[0].epoch, v0.epoch, 'verdict epoch IS the stream epoch events are stamped with');

    const v1 = wm.connect('c2', 'u1', () => {});
    assert.equal(v1.seq, 1, 'verdict reports the current watermark');
    assert.equal(v1.epoch, v0.epoch);
  });

  it('exact holder: envelope names the held path; vp-only recipient: vps only, never the path (security pin)', () => {
    const wm = createWatchManager();
    const exact: RouteEnvelope[] = [];
    const vpOnly: RouteEnvelope[] = [];
    wm.connect('cE', 'uExact', (env) => exact.push(env));
    wm.connect('cV', 'uVp', (env) => vpOnly.push(env));
    wm.watch('uExact', ['/data/x']);
    wm.watch('uVp', ['/views/q'], { children: true });

    wm.notify(setEvent('/data/x', { invalidateVps: ['/views/q'] }));

    assert.equal(exact.length, 1);
    assert.deepEqual(exact[0].heldPaths, ['/data/x']);
    assert.deepEqual(exact[0].heldVps, []);
    assert.equal(vpOnly.length, 1);
    assert.deepEqual(vpOnly[0].heldPaths, [], 'vp-only recipient must never learn the source path');
    assert.deepEqual(vpOnly[0].heldVps, ['/views/q']);
  });

  it('prefix-parent holder: envelope names the held parent as a vp (refetch the listing, not the child)', () => {
    const wm = createWatchManager();
    const got: RouteEnvelope[] = [];
    wm.connect('c1', 'u1', (env) => got.push(env));
    wm.watch('u1', ['/dir'], { children: true });

    wm.notify(setEvent('/dir/a'));

    assert.equal(got.length, 1);
    assert.deepEqual(got[0].heldPaths, []);
    assert.deepEqual(got[0].heldVps, ['/dir']);
  });

  it('exact + prefix + vp holder: one delivery, envelope carries every matched route', () => {
    const wm = createWatchManager();
    const got: RouteEnvelope[] = [];
    wm.connect('c1', 'u1', (env) => got.push(env));
    wm.watch('u1', ['/dir/a']);
    wm.watch('u1', ['/dir'], { children: true });
    wm.watch('u1', ['/views/q'], { children: true });

    wm.notify(setEvent('/dir/a', { invalidateVps: ['/views/q'] }));

    assert.equal(got.length, 1, 'dedup: one push per recipient');
    assert.deepEqual(got[0].heldPaths, ['/dir/a']);
    assert.deepEqual(got[0].heldVps.slice().sort(), ['/dir', '/views/q']);
  });

  it('membership audience: flipped user gets the vp (and its heldVps); a co-watcher outside the audience is untouched by it (anz4.27)', () => {
    const wm = createWatchManager();
    const a: RouteEnvelope[] = [];
    const b: RouteEnvelope[] = [];
    wm.connect('cA', 'uA', (env) => a.push(env));
    wm.connect('cB', 'uB', (env) => b.push(env));
    wm.watch('uA', ['/views/q'], { children: true });
    wm.watch('uB', ['/views/q'], { children: true });
    wm.watch('uB', ['/data/x']); // second route — makes uB's narrowed copy observable

    wm.notify({
      type: 'set', path: '/data/x', node: { $type: 't' },
      invalidateVps: ['/views/q'],
      membershipAudience: new Map([['/views/q', new Set(['uA'])]]),
    });

    assert.equal(a.length, 1);
    assert.ok(a[0].event.invalidateVps?.includes('/views/q'));
    assert.deepEqual(a[0].heldVps, ['/views/q'], 'flipped user\'s provenance names the vp');
    assert.equal(a[0].event.membershipAudience, undefined, 'audience is routing-internal — never stamped');

    assert.equal(b.length, 1, 'uB still delivered via his exact route');
    assert.equal(b[0].event.invalidateVps, undefined, 'membership vp outside the audience narrowed out (invariant 26)');
    assert.deepEqual(b[0].heldVps, [], 'heldVps narrows with it');
    assert.deepEqual(b[0].heldPaths, ['/data/x']);
  });

  it('membership audience as the ONLY route: a co-watcher outside it gets no push at all (anz4.27)', () => {
    const wm = createWatchManager();
    const b: RouteEnvelope[] = [];
    wm.connect('cB', 'uB', (env) => b.push(env));
    wm.watch('uB', ['/views/q'], { children: true });

    wm.notify({
      type: 'set', path: '/data/x', node: { $type: 't' },
      invalidateVps: ['/views/q'],
      membershipAudience: new Map([['/views/q', new Set(['uA'])]]),
    });
    assert.equal(b.length, 0, 'the flip is invisible to uB\'s projection — no dirty, no oracle');

    // Same vp WITHOUT an audience entry = coarse source → broadcast (§6.3).
    wm.notify({ type: 'set', path: '/data/x', node: { $type: 't' }, invalidateVps: ['/views/q'] });
    assert.equal(b.length, 1);
    assert.ok(b[0].event.invalidateVps?.includes('/views/q'));
  });

  it('ring replay delivers the FROZEN envelope — a hold released in the gap does not rewrite provenance', () => {
    const wm = createWatchManager({ gracePeriodMs: 10_000 });
    const live: RouteEnvelope[] = [];
    wm.connect('c1', 'u1', (env) => live.push(env));
    wm.watch('u1', ['/data/x']);
    wm.notify(setEvent('/data/x')); // seq 1 — live
    const cursor = cursorOf(live[0].event);
    wm.disconnect('c1');

    wm.notify(setEvent('/data/x')); // seq 2 — ringed WITH heldPaths
    wm.unwatch('u1', ['/data/x']);  // hold released AFTER the event, BEFORE resume

    const replayed: RouteEnvelope[] = [];
    const verdict = wm.connect('c2', 'u1', (env) => replayed.push(env), cursor);
    assert.equal(verdict.preserved, true);
    assert.equal(replayed.length, 1);
    assert.deepEqual(replayed[0].heldPaths, ['/data/x'], 'provenance frozen at routing time, never recomputed');
    assert.equal(replayed[0].event.seq, 2);
  });

  it('reconnect events carry an empty envelope — no provenance to leak', () => {
    const wm = createWatchManager();
    const got: RouteEnvelope[] = [];
    wm.connect('c1', 'u1', (env) => got.push(env));
    wm.watch('u1', ['/a']);

    wm.notify({ type: 'reconnect', preserved: true });
    wm.breakContinuity();

    assert.equal(got.length, 2);
    for (const env of got) {
      assert.equal(env.event.type, 'reconnect');
      assert.deepEqual(env.heldPaths, []);
      assert.deepEqual(env.heldVps, []);
    }
  });
});

// ── ns6p.4 slice 2: registration lease (invariant 15) ──

describe('WatchManager — registration lease (ns6p.4 slice 2)', () => {
  const setEvent = (path: string): NodeEvent => ({ type: 'set', path, node: { $type: 't' } });

  it('undo of a re-registration keeps the pre-existing hold under the SAME token', () => {
    const wm = createWatchManager();
    const got: NodeEvent[] = [];
    wm.connect('c1', 'u1', (e) => got.push(e.event), undefined, 't1');
    wm.watch('u1', ['/doc'], { token: 't1' });

    // Failed request path: the re-registration is compensated — the tab's
    // ORIGINAL hold must survive (bare unwatch would strip it, F4-r1).
    const lease = wm.watch('u1', ['/doc'], { token: 't1' });
    assert.deepEqual(lease.created, [], 're-registration created nothing');
    lease.undo();

    wm.notify(setEvent('/doc'));
    assert.equal(got.length, 1, 'pre-existing hold survives the undo');
  });

  it('undo drops only holds this call created; a co-holder keeps the registration', () => {
    const wm = createWatchManager();
    const got: NodeEvent[] = [];
    wm.connect('c2', 'u1', (e) => got.push(e.event), undefined, 't2');
    wm.watch('u1', ['/shared'], { token: 't2' });

    const lease = wm.watch('u1', ['/shared', '/mine'], { token: 't1' });
    assert.deepEqual(
      lease.created.map((c) => c.path).sort(),
      ['/mine', '/shared'],
      'both HOLDS are new for t1 even though /shared registration pre-exists',
    );
    lease.undo();

    wm.notify(setEvent('/shared'));
    assert.equal(got.length, 1, 'co-held registration survives');
    wm.notify(setEvent('/mine'));
    assert.equal(got.length, 1, 'created-and-undone hold is gone');
  });

  it('undo is idempotent and frees the budget slot of a created hold', () => {
    const wm = createWatchManager({ maxWatchesPerUser: 1 });
    wm.connect('c1', 'u1', () => {}, undefined, 't1');
    const lease = wm.watch('u1', ['/a'], { token: 't1' });

    lease.undo();
    lease.undo(); // second undo must not underflow

    wm.watch('u1', ['/b'], { token: 't1' }); // slot freed exactly once
    assert.throws(() => wm.watch('u1', ['/c'], { token: 't1' }));
  });

  it('undo of a second-plan registration releases only its own handle — the prior plan keeps evaluating (E03 → coexistence)', async () => {
    const store = createMemoryTree();
    const events: NodeEvent[] = [];
    const { tree, cdc } = withSubscriptions(store, (e) => events.push(e), {
      projectMembership: async (_u, o, n) => [o, n],
    });
    const wm = createWatchManager();
    wm.bindQueryRegistry(cdc);
    wm.connect('c1', 'u1', () => {}, undefined, 't1');
    await tree.set(createNode('/data', 'dir'));

    const planA = { plan: { source: '/data', callerWhere: { kind: 'a' } }, mountDeps: new Set(['/view']) };
    const planB = { plan: { source: '/data', callerWhere: { kind: 'b' } }, mountDeps: new Set(['/view']) };
    wm.watch('u1', ['/view'], { children: true, query: planA, token: 't1' });

    const lease = wm.watch('u1', ['/view'], { children: true, query: planB, token: 't1' });
    assert.equal(cdc.getActiveQueryCount(), 2, 'different plan on the same vp COEXISTS (ns6p.4 §4.2)');
    assert.deepEqual(lease.replaced, [{ vp: '/view', prev: null }], 'coexistence: nothing was replaced');
    lease.undo();
    assert.equal(cdc.getActiveQueryCount(), 1, 'undo released only the lease\'s own plan handle');

    events.length = 0;
    await tree.set(createNode('/data/x', 'item', { kind: 'a' })); // member of plan A only
    const ev = events.find((e) => e.type === 'set' && e.path === '/data/x');
    assert.ok(ev?.invalidateVps?.includes('/view'), 'prior plan untouched by the undo');

    events.length = 0;
    await tree.set(createNode('/data/y', 'item', { kind: 'b' })); // member of plan B only
    const evB = events.find((e) => e.type === 'set' && e.path === '/data/y');
    assert.ok(!evB?.invalidateVps?.includes('/view'), 'undone plan no longer evaluates');
  });

  it('same-plan re-registration refreshes the handle; undo restores it (deps-restore path survives coexistence)', async () => {
    const store = createMemoryTree();
    const { cdc } = withSubscriptions(store, undefined, {
      projectMembership: async (_u, o, n) => [o, n],
    });
    const wm = createWatchManager();
    wm.bindQueryRegistry(cdc);
    wm.connect('c1', 'u1', () => {}, undefined, 't1');

    const query = { plan: { source: '/data', callerWhere: { kind: 'a' } }, mountDeps: new Set(['/view']) };
    wm.watch('u1', ['/view'], { children: true, query, token: 't1' });

    const lease = wm.watch('u1', ['/view'], { children: true, query, token: 't1' });
    assert.equal(lease.replaced.length, 1);
    assert.ok(lease.replaced[0].prev, 'same plan re-registered — prior registration captured for restore');
    lease.undo();
    assert.equal(cdc.getActiveQueryCount(), 1, 'the original registration survives the undo');
  });

  it('undo of a FRESH query registration removes the handle with the hold', async () => {
    const store = createMemoryTree();
    const { cdc } = withSubscriptions(store, undefined, {
      projectMembership: async (_u, o, n) => [o, n],
    });
    const wm = createWatchManager();
    wm.bindQueryRegistry(cdc);
    wm.connect('c1', 'u1', () => {}, undefined, 't1');

    const lease = wm.watch('u1', ['/view'], {
      children: true,
      query: { plan: { source: '/data', callerWhere: { open: true } }, mountDeps: new Set(['/view']) },
      token: 't1',
    });
    assert.deepEqual(lease.replaced, [{ vp: '/view', prev: null }]);
    assert.equal(cdc.getActiveQueryCount(), 1);

    lease.undo();
    assert.equal(cdc.getActiveQueryCount(), 0, 'no stale handle behind a released hold');
  });

  it('partial multi-vp failure rolls the earlier vp back — fresh registration removed, replaced plan restored', async () => {
    const store = createMemoryTree();
    const { tree, cdc } = withSubscriptions(store, undefined, {
      projectMembership: async (_u, o, n) => [o, n],
    });
    await tree.set(createNode('/d', 'dir'));
    const wm = createWatchManager();
    // Wrap the real registry: /v2 refuses (as a validator would), the rest
    // flows through so rollback effects are observable on real state.
    wm.bindQueryRegistry({
      watchQuery: (reg) => {
        if (reg.vp === '/v2') throw new Error('refused');
        return cdc.watchQuery(reg);
      },
      unwatchQuery: (vp, userId, hash) => cdc.unwatchQuery(vp, userId, hash),
      unwatchAllQueries: (userId) => cdc.unwatchAllQueries(userId),
    });
    wm.connect('c1', 'u1', () => {}, undefined, 't1');

    assert.throws(() =>
      wm.watch('u1', ['/v1', '/v2'], {
        children: true,
        query: { plan: { source: '/d', callerWhere: { x: 1 } }, mountDeps: new Set(['/v1']) },
        token: 't1',
      }),
    );
    assert.equal(cdc.getActiveQueryCount(), 0, '/v1 fresh registration rolled back, nothing leaked');
  });
});

// ── ns6p.4 slice 2: unbound-token TTL (invariant 25) ──

describe('WatchManager — unbound-token TTL (ns6p.4 slice 2)', () => {
  const setEvent = (path: string): NodeEvent => ({ type: 'set', path, node: { $type: 't' } });

  it('registration without a lane expires: holdings released, late connect fails closed despite a covering cursor', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const wm = createWatchManager({ unboundTokenTtlMs: 1000, gracePeriodMs: 100 });
    const other: StampedEvent[] = [];
    // Another tab keeps the user entry alive — the exact leak scenario (F7-r2).
    wm.connect('cOther', 'u1', (e) => other.push(e.event), undefined, 'tOther');
    wm.watch('u1', ['/doc'], { token: 'tGhost' }); // registered, never connects

    wm.notify(setEvent('/doc')); // routes via tGhost's hold to the user's lanes
    assert.equal(other.length, 1, 'holding alive before expiry');
    const head = cursorOf(other[0]);

    t.mock.timers.tick(1000);

    wm.notify(setEvent('/doc'));
    assert.equal(other.length, 1, 'ghost holdings released at expiry');

    // Head cursor would prove coverage — the tombstone must override it:
    // events after expiry were unrouted, so continuity is a lie.
    const verdict = wm.connect('cGhost', 'u1', () => {}, head, 'tGhost');
    assert.equal(verdict.preserved, false, 'expiry is a continuity break — tombstoned token fails closed');

    // Tombstone consumed exactly once: reconnect with the head cursor now
    // judges continuity honestly again.
    wm.disconnect('cGhost');
    const again = wm.connect('cGhost2', 'u1', () => {}, { seq: verdict.seq, epoch: verdict.epoch }, 'tGhost');
    assert.equal(again.preserved, true);
  });

  it('connect before expiry cancels the TTL — holdings survive past the deadline', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const wm = createWatchManager({ unboundTokenTtlMs: 1000 });
    const got: NodeEvent[] = [];
    wm.watch('u1', ['/doc'], { token: 't1' });

    t.mock.timers.tick(500);
    const verdict = wm.connect('c1', 'u1', (e) => got.push(e.event), undefined, 't1');
    t.mock.timers.tick(1000); // past the original deadline

    wm.notify(setEvent('/doc'));
    assert.equal(got.length, 1, 'first connect disarmed the TTL');
    assert.equal(verdict.preserved, true, 'no tombstone — sole lane, nothing missed');
  });

  it('removeUser clears armed TTL timers — the stale deadline cannot strip a re-created registration', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const removed: string[] = [];
    const wm = createWatchManager({ unboundTokenTtlMs: 1000, gracePeriodMs: 100, onUserRemoved: (u) => removed.push(u) });
    wm.watch('u1', ['/doc'], { token: 'tGhost' }); // TTL armed at 0ms, never connects

    // A different tab's lane comes and goes → user-grace removes the entry;
    // the armed ghost TTL must die with it (mirror of tokenGrace clearing).
    wm.connect('c1', 'u1', () => {}, undefined, 't1');
    wm.disconnect('c1');
    t.mock.timers.tick(100); // user-grace fires → removeUser
    assert.deepEqual(removed, ['u1']);

    // Same user+token re-register under a fresh entry; the ORIGINAL 1000ms
    // deadline passes — it must neither release the new hold nor tombstone.
    const got: NodeEvent[] = [];
    wm.watch('u1', ['/doc'], { token: 'tGhost' });
    wm.connect('c2', 'u1', (e) => got.push(e.event), undefined, 'tGhost');
    t.mock.timers.tick(1000);

    wm.notify(setEvent('/doc'));
    assert.equal(got.length, 1, 'stale TTL deadline caused no damage to the re-created state');
  });

  it('LEGACY (tokenless) registrations never TTL — they live on user-grace alone', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const wm = createWatchManager({ unboundTokenTtlMs: 1000 });
    const got: NodeEvent[] = [];
    wm.watch('u1', ['/doc']); // legacy shared hold, no lane

    t.mock.timers.tick(5000);

    wm.connect('c1', 'u1', (e) => got.push(e.event));
    wm.notify(setEvent('/doc'));
    assert.equal(got.length, 1, 'legacy hold survived — no TTL, no tombstone');
  });

  it('TTL arms once per token — a later registration does not extend the deadline', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const wm = createWatchManager({ unboundTokenTtlMs: 1000 });
    const other: NodeEvent[] = [];
    wm.connect('cOther', 'u1', (e) => other.push(e.event), undefined, 'tOther');
    wm.watch('u1', ['/a'], { token: 'tGhost' });

    t.mock.timers.tick(900);
    wm.watch('u1', ['/b'], { token: 'tGhost' }); // must NOT re-arm
    t.mock.timers.tick(100); // original deadline

    assert.equal(wm.connect('cG', 'u1', () => {}, undefined, 'tGhost').preserved, false,
      'deadline counted from the FIRST laneless registration');
  });
});

// ── ns6p.4 slice 4: provisional prefix hold (invariant 27) ──

describe('WatchManager — provisional prefix hold (ns6p.4 slice 4)', () => {
  const setEvent = (path: string): NodeEvent => ({ type: 'set', path, node: { $type: 't' } });

  it('routes children while held; release is idempotent and frees the budget slot', () => {
    const wm = createWatchManager({ maxWatchesPerUser: 1 });
    const got: NodeEvent[] = [];
    wm.connect('c1', 'u1', (e) => got.push(e.event), undefined, 'tab');

    const release = wm.holdPrefix('u1', '/dir');
    wm.notify(setEvent('/dir/x'));
    assert.equal(got.length, 1, 'children routed under the provisional hold');

    release();
    release(); // idempotent — double release must not underflow
    wm.notify(setEvent('/dir/y'));
    assert.equal(got.length, 1, 'released — routing stopped');
    // Budget of 1 free again — a leaked provisional would throw here.
    wm.watch('u1', ['/other'], { children: true, token: 'tab' });
  });

  it('two concurrent holds on one path are independent holders — first release keeps coverage (r3-F3)', () => {
    const wm = createWatchManager();
    const got: NodeEvent[] = [];
    wm.connect('c1', 'u1', (e) => got.push(e.event), undefined, 'tab');

    const relA = wm.holdPrefix('u1', '/dir');
    const relB = wm.holdPrefix('u1', '/dir');
    relA();
    wm.notify(setEvent('/dir/x'));
    assert.equal(got.length, 1, "A's release must not strip B's coverage");

    relB();
    wm.notify(setEvent('/dir/y'));
    assert.equal(got.length, 1, 'last holder released — registration gone');
  });

  it('provisional holders never arm the unbound-token TTL', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const wm = createWatchManager({ unboundTokenTtlMs: 1000 });
    const got: NodeEvent[] = [];
    wm.connect('cOther', 'u1', (e) => got.push(e.event), undefined, 'tOther');

    const release = wm.holdPrefix('u1', '/dir'); // held past the TTL deadline
    t.mock.timers.tick(1000);
    wm.notify(setEvent('/dir/x'));
    assert.equal(got.length, 1, 'no TTL fired — the hold outlived the laneless-token deadline');
    release();
  });

  it('connect rejects the reserved provisional namespace', () => {
    const wm = createWatchManager();
    assert.throws(() => wm.connect('c1', 'u1', () => {}, undefined, '\0prov:1'));
  });
});
