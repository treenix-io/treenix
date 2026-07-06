import { A, createNode, getComponentByName, R, type NodeData } from '#core';
import { userIdFromAuthPath } from '#security/claims';
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
  it('patch event carries the STORED post-bump $rev through node-copying layers (repath)', async () => {
    // repath.set copies the node for path translation, so the adapter's
    // in-place $rev bump never reaches the emitter's ref. Emitting from the
    // input ref shipped pre-bump revs — every subscriber cached a stale $rev
    // and false-CONFLICTed on its next write (found via cnr.5 C2).
    const { createRepathTree } = await import('#tree/repath');
    const events: NodeEvent[] = [];
    const { tree } = withSubscriptions(createRepathTree(createMemoryTree(), '/', '/'), e => events.push(e));

    await tree.set(createNode('/x', 'doc', { title: 'v1' }));
    const stored = await tree.get('/x');
    await tree.set({ ...stored!, title: 'v2' });

    const ev = events.find(e => e.type === 'patch');
    assert.ok(ev && ev.type === 'patch');
    assert.equal(ev.rev, 2, 'event rev is the post-bump stored rev');
    assert.ok(ev.patches.some(p => p[1] === '$rev' && p[2] === 2), 'diff includes the $rev bump op');
  });

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

    cdc.watchQuery({ vp: '/views/status', userId: 'u1', plan: { source: '/items', viewWhere: { status: 'open' } }, mountDeps: new Set(['/views/status']) });
    cdc.watchQuery({ vp: '/views/status', userId: 'u1', plan: { source: '/items', viewWhere: { status: 'closed' } }, mountDeps: new Set(['/views/status']) });

    await tree.set({ $path: '/items/1', $type: 'item', status: 'closed' });

    const event = events.find(e => e.type === 'set' && e.path === '/items/1');
    assert.ok(event);
    if (event.type !== 'set') throw new Error('expected set event');
    // Membership flip against the UPDATED match → coarse dirty (gk8.12).
    assert.deepEqual(event.invalidateVps, ['/views/status']);
  });

  it('two watchers on the same source with different match coexist — no cross-talk (core-wf1)', async () => {
    const events: NodeEvent[] = [];
    const { tree, cdc } = withSubscriptions(createMemoryTree(), e => events.push(e));

    await tree.set(createNode('/items', 'dir'));
    // Same source, DIFFERENT vp + match — distinct plans key distinct groups,
    // so they coexist; the E03 bug (source-only keying) would have collided them.
    cdc.watchQuery({ vp: '/views/open', userId: 'u1', plan: { source: '/items', viewWhere: { status: 'open' } }, mountDeps: new Set(['/views/open']) });
    cdc.watchQuery({ vp: '/views/closed', userId: 'u1', plan: { source: '/items', viewWhere: { status: 'closed' } }, mountDeps: new Set(['/views/closed']) });
    events.length = 0;

    // A node that matches ONLY the 'open' view.
    await tree.set({ ...createNode('/items/1', 'item'), status: 'open' });

    const ev = events.find(e => (e.type === 'set' || e.type === 'patch') && e.path === '/items/1');
    assert.ok(ev);
    assert.deepEqual(ev.invalidateVps, ['/views/open'], 'only the matching view invalidated — predicates evaluated independently');
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

    cdc.watchQuery({ vp: '/views/open', userId: 'legacy', plan: { source: '/items', viewWhere: { status: 'open' } }, mountDeps: new Set(['/views/open']) });
    cdc.watchQuery({ vp: '/views/open', userId: 'member', plan: { source: '/items', viewWhere: { status: 'open' } }, mountDeps: new Set(['/views/open']) });
    cdc.watchQuery({ vp: '/views/open', userId: 'anon', plan: { source: '/items', viewWhere: { status: 'open' } }, mountDeps: new Set(['/views/open']) });

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
    cdc.watchQuery({ vp: '/views/open', userId: 'u1', plan: { source: '/items', viewWhere: { status: 'open' } }, mountDeps: new Set(['/views/open']) });
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
    cdc.watchQuery({ vp: '/views/open', userId: 'u1', plan: { source: '/items', viewWhere: { status: 'open' } }, mountDeps: new Set(['/views/open']) });
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
    cdc.watchQuery({ vp: '/views/under-a', userId: 'u1', plan: { source: '/a/items', viewWhere: {} }, mountDeps: new Set(['/views/under-a']) });
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
    cdc.watchQuery({ vp: '/views/open', userId: 'u1', plan: { source: '/items', viewWhere: { status: 'open' } }, mountDeps: new Set(['/views/open']) });
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
    cdc.watchQuery({ vp: '/views/open', userId: 'u1', plan: { source: '/items', viewWhere: {} }, mountDeps: new Set(['/views/open']) });
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
    cdc.watchQuery({ vp: '/views/open', userId: 'u1', plan: { source: '/items', viewWhere: {} }, mountDeps: new Set(['/views/open']) });

    await tree.patch('/items', [['r', '$acl', [{ g: 'authenticated', p: R }]]]);

    const ev = events.find(e => e.type === 'patch' && e.path === '/items');
    assert.ok(ev);
    if (ev.type !== 'patch') throw new Error('expected patch event');
    assert.deepEqual(ev.invalidateVps, ['/views/open']);
  });

  // ── Component permission-rule mutations are ACL-affecting (core-5tl) ──

  it('component with a type-level acl rule changing → invalidateVps (MVP-spec parity)', async () => {
    const events: NodeEvent[] = [];
    const { tree, cdc } = withSubscriptions(createMemoryTree(), e => events.push(e), {
      componentHasAclRule: (type) => type === 'sec.typed',
    });

    await tree.set(createNode('/items', 'dir'));
    cdc.watchQuery({ vp: '/views/open', userId: 'u1', plan: { source: '/items', viewWhere: {} }, mountDeps: new Set(['/views/open']) });
    await tree.set({ ...createNode('/items/1', 'item'), '#secret': { $type: 'sec.typed', k: 'v1' } });
    events.length = 0;

    // Rewrite the permission-bearing component — no $acl/$owner touched.
    await tree.set({ ...createNode('/items/1', 'item'), '#secret': { $type: 'sec.typed', k: 'v2' } });

    const ev = events.find(e => (e.type === 'set' || e.type === 'patch') && e.path === '/items/1');
    assert.ok(ev);
    const invalidateVps = ev.type === 'set' ? ev.invalidateVps : (ev as any).invalidateVps;
    assert.deepEqual(invalidateVps, ['/views/open']);
  });

  it('inline component $acl change → invalidateVps without a type handler', async () => {
    const events: NodeEvent[] = [];
    const { tree, cdc } = withSubscriptions(createMemoryTree(), e => events.push(e));

    await tree.set(createNode('/items', 'dir'));
    cdc.watchQuery({ vp: '/views/open', userId: 'u1', plan: { source: '/items', viewWhere: {} }, mountDeps: new Set(['/views/open']) });
    await tree.set({ ...createNode('/items/1', 'item'), '#secret': { $type: 'sec', k: 'v', $acl: [{ g: 'authenticated', p: R }] } });
    events.length = 0;

    await tree.set({ ...createNode('/items/1', 'item'), '#secret': { $type: 'sec', k: 'v', $acl: [{ g: 'authenticated', p: 0 }] } });

    const ev = events.find(e => (e.type === 'set' || e.type === 'patch') && e.path === '/items/1');
    assert.ok(ev);
    const invalidateVps = ev.type === 'set' ? ev.invalidateVps : (ev as any).invalidateVps;
    assert.deepEqual(invalidateVps, ['/views/open']);
  });

  it('non-permission-bearing component change does NOT trigger acl-invalidate', async () => {
    const events: NodeEvent[] = [];
    const { tree, cdc } = withSubscriptions(createMemoryTree(), e => events.push(e));

    await tree.set(createNode('/items', 'dir'));
    cdc.watchQuery({ vp: '/views/open', userId: 'u1', plan: { source: '/items', viewWhere: {} }, mountDeps: new Set(['/views/open']) });
    await tree.set({ ...createNode('/items/1', 'item'), '#plain': { $type: 'plain', k: 'v1' } });
    events.length = 0;

    await tree.set({ ...createNode('/items/1', 'item'), '#plain': { $type: 'plain', k: 'v2' } });

    const ev = events.find(e => (e.type === 'set' || e.type === 'patch') && e.path === '/items/1');
    assert.ok(ev);
    const invalidateVps = ev.type === 'set' ? ev.invalidateVps : (ev as any).invalidateVps;
    assert.equal(invalidateVps, undefined, 'plain component change rides the data-diff path — no acl-invalidate');
  });

  it('mount config write at vp path → invalidate that vp', async () => {
    const events: NodeEvent[] = [];
    const { tree, cdc } = withSubscriptions(createMemoryTree(), e => events.push(e), detectors);

    await tree.set({
      $path: '/views/orders',
      $type: 'folder',
      '#mount': { $type: 't.mount.query', source: '/orders', match: { status: 'new' } },
    });
    cdc.watchQuery({ vp: '/views/orders', userId: 'u1', plan: { source: '/orders', viewWhere: { status: 'new' } }, mountDeps: new Set(['/views/orders']) });
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
    cdc.watchQuery({ vp: '/views/orders', userId: 'u1', plan: { source: '/orders', viewWhere: {} }, mountDeps: new Set(['/views/orders']) });
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
    cdc.watchQuery({ vp: '/views/orders', userId: 'u1', plan: { source: '/orders', viewWhere: {} }, mountDeps: new Set(['/views/orders']) });
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
    cdc.watchQuery({ vp: '/views/open-items', userId: 'alice', plan: { source: '/items', viewWhere: {} }, mountDeps: new Set(['/views/open-items']) });
    cdc.watchQuery({ vp: '/views/new-orders', userId: 'alice', plan: { source: '/orders', viewWhere: {} }, mountDeps: new Set(['/views/new-orders']) });
    cdc.watchQuery({ vp: '/views/open-items', userId: 'bob', plan: { source: '/items', viewWhere: {} }, mountDeps: new Set(['/views/open-items']) });
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
    cdc.watchQuery({ vp: '/views/open', userId: 'alice', plan: { source: '/items', viewWhere: {} }, mountDeps: new Set(['/views/open']) });
    events.length = 0;

    // Write under /auth/users/alice — not the user node itself.
    await tree.set(createNode('/auth/users/alice/profile', 'profile'));

    const ev = events.find(e =>
      (e.type === 'set' || e.type === 'patch') && e.path === '/auth/users/alice/profile');
    assert.ok(ev);
    assert.equal(ev.invalidateVps, undefined);
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

    cdc.watchQuery({ vp: '/views/open', userId: 'alice', plan: { source: '/items', viewWhere: { status: 'open' } }, mountDeps: new Set(['/views/open']) });
    cdc.watchQuery({ vp: '/views/closed', userId: 'bob', plan: { source: '/items', viewWhere: { status: 'closed' } }, mountDeps: new Set(['/views/closed']) });

    // ACL change on /items → both alice and bob should be invalidated
    await tree.set({ ...createNode('/items', 'dir'), $acl: [{ g: 'authenticated', p: R }] });

    const aliceEv = aliceEvents.find(e =>
      (e.type === 'set' || e.type === 'patch') && e.path === '/items');
    const bobEv = bobEvents.find(e =>
      (e.type === 'set' || e.type === 'patch') && e.path === '/items');
    assert.ok(aliceEv, 'alice receives invalidate event for /items ACL change');
    assert.ok(bobEv, 'bob receives invalidate event for /items ACL change');
    // Global event lists every invalidated vp; per-user filtering is the
    // routing decision (who gets delivered), not field-level filtering.
    assert.ok(aliceEv.invalidateVps?.includes('/views/open'));
    assert.ok(bobEv.invalidateVps?.includes('/views/closed'));
  });
});

