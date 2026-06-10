import { A, createNode, getComponentByName, R, type NodeData } from '#core';
import { userIdFromAuthPath } from '#security/auth';
import { createMemoryTree } from '#tree';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type NodeEvent, type SubscriptionOpts, withSubscriptions } from './index';
import { createWatchManager } from './watch';

// Production detectors are layer-injected (gk8.12) — tests wire the real ones.
const detectors: SubscriptionOpts = {
  claimsUserOf: userIdFromAuthPath,
  isConfigNode: (node: NodeData | null | undefined) => !!node && getComponentByName(node, 'mount') !== undefined,
};

describe('Subscriptions', () => {
  it('emits on set (children)', async () => {
    const { tree, cdc } = withSubscriptions(createMemoryTree());
    const events: NodeEvent[] = [];
    cdc.subscribe('/bot', (e) => events.push(e), { children: true });

    await tree.set(createNode('/bot/commands/start', 'page'));
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'set');
    assert.equal(events[0].path, '/bot/commands/start');
  });

  it('emits on remove (children)', async () => {
    const { tree, cdc } = withSubscriptions(createMemoryTree());
    const events: NodeEvent[] = [];
    await tree.set(createNode('/bot/x', 'page'));
    cdc.subscribe('/bot', (e) => events.push(e), { children: true });
    await tree.remove('/bot/x');
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'remove');
  });

  it('does not emit for unrelated paths', async () => {
    const { tree, cdc } = withSubscriptions(createMemoryTree());
    const events: NodeEvent[] = [];
    cdc.subscribe('/bot', (e) => events.push(e), { children: true });
    await tree.set(createNode('/users/1', 'user'));
    assert.equal(events.length, 0);
  });

  it('emits for exact path match', async () => {
    const { tree, cdc } = withSubscriptions(createMemoryTree());
    const events: NodeEvent[] = [];
    cdc.subscribe('/bot', (e) => events.push(e));
    await tree.set(createNode('/bot', 'bot'));
    assert.equal(events.length, 1);
  });

  it('unsubscribe stops events (children)', async () => {
    const { tree, cdc } = withSubscriptions(createMemoryTree());
    const events: NodeEvent[] = [];
    const unsub = cdc.subscribe('/bot', (e) => events.push(e), { children: true });
    await tree.set(createNode('/bot/x', 'page'));
    assert.equal(events.length, 1);
    unsub();
    await tree.set(createNode('/bot/y', 'page'));
    assert.equal(events.length, 1);
  });

  it('set with changed field emits computed patch', async () => {
    const { tree, cdc } = withSubscriptions(createMemoryTree());
    const events: NodeEvent[] = [];
    await tree.set({ ...createNode('/x', 'test'), foo: 'old' });
    cdc.subscribe('/x', (e) => events.push(e));

    // Client set: no patches → sub.ts computes diff via fast-json-patch
    await tree.set({ ...createNode('/x', 'test'), foo: 'new' });

    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'patch');
    if (events[0].type === 'patch') {
      const fooOp = events[0].patches.find(p => p[1] === 'foo');
      assert.ok(fooOp);
      assert.equal(fooOp[0], 'r');
      assert.equal(fooOp[2], 'new');
    }
  });

  it('string $patches are stripped and ignored — injection blocked', async () => {
    const { tree, cdc } = withSubscriptions(createMemoryTree());
    const events: NodeEvent[] = [];
    await tree.set({ ...createNode('/x', 'test'), amount: 100 });
    cdc.subscribe('/x', (e) => events.push(e));

    // Simulate client injection: string $patches with fake values
    const node: any = { ...createNode('/x', 'test'), amount: 200 };
    node.$patches = [{ op: 'replace', path: ['amount'], value: 0 }];
    await tree.set(node);

    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'patch');
    if (events[0].type === 'patch') {
      const amountOp = events[0].patches.find(p => p[1] === 'amount');
      assert.ok(amountOp);
      // Computed diff shows the REAL value (200), not the injected fake (0)
      assert.equal(amountOp[2], 200);
    }
  });

  it('string $patches are not persisted to storage', async () => {
    const mem = createMemoryTree();
    const { tree } = withSubscriptions(mem);

    const node: any = { ...createNode('/x', 'test'), foo: 'bar' };
    node.$patches = [{ op: 'replace', path: ['foo'], value: 'FAKE' }];
    await tree.set(node);

    const stored = await mem.get('/x');
    assert.ok(stored);
    assert.equal('$patches' in stored, false, '$patches should not be stored');
  });

  it('updates query watch match when vp and source stay the same', async () => {
    const events: NodeEvent[] = [];
    const { tree, cdc } = withSubscriptions(createMemoryTree(), e => events.push(e));

    cdc.watchQuery('/views/status', '/items', { status: 'open' }, 'u1');
    cdc.watchQuery('/views/status', '/items', { status: 'closed' }, 'u1');

    await tree.set({ $path: '/items/1', $type: 'item', status: 'closed' });

    const event = events.find(e => e.type === 'set' && e.path === '/items/1');
    assert.ok(event);
    if (event.type !== 'set') throw new Error('expected set event');
    // Membership flip against the UPDATED match → coarse dirty (gk8.12).
    assert.deepEqual(event.invalidateVps, ['/views/status']);
  });

  it('coarse dirty reaches every vp watcher — visibility resolves on the read path (gk8.12)', async () => {
    const watcher = createWatchManager();
    const { tree, cdc } = withSubscriptions(createMemoryTree(), e => watcher.notify(e));
    const legacyEvents: NodeEvent[] = [];
    const memberEvents: NodeEvent[] = [];
    const anonEvents: NodeEvent[] = [];

    watcher.connect('legacy-conn', 'legacy', e => legacyEvents.push(e));
    watcher.connect('member-conn', 'member', e => memberEvents.push(e));
    watcher.connect('anon-conn', 'anon', e => anonEvents.push(e));
    watcher.watch('legacy', ['/views/open'], { children: true });
    watcher.watch('member', ['/views/open'], { children: true });
    watcher.watch('anon', ['/views/open'], { children: true });

    await tree.set({ ...createNode('/', 'root'), $acl: [{ g: 'public', p: R | A }] });
    await tree.set({ ...createNode('/items', 'dir'), $acl: [{ g: 'public', p: R }] });

    cdc.watchQuery('/views/open', '/items', { status: 'open' }, 'legacy');
    cdc.watchQuery('/views/open', '/items', { status: 'open' }, 'member');
    cdc.watchQuery('/views/open', '/items', { status: 'open' }, 'anon');

    await tree.set({
      ...createNode('/items/1', 'item'),
      status: 'open',
      $acl: [{ g: 'public', p: 0 }, { g: 'authenticated', p: R }],
    });

    // No per-user prediction on the write path: every vp watcher gets the
    // dirty signal (anon included) and re-derives visibility via refetch.
    assert.equal(legacyEvents.length, 1);
    assert.equal(memberEvents.length, 1);
    assert.equal(anonEvents.length, 1);
    for (const e of [legacyEvents[0], memberEvents[0], anonEvents[0]]) {
      assert.equal(e.type, 'set');
      if (e.type !== 'set') throw new Error('expected set event');
      assert.ok(e.invalidateVps?.includes('/views/open'));
    }
  });
});

