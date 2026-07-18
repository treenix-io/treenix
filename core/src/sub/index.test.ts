import { A, createNode, getComponentByName, R, type NodeData } from '#core';
import { OpError } from '#errors';
import { withAcl } from '#security/acl-tree';
import { userIdFromAuthPath } from '#security/claims';
import { createProjector } from '#security/projector';
import { createMemoryTree, type Tree } from '#tree';
import { planHash } from '#tree/plan-hash';
import { executeList, type Projector } from '#tree/read-runtime';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type MembershipProjector, type NodeEvent, type SubscriptionOpts, withSubscriptions } from './index';
import { createWatchManager } from './watch';

// Production detectors are layer-injected (gk8.12) — tests wire the real ones.
const detectors: SubscriptionOpts = {
  claimsUserOf: userIdFromAuthPath,
  isConfigNode: (node: NodeData | null | undefined) => !!node && getComponentByName(node, 'mount') !== undefined,
};

// F4 (core-anz4.3): query watches fail closed without a membership projector.
// Suites here exercise CDC mechanics on trees without ACL data, where the raw
// pair IS every actor's projection; real per-actor stripping is covered in the
// 'actor-projected membership' describe below.
const withSubs = (...[tree, onEvent, opts]: Parameters<typeof withSubscriptions>) =>
  withSubscriptions(tree, onEvent, { projectMembership: async (_u, o, n) => [o, n], ...opts });