// ── Stage 6d: plan-keyed watch registration (core-9yd) ──

describe('watch registration (Stage 6d, core-9yd)', () => {
  it('callerWhere participates in membership — caller-side flips dirty the vp', async () => {
    const events: NodeEvent[] = [];
    const { tree, cdc } = withSubscriptions(createMemoryTree(), e => events.push(e));

    cdc.watchQuery({
      vp: '/views/mine', userId: 'u1',
      plan: { source: '/tasks', viewWhere: { kind: 'task' }, callerWhere: { status: 'open' } },
      mountDeps: new Set(['/views/mine']),
    });

    await tree.set({ ...createNode('/tasks/1', 'item'), kind: 'task', status: 'open' });
    const enter = events.find(e => (e.type === 'set' || e.type === 'patch') && e.path === '/tasks/1');
    assert.ok(enter?.invalidateVps?.includes('/views/mine'), 'caller-matched item entering dirties the view');

    events.length = 0;
    // Leaves via the CALLER predicate only — viewWhere still matches. The
    // pre-6d registration (viewWhere only) missed exactly this flip.
    const stored = await tree.get('/tasks/1');
    await tree.set({ ...stored!, status: 'closed' });
    const leave = events.find(e => (e.type === 'set' || e.type === 'patch') && e.path === '/tasks/1');
    assert.ok(leave?.invalidateVps?.includes('/views/mine'), 'caller-side flip dirties the view');
  });

  it('dedup: two vps over one canonical plan share a group; a flip dirties both', async () => {
    const events: NodeEvent[] = [];
    const { tree, cdc } = withSubscriptions(createMemoryTree(), e => events.push(e));

    cdc.watchQuery({ vp: '/views/a', userId: 'u1', plan: { source: '/items', viewWhere: { status: 'open' } }, mountDeps: new Set(['/views/a']) });
    cdc.watchQuery({ vp: '/views/b', userId: 'u2', plan: { source: '/items', viewWhere: { status: 'open' } }, mountDeps: new Set(['/views/b']) });
    assert.equal(cdc.getActiveQueryCount(), 1, 'same canonical plan → one execution group');

    await tree.set({ ...createNode('/items/1', 'item'), status: 'open' });
    const ev = events.find(e => (e.type === 'set' || e.type === 'patch') && e.path === '/items/1');
    assert.ok(ev);
    assert.deepEqual([...(ev.invalidateVps ?? [])].sort(), ['/views/a', '/views/b'], 'one evaluation fans out to every vp in the group');
  });

  it('mountDeps: config write at a consulted dep dirties only the handles that consulted it', async () => {
    const events: NodeEvent[] = [];
    const { tree, cdc } = withSubscriptions(createMemoryTree(), e => events.push(e), detectors);

    cdc.watchQuery({
      vp: '/views/composite', userId: 'u1',
      plan: { source: '/items', viewWhere: { status: 'open' } },
      mountDeps: new Set(['/views/composite', '/config/filters']),
    });
    cdc.watchQuery({
      vp: '/views/plain', userId: 'u1',
      plan: { source: '/items', viewWhere: { status: 'closed' } },
      mountDeps: new Set(['/views/plain']),
    });

    await tree.set(createNode('/config/filters', 'dir', {}, {
      mount: { $type: 't.mount.query', source: '/items', match: {} },
    }));

    const ev = events.find(e => (e.type === 'set' || e.type === 'patch') && e.path === '/config/filters');
    assert.ok(ev);
    assert.deepEqual(ev.invalidateVps, ['/views/composite'], 'only the handle that consulted the dep goes dirty');
  });

  it('group GC: the last handle removal drops the group', async () => {
    const { cdc } = withSubscriptions(createMemoryTree());
    cdc.watchQuery({ vp: '/views/a', userId: 'u1', plan: { source: '/items', viewWhere: { s: 1 } }, mountDeps: new Set(['/views/a']) });
    cdc.watchQuery({ vp: '/views/b', userId: 'u2', plan: { source: '/items', viewWhere: { s: 1 } }, mountDeps: new Set(['/views/b']) });
    assert.equal(cdc.getActiveQueryCount(), 1);

    cdc.unwatchQuery('/views/a', 'u1');
    assert.equal(cdc.getActiveQueryCount(), 1, 'group survives while another handle references it');
    cdc.unwatchQuery('/views/b', 'u2');
    assert.equal(cdc.getActiveQueryCount(), 0, 'last handle removal GCs the group');
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
    cdc.watchQuery({ vp: '/views/open', userId: 'u1', plan: { source: '/items', viewWhere: { status: 'open' } }, mountDeps: new Set(['/views/open']) });
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
    cdc.watchQuery({ vp: '/views/open', userId: 'u1', plan: { source: '/items', viewWhere: { status: 'open' } }, mountDeps: new Set(['/views/open']) });
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