describe('ACL change invalidation (Stage 6)', () => {
  it('$acl change on the query source path → invalidateVps', async () => {
    const events: NodeEvent[] = [];
    const { tree, cdc } = withSubscriptions(createMemoryTree(), e => events.push(e));

    await tree.set(createNode('/items', 'dir'));
    cdc.watchQuery('/views/open', '/items', { status: 'open' }, 'u1');
    events.length = 0;

    await tree.set({
      ...createNode('/items', 'dir'),
      $acl: [{ g: 'authenticated', p: R }],
    });

    const aclEvent = events.find(e =>
      (e.type === 'set' || e.type === 'patch') && e.path === '/items');
    assert.ok(aclEvent);
    assert.deepEqual(
      aclEvent.type === 'set' ? aclEvent.invalidateVps : (aclEvent as any).invalidateVps,
      ['/views/open'],
    );
  });

  it('$acl change on a direct child of the query source → invalidateVps', async () => {
    const events: NodeEvent[] = [];
    const { tree, cdc } = withSubscriptions(createMemoryTree(), e => events.push(e));

    await tree.set(createNode('/items', 'dir'));
    cdc.watchQuery('/views/open', '/items', { status: 'open' }, 'u1');
    events.length = 0;

    await tree.set({ ...createNode('/items/1', 'item'), status: 'open', $acl: [{ g: 'authenticated', p: R }] });

    const ev = events.find(e =>
      (e.type === 'set' || e.type === 'patch') && e.path === '/items/1');
    assert.ok(ev);
    const invalidateVps = ev.type === 'set' ? ev.invalidateVps : (ev as any).invalidateVps;
    assert.deepEqual(invalidateVps, ['/views/open']);
  });

  it('$acl change on an ancestor of the query source → invalidateVps', async () => {
    const events: NodeEvent[] = [];
    const { tree, cdc } = withSubscriptions(createMemoryTree(), e => events.push(e));

    await tree.set(createNode('/a', 'dir'));
    await tree.set(createNode('/a/items', 'dir'));
    cdc.watchQuery('/views/under-a', '/a/items', {}, 'u1');
    events.length = 0;

    await tree.set({ ...createNode('/a', 'dir'), $acl: [{ g: 'authenticated', p: R }] });

    const ev = events.find(e =>
      (e.type === 'set' || e.type === 'patch') && e.path === '/a');
    assert.ok(ev);
    const invalidateVps = ev.type === 'set' ? ev.invalidateVps : (ev as any).invalidateVps;
    assert.deepEqual(invalidateVps, ['/views/under-a']);
  });

  it('stay-in mutation does NOT dirty the folder (gk8.12)', async () => {
    const events: NodeEvent[] = [];
    const { tree, cdc } = withSubscriptions(createMemoryTree(), e => events.push(e));

    await tree.set(createNode('/items', 'dir'));
    cdc.watchQuery('/views/open', '/items', { status: 'open' }, 'u1');
    await tree.set({ ...createNode('/items/1', 'item'), status: 'open' }); // enters → dirty (expected)
    events.length = 0;

    // Membership unchanged — the update rides the plain patch event only.
    await tree.set({ ...createNode('/items/1', 'item'), status: 'open', note: 'touched' });

    const ev = events.find(e =>
      (e.type === 'set' || e.type === 'patch') && e.path === '/items/1');
    assert.ok(ev);
    assert.equal(
      ev.type === 'set' ? ev.invalidateVps : (ev as any).invalidateVps,
      undefined,
    );
  });

  it('$owner change emits invalidateVps just like $acl change', async () => {
    const events: NodeEvent[] = [];
    const { tree, cdc } = withSubscriptions(createMemoryTree(), e => events.push(e));

    await tree.set(createNode('/items', 'dir'));
    cdc.watchQuery('/views/open', '/items', {}, 'u1');
    events.length = 0;

    await tree.set({ ...createNode('/items', 'dir'), $owner: 'alice' });

    const ev = events.find(e =>
      (e.type === 'set' || e.type === 'patch') && e.path === '/items');
    assert.ok(ev);
    const invalidateVps = ev.type === 'set' ? ev.invalidateVps : (ev as any).invalidateVps;
    assert.deepEqual(invalidateVps, ['/views/open']);
  });

  it('patch op touching $acl emits invalidateVps', async () => {
    const events: NodeEvent[] = [];
    const { tree, cdc } = withSubscriptions(createMemoryTree(), e => events.push(e));

    await tree.set(createNode('/items', 'dir'));
    cdc.watchQuery('/views/open', '/items', {}, 'u1');

    await tree.patch('/items', [['r', '$acl', [{ g: 'authenticated', p: R }]]]);

    const ev = events.find(e => e.type === 'patch' && e.path === '/items');
    assert.ok(ev);
    if (ev.type !== 'patch') throw new Error('expected patch event');
    assert.deepEqual(ev.invalidateVps, ['/views/open']);
  });

  it('mount config write at vp path → invalidate that vp', async () => {
    const events: NodeEvent[] = [];
    const { tree, cdc } = withSubscriptions(createMemoryTree(), e => events.push(e), detectors);

    await tree.set({
      $path: '/views/orders',
      $type: 'folder',
      '#mount': { $type: 't.mount.query', source: '/orders', match: { status: 'new' } },
    });
    cdc.watchQuery('/views/orders', '/orders', { status: 'new' }, 'u1');
    events.length = 0;

    // Rewrite the mount component — match shifts from 'new' to 'pending'.
    await tree.set({
      $path: '/views/orders',
      $type: 'folder',
      '#mount': { $type: 't.mount.query', source: '/orders', match: { status: 'pending' } },
    });

    const ev = events.find(e =>
      (e.type === 'set' || e.type === 'patch') && e.path === '/views/orders');
    assert.ok(ev);
    const invalidateVps = ev.type === 'set' ? ev.invalidateVps : (ev as any).invalidateVps;
    assert.deepEqual(invalidateVps, ['/views/orders']);
  });

  it('patch op touching mount field emits invalidateVps for that vp', async () => {
    const events: NodeEvent[] = [];
    const { tree, cdc } = withSubscriptions(createMemoryTree(), e => events.push(e));

    await tree.set({
      $path: '/views/orders',
      $type: 'folder',
      '#mount': { $type: 't.mount.query', source: '/orders', match: {} },
    });
    cdc.watchQuery('/views/orders', '/orders', {}, 'u1');
    events.length = 0;

    await tree.patch('/views/orders', [['r', '#mount.source', '/archived-orders']]);

    const ev = events.find(e => e.type === 'patch' && e.path === '/views/orders');
    assert.ok(ev);
    if (ev.type !== 'patch') throw new Error('expected patch event');
    assert.deepEqual(ev.invalidateVps, ['/views/orders']);
  });

  it('removing a mount node emits invalidateVps for that vp', async () => {
    const events: NodeEvent[] = [];
    const { tree, cdc } = withSubscriptions(createMemoryTree(), e => events.push(e), detectors);

    await tree.set({
      $path: '/views/orders',
      $type: 'folder',
      '#mount': { $type: 't.mount.query', source: '/orders', match: {} },
    });
    cdc.watchQuery('/views/orders', '/orders', {}, 'u1');
    events.length = 0;

    await tree.remove('/views/orders');

    const ev = events.find(e => e.type === 'remove' && e.path === '/views/orders');
    assert.ok(ev);
    if (ev.type !== 'remove') throw new Error('expected remove event');
    assert.deepEqual(ev.invalidateVps, ['/views/orders']);
  });

  it('write to /auth/users/{uid} invalidates all queries for that user', async () => {
    const events: NodeEvent[] = [];
    const { tree, cdc } = withSubscriptions(createMemoryTree(), e => events.push(e), detectors);

    await tree.set(createNode('/items', 'dir'));
    await tree.set(createNode('/orders', 'dir'));
    cdc.watchQuery('/views/open-items', '/items', {}, 'alice');
    cdc.watchQuery('/views/new-orders', '/orders', {}, 'alice');
    cdc.watchQuery('/views/open-items', '/items', {}, 'bob');
    events.length = 0;

    // Alice's user node changes (e.g., admin tweaks her groups).
    await tree.set({
      $path: '/auth/users/alice',
      $type: 'user',
      '#groups': { $type: 'groups', list: ['admins'] },
    });

    const ev = events.find(e =>
      (e.type === 'set' || e.type === 'patch') && e.path === '/auth/users/alice');
    assert.ok(ev);
    const invalidateVps = ev.type === 'set' ? ev.invalidateVps : (ev as any).invalidateVps;
    // Both of alice's queries are listed. Bob's query is NOT affected.
    assert.ok(invalidateVps?.includes('/views/open-items'));
    assert.ok(invalidateVps?.includes('/views/new-orders'));
  });

  it('write to /auth/users/{uid}/sub-path does NOT invalidate (different node)', async () => {
    const events: NodeEvent[] = [];
    const { tree, cdc } = withSubscriptions(createMemoryTree(), e => events.push(e), detectors);

    await tree.set(createNode('/items', 'dir'));
    cdc.watchQuery('/views/open', '/items', {}, 'alice');
    events.length = 0;

    // Write under /auth/users/alice — not the user node itself.
    await tree.set(createNode('/auth/users/alice/profile', 'profile'));

    const ev = events.find(e =>
      (e.type === 'set' || e.type === 'patch') && e.path === '/auth/users/alice/profile');
    assert.ok(ev);
    assert.equal(
      ev.type === 'set' ? ev.invalidateVps : (ev as any).invalidateVps,
      undefined,
    );
  });

  it('routes invalidateVps to per-user CDC routes', async () => {
    const watcher = createWatchManager();
    const { tree, cdc } = withSubscriptions(createMemoryTree(), e => watcher.notify(e));
    const aliceEvents: NodeEvent[] = [];
    const bobEvents: NodeEvent[] = [];

    watcher.connect('alice-conn', 'alice', e => aliceEvents.push(e));
    watcher.connect('bob-conn', 'bob', e => bobEvents.push(e));
    watcher.watch('alice', ['/views/open'], { children: true });
    watcher.watch('bob', ['/views/closed'], { children: true });

    await tree.set({ ...createNode('/', 'root'), $acl: [{ g: 'public', p: R | A }] });
    await tree.set({ ...createNode('/items', 'dir'), $acl: [{ g: 'public', p: R }] });

    cdc.watchQuery('/views/open', '/items', { status: 'open' }, 'alice');
    cdc.watchQuery('/views/closed', '/items', { status: 'closed' }, 'bob');

    // ACL change on /items → both alice and bob should be invalidated
    await tree.set({ ...createNode('/items', 'dir'), $acl: [{ g: 'authenticated', p: R }] });

    const aliceEv = aliceEvents.find(e =>
      (e.type === 'set' || e.type === 'patch') && e.path === '/items');
    const bobEv = bobEvents.find(e =>
      (e.type === 'set' || e.type === 'patch') && e.path === '/items');
    assert.ok(aliceEv, 'alice receives invalidate event for /items ACL change');
    assert.ok(bobEv, 'bob receives invalidate event for /items ACL change');
    const aliceVps = aliceEv.type === 'set' ? aliceEv.invalidateVps : (aliceEv as any).invalidateVps;
    const bobVps = bobEv.type === 'set' ? bobEv.invalidateVps : (bobEv as any).invalidateVps;
    // Global event lists every invalidated vp; per-user filtering is the
    // routing decision (who gets delivered), not field-level filtering.
    assert.ok(aliceVps?.includes('/views/open'));
    assert.ok(bobVps?.includes('/views/closed'));
  });
});

