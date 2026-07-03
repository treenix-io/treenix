import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type NodeEvent } from './index';
import { createWatchManager } from './watch';

describe('WatchManager', () => {
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

  it('resume with since replays the reset from the ring (continuity holds THROUGH the reset)', () => {
    const wm = createWatchManager({ gracePeriodMs: 10_000 });
    const before: NodeEvent[] = [];
    wm.connect('c1', 'u1', (e) => before.push(e));
    wm.watch('u1', ['/doc']);
    wm.notify({ type: 'set', path: '/doc', node: { $path: '/doc', $type: 'doc' } });
    const first = before[0];
    assert.ok(first.type === 'set' && first.seq !== undefined);
    const lastSeq = first.seq;
    wm.disconnect('c1');

    wm.breakContinuity();

    const replayed: NodeEvent[] = [];
    const covered = wm.connect('c2', 'u1', (e) => replayed.push(e), lastSeq);
    assert.equal(covered, true, 'ring covers the gap — the reset itself is delivered');
    assert.equal(replayed.length, 1);
    assert.equal(replayed[0].type, 'reconnect');
    assert.equal((replayed[0] as { preserved?: boolean }).preserved, false);
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

  it('connect(since) replays grace-window events — preserved means continuity', () => {
    const wm = createWatchManager();
    const a: NodeEvent[] = [];
    wm.connect('c1', 'u1', (e) => a.push(e));
    wm.watch('u1', ['/a']);
    wm.notify(setEvent('/a')); // seq 1, delivered live
    wm.disconnect('c1');
    wm.notify(setEvent('/a')); // seq 2 — offline, ringed
    wm.notify(setEvent('/a')); // seq 3 — offline, ringed

    const b: NodeEvent[] = [];
    const preserved = wm.connect('c2', 'u1', (e) => b.push(e), 1);
    assert.equal(preserved, true);
    assert.deepEqual(b.map(seqOf), [2, 3]); // exactly the gap, in order
  });

  it('ring overflow → preserved false, no partial replay', () => {
    const wm = createWatchManager({ ringSize: 2 });
    wm.connect('c1', 'u1', () => {});
    wm.watch('u1', ['/a']);
    wm.notify(setEvent('/a')); // seq 1
    wm.disconnect('c1');
    wm.notify(setEvent('/a')); // 2
    wm.notify(setEvent('/a')); // 3
    wm.notify(setEvent('/a')); // 4 — ring now [3,4], seq 2 evicted

    const b: NodeEvent[] = [];
    const preserved = wm.connect('c2', 'u1', (e) => b.push(e), 1);
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
    const tab2: NodeEvent[] = [];
    wm.connect('c1', 'u1', (e) => tab1.push(e));
    wm.connect('c2', 'u1', (e) => tab2.push(e));
    wm.watch('u1', ['/a']);
    wm.notify(setEvent('/a')); // seq 1 → both tabs
    wm.disconnect('c2');
    wm.notify(setEvent('/a')); // seq 2 → tab1 only (user online — not "missed")

    const tab2b: NodeEvent[] = [];
    const preserved = wm.connect('c2b', 'u1', (e) => tab2b.push(e), 1);
    assert.equal(preserved, true);
    assert.deepEqual(tab2b.map(seqOf), [2]); // replayed to the new tab
    assert.deepEqual(tab1.map(seqOf), [1, 2]); // no duplicates to the live tab
  });
});