describe('Subscriptions', () => {
  it('patch event carries the STORED post-bump $rev through node-copying layers (repath)', async () => {
    // repath.set copies the node for path translation, so the adapter's
    // in-place $rev bump never reaches the emitter's ref. Emitting from the
    // input ref shipped pre-bump revs — every subscriber cached a stale $rev
    // and false-CONFLICTed on its next write (found via cnr.5 C2).
    const { createRepathTree } = await import('#tree/repath');
    const events: NodeEvent[] = [];
    const { tree } = withSubs(createRepathTree(createMemoryTree(), '/', '/'), e => events.push(e));

    await tree.set(createNode('/x', 'doc', { title: 'v1' }));
    const stored = await tree.get('/x');
    await tree.set({ ...stored!, title: 'v2' });

    const ev = events.find(e => e.type === 'patch');
    assert.ok(ev && ev.type === 'patch');
    assert.equal(ev.rev, 2, 'event rev is the post-bump stored rev');
    assert.ok(ev.patches.some(p => p[1] === '$rev' && p[2] === 2), 'diff includes the $rev bump op');
  });

  it('emits on set (children)', async () => {
    const { tree, cdc } = withSubs(createMemoryTree());
    const events: NodeEvent[] = [];
    cdc.subscribe('/bot', (e) => events.push(e), { children: true });

    await tree.set(createNode('/bot/commands/start', 'page'));
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'set');
    assert.equal(events[0].path, '/bot/commands/start');
  });

  it('emits on remove (children)', async () => {
    const { tree, cdc } = withSubs(createMemoryTree());
    const events: NodeEvent[] = [];
    await tree.set(createNode('/bot/x', 'page'));
    cdc.subscribe('/bot', (e) => events.push(e), { children: true });
    await tree.remove('/bot/x');
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'remove');
  });

  it('does not emit for unrelated paths', async () => {
    const { tree, cdc } = withSubs(createMemoryTree());
    const events: NodeEvent[] = [];
    cdc.subscribe('/bot', (e) => events.push(e), { children: true });
    await tree.set(createNode('/users/1', 'user'));
    assert.equal(events.length, 0);
  });

  it('emits for exact path match', async () => {
    const { tree, cdc } = withSubs(createMemoryTree());
    const events: NodeEvent[] = [];
    cdc.subscribe('/bot', (e) => events.push(e));
    await tree.set(createNode('/bot', 'bot'));
    assert.equal(events.length, 1);
  });

  it('unsubscribe stops events (children)', async () => {
    const { tree, cdc } = withSubs(createMemoryTree());
    const events: NodeEvent[] = [];
    const unsub = cdc.subscribe('/bot', (e) => events.push(e), { children: true });
    await tree.set(createNode('/bot/x', 'page'));
    assert.equal(events.length, 1);
    unsub();
    await tree.set(createNode('/bot/y', 'page'));
    assert.equal(events.length, 1);
  });

  it('set with changed field emits computed patch', async () => {
    const { tree, cdc } = withSubs(createMemoryTree());
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
    const { tree, cdc } = withSubs(createMemoryTree());
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
    const { tree } = withSubs(mem);

    const node: any = { ...createNode('/x', 'test'), foo: 'bar' };
    node.$patches = [{ op: 'replace', path: ['foo'], value: 'FAKE' }];
    await tree.set(node);

    const stored = await mem.get('/x');
    assert.ok(stored);
    assert.equal('$patches' in stored, false, '$patches should not be stored');
  });

  it('two plans on one (userId, vp) coexist — each releasable independently (E03 → coexistence, ns6p.4 §4.2)', async () => {
    const events: NodeEvent[] = [];
    const { tree, cdc } = withSubs(createMemoryTree(), e => events.push(e));

    cdc.watchQuery({ vp: '/views/status', userId: 'u1', plan: { source: '/items', viewWhere: { status: 'open' } }, mountDeps: new Set(['/views/status']) });
    cdc.watchQuery({ vp: '/views/status', userId: 'u1', plan: { source: '/items', viewWhere: { status: 'closed' } }, mountDeps: new Set(['/views/status']) });
    assert.equal(cdc.getActiveQueryCount(), 2, 'a different plan registers ALONGSIDE, not over (budget counts both groups)');

    await tree.set({ $path: '/items/1', $type: 'item', status: 'closed' });
    const enter = events.find(e => (e.type === 'set' || e.type === 'patch') && e.path === '/items/1');
    assert.ok(enter);
    assert.deepEqual(enter.invalidateVps, ['/views/status'], 'either coexisting plan flipping dirties the vp');

    // Lease-scoped release: only the closed-plan handle dies.
    cdc.unwatchQuery('/views/status', 'u1', planHash({ source: '/items', viewWhere: { status: 'closed' } }));
    assert.equal(cdc.getActiveQueryCount(), 1, 'release removes only the caller\'s handle');

    events.length = 0;
    await tree.set({ $path: '/items/2', $type: 'item', status: 'closed' });
    const released = events.find(e => (e.type === 'set' || e.type === 'patch') && e.path === '/items/2');
    assert.ok(released);
    assert.equal(released.invalidateVps, undefined, 'released plan no longer evaluates');

    events.length = 0;
    await tree.set({ $path: '/items/3', $type: 'item', status: 'open' });
    const survivor = events.find(e => (e.type === 'set' || e.type === 'patch') && e.path === '/items/3');
    assert.deepEqual(survivor?.invalidateVps, ['/views/status'], 'the coexisting plan stays live');

    // Hashless release = registration death: every plan of (userId, vp) goes.
    cdc.unwatchQuery('/views/status', 'u1');
    assert.equal(cdc.getActiveQueryCount(), 0);
  });

  it('two watchers on the same source with different match coexist — no cross-talk (core-wf1)', async () => {
    const events: NodeEvent[] = [];
    const { tree, cdc } = withSubs(createMemoryTree(), e => events.push(e));

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
    const { tree, cdc } = withSubs(createMemoryTree(), e => watcher.notify(e));
    const legacyEvents: NodeEvent[] = [];
    const memberEvents: NodeEvent[] = [];
    const anonEvents: NodeEvent[] = [];

    watcher.connect('legacy-conn', 'legacy', e => legacyEvents.push(e.event));
    watcher.connect('member-conn', 'member', e => memberEvents.push(e.event));
    watcher.connect('anon-conn', 'anon', e => anonEvents.push(e.event));
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
    const { tree, cdc } = withSubs(createMemoryTree(), e => events.push(e));

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
    const { tree, cdc } = withSubs(createMemoryTree(), e => events.push(e));

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
    const { tree, cdc } = withSubs(createMemoryTree(), e => events.push(e));

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
    const { tree, cdc } = withSubs(createMemoryTree(), e => events.push(e));

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
    const { tree, cdc } = withSubs(createMemoryTree(), e => events.push(e));

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
    const { tree, cdc } = withSubs(createMemoryTree(), e => events.push(e));

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
    const { tree, cdc } = withSubs(createMemoryTree(), e => events.push(e), {
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
    const { tree, cdc } = withSubs(createMemoryTree(), e => events.push(e));

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
    const { tree, cdc } = withSubs(createMemoryTree(), e => events.push(e));

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
    const { tree, cdc } = withSubs(createMemoryTree(), e => events.push(e), detectors);

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
    const { tree, cdc } = withSubs(createMemoryTree(), e => events.push(e));

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
    const { tree, cdc } = withSubs(createMemoryTree(), e => events.push(e), detectors);

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
    const { tree, cdc } = withSubs(createMemoryTree(), e => events.push(e), detectors);

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
    const { tree, cdc } = withSubs(createMemoryTree(), e => events.push(e), detectors);

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
    const { tree, cdc } = withSubs(createMemoryTree(), e => watcher.notify(e));
    const aliceEvents: NodeEvent[] = [];
    const bobEvents: NodeEvent[] = [];

    watcher.connect('alice-conn', 'alice', e => aliceEvents.push(e.event));
    watcher.connect('bob-conn', 'bob', e => bobEvents.push(e.event));
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

// ── patchMany emission: set-members (core-gk8.10 stage 2) ──

describe('patchMany emission with set-members', () => {
  it('CREATE set-member emits a set event carrying the stored node after commit', async () => {
    const events: NodeEvent[] = [];
    const { tree } = withSubs(createMemoryTree(), e => events.push(e));

    await tree.set({ ...createNode('/data/src', 'thing'), v: 1 });
    events.length = 0;

    assert.ok(tree.patchMany, 'memory tree exposes patchMany');
    await tree.patchMany!('/data', [
      { path: '/data/src', ops: [['r', 'v', 2]] },
      { path: '/data/dst', node: { ...createNode('/data/dst', 'thing'), v: 2 } },
    ]);

    const created = events.find(e => e.type === 'set' && e.path === '/data/dst');
    assert.ok(created, 'create in a batch is visible to subscribers');
    if (created.type !== 'set') throw new Error('expected set event');
    assert.equal(created.node.v, 2);
    assert.equal(typeof created.node.$rev, 'number', 'event carries the STORED node with its bumped $rev');

    const patched = events.find(e => e.type === 'patch' && e.path === '/data/src');
    assert.ok(patched, 'ops-member in the same batch still emits');
  });

  it('set-member over an existing node emits an event at its path', async () => {
    const events: NodeEvent[] = [];
    const { tree } = withSubs(createMemoryTree(), e => events.push(e));

    await tree.set({ ...createNode('/data/a', 'thing'), v: 1 });
    events.length = 0;

    await tree.patchMany!('/data', [
      { path: '/data/a', node: { ...createNode('/data/a', 'thing'), v: 9 } },
    ]);

    // patch-or-set per the diffNodes fallback — assert delivery, not shape.
    const ev = events.find(e => (e.type === 'set' || e.type === 'patch') && e.path === '/data/a');
    assert.ok(ev, 'set-member over an existing node reaches subscribers');
  });

  it('denied batch emits zero events — including for its set-members', async () => {
    const events: NodeEvent[] = [];
    const { tree } = withSubs(createMemoryTree(), e => events.push(e));

    await tree.set({ ...createNode('/data/a', 'thing'), v: 1 });
    events.length = 0;

    await assert.rejects(
      tree.patchMany!('/data', [
        { path: '/data/a', ops: [['t', 'v', 999]] },
        { path: '/data/new', node: createNode('/data/new', 'thing') },
      ]),
      (e: unknown) => e instanceof OpError && e.code === 'CONFLICT',
    );

    assert.equal(events.length, 0, 'failed batch emits nothing');
    assert.equal(await tree.get('/data/new'), undefined, 'atomic: nothing committed');
  });
});

// ── Stage 6d: plan-keyed watch registration (core-9yd) ──

describe('watch registration (Stage 6d, core-9yd)', () => {
  it('callerWhere participates in membership — caller-side flips dirty the vp', async () => {
    const events: NodeEvent[] = [];
    const { tree, cdc } = withSubs(createMemoryTree(), e => events.push(e));

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
    const { tree, cdc } = withSubs(createMemoryTree(), e => events.push(e));

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
    const { tree, cdc } = withSubs(createMemoryTree(), e => events.push(e), detectors);

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

  it('rejects a query watch whose callerWhere probes an ACL-gated field (hidden-field oracle, core-anz4.3)', () => {
    const { cdc } = withSubs(createMemoryTree());
    assert.throws(
      () => cdc.watchQuery({
        vp: '/views/x', userId: 'u1',
        plan: { source: '/items', viewWhere: { kind: 'task' }, callerWhere: { $owner: 'u2' } },
        mountDeps: new Set(['/views/x']),
      }),
      (e: unknown) => e instanceof OpError && e.code === 'FORBIDDEN',
    );
    assert.equal(cdc.getActiveQueryCount(), 0, 'rejected registration leaves no group');
  });

  it('hidden-field callerWhere is caught inside a nested $and branch too', () => {
    const { cdc } = withSubs(createMemoryTree());
    assert.throws(
      () => cdc.watchQuery({
        vp: '/views/y', userId: 'u1',
        plan: { source: '/items', callerWhere: { $and: [{ status: 'open' }, { $acl: { $exists: true } }] } },
        mountDeps: new Set(['/views/y']),
      }),
      (e: unknown) => e instanceof OpError && e.code === 'FORBIDDEN',
    );
  });

  it('rejects predicates on storage-key aliases _acl/_owner/_refs (core-anz4.3)', () => {
    // mapNodeForSift maps a node to storage shape ($owner→_owner etc.), so a
    // predicate keyed on the alias probes the same hidden data the projector
    // strips. Guard both predicate positions.
    const { cdc } = withSubs(createMemoryTree());
    const forbidden = (e: unknown) => e instanceof OpError && e.code === 'FORBIDDEN';
    assert.throws(() => cdc.watchQuery({
      vp: '/views/a', userId: 'u1',
      plan: { source: '/items', callerWhere: { _owner: 'u2' } },
      mountDeps: new Set(['/views/a']),
    }), forbidden);
    assert.throws(() => cdc.watchQuery({
      vp: '/views/b', userId: 'u1',
      plan: { source: '/items', viewWhere: { _acl: { $exists: true } } },
      mountDeps: new Set(['/views/b']),
    }), forbidden);
    assert.throws(() => cdc.watchQuery({
      vp: '/views/c', userId: 'u1',
      plan: { source: '/items', callerWhere: { $and: [{ status: 'open' }, { '_refs.a': { $exists: true } }] } },
      mountDeps: new Set(['/views/c']),
    }), forbidden);
    // toStorageKeys maps EVERY $foo→_foo, so unknown aliases (e.g. _v for $v)
    // must fail closed too — an enumerated denylist would leak them.
    assert.throws(() => cdc.watchQuery({
      vp: '/views/d', userId: 'u1',
      plan: { source: '/items', viewWhere: { $nor: [{ _v: 2 }] } },
      mountDeps: new Set(['/views/d']),
    }), forbidden);
    assert.equal(cdc.getActiveQueryCount(), 0, 'no group left behind by rejected registrations');
  });

  it('allows a visible-component predicate — hidden-component oracle closed by projected eval (core-anz4.3)', () => {
    // Querying a '#'-component is a first-class feature, so registration
    // rejects only hidden SYSTEM fields. An ACL-gated component is handled at
    // EVAL time: actor-projected membership (F4) strips it before the test
    // runs — see the 'actor-projected membership' describe.
    const { cdc } = withSubs(createMemoryTree());
    cdc.watchQuery({
      vp: '/views/salary', userId: 'u1',
      plan: { source: '/staff', viewWhere: { kind: 'person' }, callerWhere: { '#dept.name': 'eng' } },
      mountDeps: new Set(['/views/salary']),
    });
    assert.equal(cdc.getActiveQueryCount(), 1, 'visible-component predicate registers');
  });

  it('rejects a viewWhere referencing a hidden system field — viewWhere is NOT trusted at HEAD (core-anz4.3)', () => {
    // read-runtime §header: both predicates run on the projected node until F4
    // (a mount can be user-authored), so viewWhere leaks a hidden system field
    // ($acl/$owner/$refs) just as callerWhere does. Guard it the same.
    const { cdc } = withSubs(createMemoryTree());
    assert.throws(
      () => cdc.watchQuery({
        vp: '/views/acl', userId: 'u1',
        plan: { source: '/items', viewWhere: { $acl: { $exists: true } } },
        mountDeps: new Set(['/views/acl']),
      }),
      (e: unknown) => e instanceof OpError && e.code === 'FORBIDDEN',
    );
    assert.equal(cdc.getActiveQueryCount(), 0, 'no group left behind by rejected registration');
  });

  it('allows predicates on guaranteed-visible fields ($type + plain field) — still registers', () => {
    const { cdc } = withSubs(createMemoryTree());
    cdc.watchQuery({
      vp: '/views/ok', userId: 'u1',
      plan: { source: '/items', viewWhere: { $type: 'item' }, callerWhere: { status: 'open' } },
      mountDeps: new Set(['/views/ok']),
    });
    assert.equal(cdc.getActiveQueryCount(), 1, 'visible-field predicate registers a group');
  });

  it('executeList still rejects the same callerWhere on a hidden field (parity, core-fnv)', async () => {
    const source = createMemoryTree();
    await source.set({ ...createNode('/items/a', 'item'), $owner: 'u2' } as NodeData);
    const stripOwner: Projector = async (node) => { const { $owner, ...rest } = node; return rest as NodeData; };
    await assert.rejects(
      () => executeList(source, { source: '/items', callerWhere: { $owner: 'u2' } }, { limit: 10 }, stripOwner),
      (e: unknown) => e instanceof OpError && e.code === 'FORBIDDEN',
    );
  });

  it('rejects a depth>1 query watch (deep membership unsupported, core-anz4.15)', () => {
    const { cdc } = withSubs(createMemoryTree());
    assert.throws(
      () => cdc.watchQuery({ vp: '/views/deep', userId: 'u1', plan: { source: '/items', depth: 2, viewWhere: {} }, mountDeps: new Set(['/views/deep']) }),
      (e: unknown) => e instanceof OpError && e.code === 'BAD_REQUEST',
    );
    assert.throws(
      () => cdc.watchQuery({ vp: '/views/all', userId: 'u1', plan: { source: '/items', depth: -1, viewWhere: {} }, mountDeps: new Set(['/views/all']) }),
      (e: unknown) => e instanceof OpError && e.code === 'BAD_REQUEST',
    );
    assert.equal(cdc.getActiveQueryCount(), 0, 'no group left behind by rejected deep watches');
  });

  it('depth:1 query watch works end-to-end (explicit depth)', async () => {
    const events: NodeEvent[] = [];
    const { tree, cdc } = withSubs(createMemoryTree(), e => events.push(e));
    cdc.watchQuery({ vp: '/views/open', userId: 'u1', plan: { source: '/items', depth: 1, viewWhere: { status: 'open' } }, mountDeps: new Set(['/views/open']) });

    await tree.set({ ...createNode('/items/1', 'item'), status: 'open' });
    const ev = events.find(e => (e.type === 'set' || e.type === 'patch') && e.path === '/items/1');
    assert.ok(ev?.invalidateVps?.includes('/views/open'), 'depth:1 membership flip dirties the view');
  });

  it('group GC: the last handle removal drops the group', async () => {
    const { cdc } = withSubs(createMemoryTree());
    cdc.watchQuery({ vp: '/views/a', userId: 'u1', plan: { source: '/items', viewWhere: { s: 1 } }, mountDeps: new Set(['/views/a']) });
    cdc.watchQuery({ vp: '/views/b', userId: 'u2', plan: { source: '/items', viewWhere: { s: 1 } }, mountDeps: new Set(['/views/b']) });
    assert.equal(cdc.getActiveQueryCount(), 1);

    cdc.unwatchQuery('/views/a', 'u1');
    assert.equal(cdc.getActiveQueryCount(), 1, 'group survives while another handle references it');
    cdc.unwatchQuery('/views/b', 'u2');
    assert.equal(cdc.getActiveQueryCount(), 0, 'last handle removal GCs the group');
  });
});

describe('actor-projected membership (F4, core-anz4.3)', () => {
  // Real security projection with fixed per-user claims — perms and component
  // stripping resolved by the same code the read path uses.
  const claimsOf: Record<string, string[]> = { u1: ['users'], admin: ['admins'] };
  const projectFor = (store: Tree): MembershipProjector => async (userId, o, n) => {
    const project = createProjector(store, { userId, claims: claimsOf[userId] ?? [] });
    return [o ? await project(o) : null, n ? await project(n) : null];
  };

  it('a hidden component field cannot gate membership — flip judged per actor projection', async () => {
    const store = createMemoryTree();
    const events: NodeEvent[] = [];
    const { tree, cdc } = withSubscriptions(store, e => events.push(e), { projectMembership: projectFor(store) });

    await tree.set({ ...createNode('/board', 'dir'), $acl: [{ g: 'users', p: R }, { g: 'admins', p: R }] });
    // #secret readable by admins only — u1 matches no component-ACL entry.
    await tree.set({
      ...createNode('/board/t1', 'task'), status: 'draft',
      '#secret': { $type: 'x.secret', level: 7, $acl: [{ g: 'admins', p: R }] },
    });

    // Same plan for both actors → ONE group, membership diverges per actor.
    const plan = { source: '/board', viewWhere: { $and: [{ status: 'active' }, { '#secret.level': 7 }] } };
    cdc.watchQuery({ vp: '/views/u1', userId: 'u1', plan, mountDeps: new Set(['/views/u1']) });
    cdc.watchQuery({ vp: '/views/admin', userId: 'admin', plan, mountDeps: new Set(['/views/admin']) });
    assert.equal(cdc.getActiveQueryCount(), 1, 'same plan registers one group with two actors');

    // Flip via the VISIBLE field only — the hidden field gates the predicate.
    // Raw eval would enter the vp for BOTH actors (level=7 matches raw);
    // projected eval strips #secret for u1, so u1 must see NO enter.
    events.length = 0;
    await tree.patch('/board/t1', [['r', 'status', 'active']]);
    const ev = events.find(e => (e.type === 'set' || e.type === 'patch') && e.path === '/board/t1');
    assert.ok(ev, 'patch event emitted');
    assert.ok(ev.invalidateVps?.includes('/views/admin'), 'admin reads #secret → enter dirties their view');
    assert.ok(!ev.invalidateVps?.includes('/views/u1'), 'hidden-field-gated flip must not signal u1');
  });

  it('a node the actor cannot read never flips their membership (executeList parity)', async () => {
    const store = createMemoryTree();
    const events: NodeEvent[] = [];
    const { tree, cdc } = withSubscriptions(store, e => events.push(e), { projectMembership: projectFor(store) });

    await tree.set({ ...createNode('/board', 'dir'), $acl: [{ g: 'users', p: R }, { g: 'admins', p: R }] });
    // t1 readable by admins only — sticky deny-all for users.
    await tree.set({ ...createNode('/board/t1', 'task'), score: 50, $acl: [{ g: 'users', p: 0 }, { g: 'admins', p: R }] });

    const plan = { source: '/board', viewWhere: { score: { $gt: 100 } } };
    cdc.watchQuery({ vp: '/views/u1', userId: 'u1', plan, mountDeps: new Set(['/views/u1']) });
    cdc.watchQuery({ vp: '/views/admin', userId: 'admin', plan, mountDeps: new Set(['/views/admin']) });

    events.length = 0;
    await tree.patch('/board/t1', [['r', 'score', 150]]);
    const ev = events.find(e => (e.type === 'set' || e.type === 'patch') && e.path === '/board/t1');
    assert.ok(ev?.invalidateVps?.includes('/views/admin'), 'readable actor gets the flip');
    assert.ok(!ev?.invalidateVps?.includes('/views/u1'), 'R-denied node must not signal membership to u1');
  });

  it('co-watchers of ONE vp: a flip invisible to B\'s projection routes to A only; coarse dirty reaches both (core-anz4.27, §6.3)', async () => {
    // The verify-probe scenario: membershipVps used to flatten per-user flips
    // into string[] — B received A's flip as a timing/existence oracle.
    const store = createMemoryTree();
    const watcher = createWatchManager();
    const { tree, cdc } = withSubscriptions(store, e => watcher.notify(e), { projectMembership: projectFor(store) });
    const adminGot: NodeEvent[] = [];
    const u1Got: NodeEvent[] = [];
    watcher.connect('cA', 'admin', e => adminGot.push(e.event));
    watcher.connect('cB', 'u1', e => u1Got.push(e.event));
    watcher.watch('admin', ['/views/shared'], { children: true });
    watcher.watch('u1', ['/views/shared'], { children: true });

    await tree.set({ ...createNode('/board', 'dir'), $acl: [{ g: 'users', p: R }, { g: 'admins', p: R }] });
    await tree.set({
      ...createNode('/board/t1', 'task'), status: 'draft',
      '#secret': { $type: 'x.secret', level: 7, $acl: [{ g: 'admins', p: R }] },
    });

    const plan = { source: '/board', viewWhere: { $and: [{ status: 'active' }, { '#secret.level': 7 }] } };
    cdc.watchQuery({ vp: '/views/shared', userId: 'u1', plan, mountDeps: new Set(['/views/shared']) });
    cdc.watchQuery({ vp: '/views/shared', userId: 'admin', plan, mountDeps: new Set(['/views/shared']) });
    adminGot.length = 0;
    u1Got.length = 0;

    // Flip gated by the admin-only #secret: admin's projection enters, u1's never was a member.
    await tree.patch('/board/t1', [['r', 'status', 'active']]);

    const flip = adminGot.find(e => e.invalidateVps?.includes('/views/shared'));
    assert.ok(flip, 'flipped user receives the membership dirty');
    assert.equal(flip.membershipAudience, undefined, 'audience map is routing-internal — stripped before delivery');
    assert.equal(u1Got.length, 0, 'co-watcher whose own projection did not flip receives NOTHING');

    // Coarse source (ACL change) stays user-independent broadcast (owner-approved §6.3).
    const t1 = await store.get('/board/t1');
    await tree.set({ ...t1!, $acl: [{ g: 'users', p: R }, { g: 'admins', p: R }] });
    assert.ok(u1Got.some(e => e.invalidateVps?.includes('/views/shared')), 'coarse ACL dirty reaches the non-flipped co-watcher');
    assert.ok(adminGot.some(e => e !== flip && e.invalidateVps?.includes('/views/shared')), 'and the flipped one');
  });

  it('query watch registration fails closed without a membership projector', () => {
    const { cdc } = withSubscriptions(createMemoryTree());
    assert.throws(
      () => cdc.watchQuery({ vp: '/views/x', userId: 'u1', plan: { source: '/items', viewWhere: { status: 'open' } }, mountDeps: new Set(['/views/x']) }),
      (e: unknown) => e instanceof OpError && e.code === 'FORBIDDEN',
    );
    assert.equal(cdc.getActiveQueryCount(), 0, 'refused registration leaves no group');
  });

  it('registration parity: the plan a watch registers is the one executeList vetted (core-fnv coupling)', async () => {
    const store = createMemoryTree();
    await store.set({ ...createNode('/board', 'dir'), $acl: [{ g: 'users', p: R }, { g: 'admins', p: R }] });
    await store.set({
      ...createNode('/board/t1', 'task'), status: 'active',
      '#secret': { $type: 'x.secret', level: 7, $acl: [{ g: 'admins', p: R }] },
    });

    // Registration is reachable ONLY through a successful read of the same
    // frozen plan (the wire threads ONE planChildren object to both — ns6p.4
    // invariant 21). Non-privileged caller: the read of that plan dies with
    // FORBIDDEN ⇒ no page ⇒ nothing to register.
    const u1Tree = withAcl(store, 'u1', ['users']);
    const u1Plan = await u1Tree.planChildren('/board', { query: { '#secret.level': 7 } });
    await assert.rejects(
      () => u1Tree.getChildren('/board', { query: { '#secret.level': 7 }, plan: u1Plan }),
      (e: unknown) => e instanceof OpError && e.code === 'FORBIDDEN',
    );

    // Privileged caller: the SAME frozen object drives read and registration.
    const adminTree = withAcl(store, 'admin', ['admins']);
    const readPlan = await adminTree.planChildren('/board', { query: { '#secret.level': 7 } });
    const page = await adminTree.getChildren('/board', { query: { '#secret.level': 7 }, plan: readPlan });
    assert.equal(page.items.length, 1);
    const { cdc } = withSubs(store);
    cdc.watchQuery({ vp: '/board', userId: 'admin', plan: readPlan.plan, mountDeps: readPlan.mountDeps });
    assert.equal(cdc.getActiveQueryCount(), 1);
  });
});

// ── onSelfWrite — channel for external-watch dedup ──

describe('withSubscriptions.onSelfWrite', () => {
  it('fires on set with (path, rev)', async () => {
    const { tree, onSelfWrite } = withSubs(createMemoryTree());
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
    const { tree, onSelfWrite } = withSubs(tree0);
    await tree.set({ ...createNode('/n', 'test'), n: 0 } as any);

    const calls: Array<[string, number | undefined]> = [];
    onSelfWrite((p, r) => calls.push([p, r]));

    await tree.patch('/n', [['r', 'n', 5]]);

    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], '/n');
    assert.ok(typeof calls[0][1] === 'number', 'patch fires with rev');
  });

  it('fires on remove with undefined rev', async () => {
    const { tree, onSelfWrite } = withSubs(createMemoryTree());
    await tree.set(createNode('/x', 'test'));

    const calls: Array<[string, number | undefined]> = [];
    onSelfWrite((p, r) => calls.push([p, r]));

    await tree.remove('/x');

    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], '/x');
    assert.equal(calls[0][1], undefined);
  });

  it('multiple listeners — all fired', async () => {
    const { tree, onSelfWrite } = withSubs(createMemoryTree());
    const a: string[] = [];
    const b: string[] = [];
    onSelfWrite((p) => a.push(p));
    onSelfWrite((p) => b.push(p));

    await tree.set(createNode('/x', 'test'));

    assert.equal(a.length, 1);
    assert.equal(b.length, 1);
  });

  it('unsubscribe stops further calls', async () => {
    const { tree, onSelfWrite } = withSubs(createMemoryTree());
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
    const { tree, cdc, injectExternalEvent } = withSubs(createMemoryTree(), e => events.push(e));

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
    const { tree, cdc, injectExternalEvent } = withSubs(createMemoryTree(), e => events.push(e));

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
    const { tree, onSelfWrite, injectExternalEvent } = withSubs(createMemoryTree());
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
    const { injectExternalEvent } = withSubs(createMemoryTree(), e => events.push(e));

    injectExternalEvent({ type: 'reconnect', preserved: false });

    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'reconnect');
    if (events[0].type === 'reconnect') assert.equal(events[0].preserved, false);
  });

  it('throwing listener does not break the write or other listeners', async () => {
    const { tree, onSelfWrite } = withSubs(createMemoryTree());

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

// ── Opaque receipts (core-ns6p.2): remote authority, changes: null ──
// A transport tree cannot see the authority's images — subs degrade to the
// coarse external-write dirty set + the image-free detectors, and the event
// carries the authority's post-image (one read).

describe('opaque receipts (core-ns6p.2)', () => {
  /** Memory tree whose mutations commit for real but report changes: null. */
  function opaqueTree(): Tree {
    const mem = createMemoryTree();
    return {
      ...mem,
      set: async (n, c) => { await mem.set(n, c); return { changes: null }; },
      patch: async (p, o, c) => { await mem.patch(p, o, c); return { changes: null }; },
      remove: async (p, c) => { await mem.remove(p, c); return { changes: null }; },
    };
  }

  it('opaque set emits the authority post-image and dirties watched queries coarsely', async () => {
    const inner = opaqueTree();
    const { tree, cdc } = withSubs(inner);
    cdc.watchQuery({ vp: '/views/items', userId: 'u1', plan: { source: '/items' }, mountDeps: new Set(['/views/items']) });
    const events: NodeEvent[] = [];
    cdc.subscribe('/items/a', (e) => events.push(e));

    await tree.set(createNode('/items/a', 'doc', { v: 1 }));

    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'set');
    assert.ok(events[0].invalidateVps?.includes('/views/items'), 'coarse external-path dirty reaches the query watcher');
  });

  it('opaque set whose post-read finds nothing emits remove, never silence', async () => {
    const mem = createMemoryTree();
    // set commits then the node vanishes (concurrent remote remove won).
    const inner: Tree = {
      ...mem,
      get: async () => undefined,
      set: async () => ({ changes: null }),
    };
    const { tree, cdc } = withSubs(inner);
    const events: NodeEvent[] = [];
    cdc.subscribe('/items/a', (e) => events.push(e));

    await tree.set(createNode('/items/a', 'doc', { v: 1 }));

    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'remove', 'current state is reflected loudly');
  });

  it('remove that reveals a lower node emits set (the view still serves it), not remove', async () => {
    const mem = createMemoryTree();
    // Overlay-style receipt: remove uncovers a lower image.
    const inner: Tree = {
      ...mem,
      remove: async (p) => ({ changes: [{ path: p, before: { $path: p, $type: 'doc', v: 'up' }, after: { $path: p, $type: 'doc', v: 'low', $rev: 3 } }] }),
    };
    const { tree, cdc } = withSubs(inner);
    const events: NodeEvent[] = [];
    cdc.subscribe('/x', (e) => events.push(e));

    await tree.remove('/x');

    assert.equal(events.length, 1);
    assert.notEqual(events[0].type, 'remove', 'a revealed node must not be deleted client-side');
  });

  it('opaque write to a claims path dirties every query view of that user', async () => {
    const inner = opaqueTree();
    const { tree, cdc } = withSubs(inner, undefined, detectors);
    cdc.watchQuery({ vp: '/views/mine', userId: 'alice', plan: { source: '/stuff' }, mountDeps: new Set(['/views/mine']) });
    const events: NodeEvent[] = [];
    cdc.subscribe('/auth/users/alice', (e) => events.push(e));

    await tree.set(createNode('/auth/users/alice', 'user', { role: 'admin' }));

    assert.equal(events.length, 1);
    assert.ok(events[0].invalidateVps?.includes('/views/mine'), 'claims change dirties the user\'s views even without images');
  });
});