// ── onSelfWrite — channel for external-watch dedup ──

describe('withSubscriptions.onSelfWrite', () => {
  it('fires on set with (path, rev)', async () => {
    const { tree, onSelfWrite } = withSubscriptions(createMemoryTree());
    const calls: Array<[string, number | undefined]> = [];
    onSelfWrite((p, r) => calls.push([p, r]));

    await tree.set(createNode('/x', 'test'));

    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], '/x');
    assert.equal(typeof calls[0][1], 'number');
    assert.ok((calls[0][1] as number) > 0, 'rev is positive integer');
  });

  it('fires on patch with rev from event', async () => {
    const tree0 = createMemoryTree();
    const { tree, onSelfWrite } = withSubscriptions(tree0);
    await tree.set({ ...createNode('/n', 'test'), n: 0 } as any);

    const calls: Array<[string, number | undefined]> = [];
    onSelfWrite((p, r) => calls.push([p, r]));

    await tree.patch('/n', [['r', 'n', 5]]);

    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], '/n');
    assert.ok(typeof calls[0][1] === 'number', 'patch fires with rev');
  });

  it('fires on remove with undefined rev', async () => {
    const { tree, onSelfWrite } = withSubscriptions(createMemoryTree());
    await tree.set(createNode('/x', 'test'));

    const calls: Array<[string, number | undefined]> = [];
    onSelfWrite((p, r) => calls.push([p, r]));

    await tree.remove('/x');

    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], '/x');
    assert.equal(calls[0][1], undefined);
  });

  it('multiple listeners — all fired', async () => {
    const { tree, onSelfWrite } = withSubscriptions(createMemoryTree());
    const a: string[] = [];
    const b: string[] = [];
    onSelfWrite((p) => a.push(p));
    onSelfWrite((p) => b.push(p));

    await tree.set(createNode('/x', 'test'));

    assert.equal(a.length, 1);
    assert.equal(b.length, 1);
  });

  it('unsubscribe stops further calls', async () => {
    const { tree, onSelfWrite } = withSubscriptions(createMemoryTree());
    const calls: string[] = [];
    const unsub = onSelfWrite((p) => calls.push(p));

    await tree.set(createNode('/x', 'test'));
    assert.equal(calls.length, 1);

    unsub();
    await tree.set(createNode('/y', 'test'));
    assert.equal(calls.length, 1, 'no further calls after unsub');
  });

  it('injectExternalEvent fires invalidateVps for queries whose source contains the path', async () => {
    // External (out-of-band) writes can't run through cdcEval (no oldNode
    // snapshot). injectExternalEvent invalidates any active query that
    // could have been affected, so query/VP watchers refetch instead of
    // silently missing the change.
    const events: NodeEvent[] = [];
    const { tree, cdc, injectExternalEvent } = withSubscriptions(createMemoryTree(), e => events.push(e));

    await tree.set(createNode('/items', 'dir'));
    cdc.watchQuery('/views/open', '/items', { status: 'open' }, 'u1');
    events.length = 0;

    // Simulate an external Mongo write surfacing a direct child of /items
    injectExternalEvent({
      type: 'set',
      path: '/items/external',
      node: { $type: 't', status: 'open' },
    });

    const ext = events.find(e => e.type === 'set' && e.path === '/items/external');
    assert.ok(ext, 'external event reaches direct watchers via dispatch');
    if (ext.type === 'set') {
      assert.deepEqual(ext.invalidateVps, ['/views/open'],
        'query whose source contains /items/external is invalidated');
    }
  });

  it('injectExternalEvent fires invalidateVps when the path is the query VP itself', async () => {
    // External write to the mount node itself (e.g. /views/open changing
    // match: {status:'closed'}) must invalidate that vp — its listing is
    // now driven by a different filter.
    const events: NodeEvent[] = [];
    const { tree, cdc, injectExternalEvent } = withSubscriptions(createMemoryTree(), e => events.push(e));

    await tree.set(createNode('/items', 'dir'));
    cdc.watchQuery('/views/open', '/items', { status: 'open' }, 'u1');
    events.length = 0;

    injectExternalEvent({
      type: 'set',
      path: '/views/open',
      node: { $type: 'mount-point', '#mount': { $type: 't.mount.query', source: '/items', match: { status: 'closed' } } },
    });

    const ext = events.find(e => e.type === 'set' && e.path === '/views/open');
    assert.ok(ext);
    if (ext.type === 'set') {
      assert.deepEqual(ext.invalidateVps, ['/views/open'],
        'query whose VP path matches is invalidated');
    }
  });

  it('injectExternalEvent does NOT fire onSelfWrite (external events must not poison dedup)', async () => {
    const { tree, onSelfWrite, injectExternalEvent } = withSubscriptions(createMemoryTree());
    const selfWriteFires: string[] = [];
    onSelfWrite((p) => selfWriteFires.push(p));

    // Real self-write — fires
    await tree.set(createNode('/a', 'test'));
    assert.equal(selfWriteFires.length, 1);

    // External event — must NOT fire
    injectExternalEvent({ type: 'set', path: '/external', node: { $type: 't' } });
    assert.equal(selfWriteFires.length, 1, 'external event did not fire onSelfWrite');
  });

  it('injectExternalEvent reconnect routes straight to onEvent (no CDC, no listeners)', async () => {
    const events: NodeEvent[] = [];
    const { injectExternalEvent } = withSubscriptions(createMemoryTree(), e => events.push(e));

    injectExternalEvent({ type: 'reconnect', preserved: false });

    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'reconnect');
    if (events[0].type === 'reconnect') assert.equal(events[0].preserved, false);
  });

  it('throwing listener does not break the write or other listeners', async () => {
    const { tree, onSelfWrite } = withSubscriptions(createMemoryTree());

    const originalError = console.error;
    let errored = false;
    console.error = () => { errored = true; };

    const survivors: string[] = [];
    onSelfWrite(() => { throw new Error('listener bug'); });
    onSelfWrite((p) => survivors.push(p));

    try {
      await tree.set(createNode('/x', 'test'));
    } finally {
      console.error = originalError;
    }

    assert.equal(survivors.length, 1, 'second listener still fired');
    assert.ok(errored, 'thrown error was logged, not swallowed silently');
  });
});
