// Tests for watch event ACL filtering:
// - filterPatches: component-level patch filtering (PatchOp tuples, dot paths)
// - filteredPush behavior: claims caching, set/patch/remove event handling
// - remove event ACL: parent-based permission check for deleted nodes
// - F10: set event uses stored node $owner/$acl, not writer-supplied payload

import { createNode, R, W, register } from '#core';
import { resolvePermission } from '#security/acl';
import { createMemoryTree, type PatchOp } from '#tree';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { NodeData } from '#core';
import { createFilteredPush, filterPatches } from './watch-filter';
import type { RouteEnvelope, StampedEvent } from './watch';
import type { NodeEvent, WireEvent } from './index';

/** Build the per-recipient route envelope the WatchManager delivers (ns6p.4
 *  §3.4): `held` mirrors which of the recipient's registrations matched. */
const env = (event: StampedEvent, held?: { paths?: string[]; vps?: string[] }): RouteEnvelope =>
  ({ event, heldPaths: held?.paths ?? [], heldVps: held?.vps ?? [] });

// ── filterPatches (real implementation, tested directly) ──

describe('filterPatches — component-level ACL on patch events', () => {
  // Node with a public component and a restricted component
  const node: NodeData = {
    $path: '/test',
    $type: 'test.node',
    $owner: 'alice',
    title: 'Hello', // plain field, not a component
    '#publicComp': { $type: 'public.comp', data: 'visible' },
    '#secretComp': {
      $type: 'secret.comp',
      apiKey: 'sk-123',
      $acl: [{ g: 'admin', p: R }, { g: 'authenticated', p: 0 }],
    },
  };

  it('passes ops targeting plain fields', () => {
    const patches: PatchOp[] = [
      ['r', 'title', 'Updated'],
    ];
    const filtered = filterPatches(patches, node, 'bob', ['authenticated', 'u:bob'], false);
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0][1], 'title');
  });

  it('passes $rev (public version bump) regardless of A', () => {
    const patches: PatchOp[] = [
      ['r', '$rev', 5],
    ];
    const filtered = filterPatches(patches, node, 'bob', ['authenticated', 'u:bob'], false);
    assert.equal(filtered.length, 1);
  });

  it('drops $acl/$owner patches for non-admin (R but not A)', () => {
    const patches: PatchOp[] = [
      ['r', '$acl', []],
      ['r', '$owner', 'mallory'],
      ['r', '$secret', 'leak'],
    ];
    const filtered = filterPatches(patches, node, 'bob', ['authenticated', 'u:bob'], false);
    assert.equal(filtered.length, 0, '$acl/$owner/$secret leak ACL state to non-admin viewers');
  });

  it('passes $acl/$owner patches for admin (has A)', () => {
    const patches: PatchOp[] = [
      ['r', '$acl', []],
      ['r', '$owner', 'newuser'],
    ];
    const filtered = filterPatches(patches, node, 'admin-user', ['admin', 'authenticated'], true);
    assert.equal(filtered.length, 2);
  });

  it('drops patch for component absent in stored — fail closed (could be removed restricted comp)', () => {
    const patches: PatchOp[] = [
      ['d', '#missingComp'],
    ];
    // missingComp not in stored node — without an oldNode snapshot, treat as restricted unless caller has A.
    const filtered = filterPatches(patches, node, 'bob', ['authenticated', 'u:bob'], false);
    assert.equal(filtered.length, 0);
  });

  it('passes patch for absent component when caller has A', () => {
    const patches: PatchOp[] = [
      ['d', '#missingComp'],
    ];
    const filtered = filterPatches(patches, node, 'admin-user', ['admin', 'authenticated'], true);
    assert.equal(filtered.length, 1);
  });

  it('passes ops targeting components user can read', () => {
    const patches: PatchOp[] = [
      ['r', '#publicComp.data', 'new'],
    ];
    const filtered = filterPatches(patches, node, 'bob', ['authenticated', 'u:bob'], false);
    assert.equal(filtered.length, 1);
  });

  it('filters ops targeting restricted components', () => {
    const patches: PatchOp[] = [
      ['r', '#secretComp.apiKey', 'sk-new'],
    ];
    // bob is authenticated but secretComp denies authenticated (p=0), only admin gets R
    const filtered = filterPatches(patches, node, 'bob', ['authenticated', 'u:bob'], false);
    assert.equal(filtered.length, 0);
  });

  it('admin can see restricted component patches', () => {
    const patches: PatchOp[] = [
      ['r', '#secretComp.apiKey', 'sk-new'],
    ];
    const filtered = filterPatches(patches, node, 'admin-user', ['authenticated', 'admin', 'u:admin-user'], true);
    assert.equal(filtered.length, 1);
  });

  it('filters mixed patches — keeps permitted, drops restricted', () => {
    const patches: PatchOp[] = [
      ['r', 'title', 'Updated'],
      ['r', '#publicComp.data', 'new'],
      ['r', '#secretComp.apiKey', 'sk-leaked'],
    ];
    const filtered = filterPatches(patches, node, 'bob', ['authenticated', 'u:bob'], false);
    assert.equal(filtered.length, 2);
    assert.ok(filtered.every(p => !p[1].startsWith('#secretComp')));
  });

  it('drops event when ALL ops target restricted components', () => {
    const patches: PatchOp[] = [
      ['r', '#secretComp.apiKey', 'sk-new'],
      ['a', '#secretComp.secret2', 'hidden'],
    ];
    const filtered = filterPatches(patches, node, 'bob', ['authenticated', 'u:bob'], false);
    assert.equal(filtered.length, 0);
    // Caller should skip emit entirely when filtered.length === 0
  });

  it('drops root-level empty patch path — replaces whole node, must not bypass ACL', () => {
    // Empty dot-path → seg === '' → not $-prefixed, val === undefined → fail closed
    const patches: PatchOp[] = [
      ['r', '', {}],
    ];
    const filtered = filterPatches(patches, node, 'bob', ['authenticated', 'u:bob'], false);
    assert.equal(filtered.length, 0);
  });
});

// ── Remove event ACL — root cause and fix verification ──

describe('remove event ACL — parent-based permission', () => {
  it('resolvePermission returns 0 for deleted node (root cause)', async () => {
    const tree = createMemoryTree();

    // Node whose only R grant comes from its own $acl via $owner
    const task = createNode('/tasks/t1', 'task');
    task.$owner = 'alice';
    task.$acl = [{ g: 'owner', p: R | W }];
    await tree.set(task);

    const before = await resolvePermission(tree, '/tasks/t1', 'alice', ['u:alice', 'authenticated']);
    assert.ok(before & R, 'alice can read before delete');

    await tree.remove('/tasks/t1');

    const after = await resolvePermission(tree, '/tasks/t1', 'alice', ['u:alice', 'authenticated']);
    assert.equal(after, 0, 'ACL check on deleted node returns 0 — this caused remove events to be silently dropped');
  });

  it('parent ACL resolves correctly after child is deleted', async () => {
    const tree = createMemoryTree();

    const parent = createNode('/tasks', 'dir');
    parent.$acl = [{ g: 'authenticated', p: R }];
    await tree.set(parent);

    await tree.set(createNode('/tasks/t1', 'task'));
    await tree.remove('/tasks/t1');

    // Parent still grants R — remove event should be delivered via parent check
    const perm = await resolvePermission(tree, '/tasks', 'alice', ['u:alice', 'authenticated']);
    assert.ok(perm & R, 'parent perm survives child deletion');
  });

  it('unauthorized user cannot read parent — remove event should be blocked', async () => {
    const tree = createMemoryTree();

    const parent = createNode('/secret', 'dir');
    parent.$acl = [{ g: 'admins', p: R | W }, { g: 'authenticated', p: 0 }];
    await tree.set(parent);

    await tree.set(createNode('/secret/doc1', 'doc'));
    await tree.remove('/secret/doc1');

    // bob is authenticated but parent denies authenticated — remove must NOT be delivered
    const perm = await resolvePermission(tree, '/secret', 'bob', ['u:bob', 'authenticated']);
    assert.equal(perm, 0, 'unauthorized user blocked by parent ACL');
  });
});

// F10: ACL decisions for set events must use stored node, not writer-supplied event payload.
// A path bypassing withAcl could craft an event with poisoned $owner; watch-filter must ignore it.
describe('F10 — set event uses stored node for ACL, not event payload', () => {
  it('poisoned $owner in event.node does not grant owner-level component visibility', async () => {
    const tree = createMemoryTree();

    // Stored: real owner is admin, /x readable by authenticated, secret readable by owner only.
    const stored: NodeData = {
      $path: '/x',
      $type: 't',
      $owner: 'admin',
      $acl: [{ g: 'authenticated', p: R }],
      '#secret': { $type: 'sec', apiKey: 'sk-real', $acl: [{ g: 'owner', p: R }, { g: 'authenticated', p: 0 }] },
    };
    await tree.set(stored);

    const events: WireEvent[] = [];
    const filtered = createFilteredPush(tree, 'bob', ['u:bob', 'authenticated'], (e) => { events.push(e); });

    // Crafted event with poisoned $owner='bob' — pretends bob is owner.
    const poisoned: NodeEvent = {
      type: 'set',
      path: '/x',
      node: {
        $type: 't',
        $owner: 'bob',
        $acl: [{ g: 'authenticated', p: R }],
        secret: { $type: 'sec', apiKey: 'sk-real', $acl: [{ g: 'owner', p: R }, { g: 'authenticated', p: 0 }] },
      },
    };
    filtered(env(poisoned));

    // filterEvent is async — wait for microtasks to drain
    await new Promise(r => setImmediate(r));

    assert.equal(events.length, 1, 'event delivered to bob (R on /x via authenticated)');
    const evt = events[0];
    if (evt.type !== 'set') throw new Error(`expected set event, got ${evt.type}`);
    assert.equal(evt.node['#secret'], undefined, 'secret stripped — bob is not real owner of stored node');
  });

  it('set event hides $acl/$owner from a reader without A (same projection as get)', async () => {
    const tree = createMemoryTree();
    await tree.set({ $path: '/doc', $type: 't', $owner: 'alice', $acl: [{ g: 'authenticated', p: R }, { g: 'hr', p: R }] });

    const events: WireEvent[] = [];
    const filtered = createFilteredPush(tree, 'bob', ['u:bob', 'authenticated'], (e) => { events.push(e); });
    filtered(env({ type: 'set', path: '/doc', node: { $type: 't' } }));
    await new Promise(r => setImmediate(r));

    const evt = events[0];
    if (evt?.type !== 'set') throw new Error(`expected set event, got ${evt?.type}`);
    assert.equal(evt.node.$acl, undefined);
    assert.equal(evt.node.$owner, undefined);
  });

  it('set event whose stored node is gone (race with remove) → payload dropped, invalidate signals the holder', async () => {
    // ns6p.4 invariant 16: the payload stays dropped (never push writer-supplied
    // body unverified), but the routed drop must SIGNAL — the exact holder
    // refetches, sees the node gone, and evicts instead of staling forever.
    const tree = createMemoryTree();

    const node: NodeData = {
      $path: '/x', $type: 't',
      $acl: [{ g: 'authenticated', p: R }],
    };
    await tree.set(node);

    const events: WireEvent[] = [];
    const filtered = createFilteredPush(tree, 'bob', ['u:bob', 'authenticated'], (e) => { events.push(e); });

    // Remove the node, then deliver a stale set event
    await tree.remove('/x');

    const stale: NodeEvent = {
      type: 'set', path: '/x', node: { $type: 't', $acl: [{ g: 'authenticated', p: R }] },
    };
    filtered(env(stale, { paths: ['/x'] }));
    await new Promise(r => setImmediate(r));

    assert.equal(events.length, 1, 'routed drop must signal, never silence');
    const ev = events[0];
    if (ev.type !== 'invalidate') throw new Error(`expected invalidate, got ${ev.type}`);
    assert.deepEqual(ev.paths, ['/x']);
    assert.ok(!('node' in ev), 'no payload leaked');
  });
});

// ── Per-session delivery order — patch-based wire protocol requires it ──

describe('filteredPush — serialized per-session delivery', () => {
  const CLAIMS = ['u:bob', 'authenticated'];

  async function setupNodes() {
    const tree = createMemoryTree();
    const mk = (path: string) => {
      const n = createNode(path, 't', { x: 0 });
      n.$acl = [{ g: 'authenticated', p: R }];
      return n;
    };
    await tree.set(mk('/slow'));
    await tree.set(mk('/fast'));
    return tree;
  }

  // Injects latency into ACL/stored-node lookups for one path — the window
  // where an unserialized filter lets a later event overtake an earlier one.
  function withSlowGet(tree: ReturnType<typeof createMemoryTree>, slowPath: string) {
    const slow: typeof tree = {
      ...tree,
      async get(path, ctx) {
        if (path === slowPath) await new Promise(r => setTimeout(r, 20));
        return tree.get(path, ctx);
      },
    };
    return slow;
  }

  it('events arrive in emit order even when the first needs slower ACL lookups', async () => {
    const tree = withSlowGet(await setupNodes(), '/slow');

    const delivered: string[] = [];
    let done!: () => void;
    const all = new Promise<void>(r => { done = r; });
    const filtered = createFilteredPush(tree, 'bob', CLAIMS, (e) => {
      delivered.push((e as { path?: string }).path ?? e.type);
      if (delivered.length === 2) done();
    });

    filtered(env({ type: 'patch', path: '/slow', patches: [['r', 'x', 1]], rev: 2 }));
    filtered(env({ type: 'patch', path: '/fast', patches: [['r', 'x', 1]], rev: 2 }));
    await all;

    assert.deepEqual(delivered, ['/slow', '/fast']);
  });

  it('reconnect does not overtake a slower data event', async () => {
    const tree = withSlowGet(await setupNodes(), '/slow');

    const delivered: string[] = [];
    let done!: () => void;
    const all = new Promise<void>(r => { done = r; });
    const filtered = createFilteredPush(tree, 'bob', CLAIMS, (e) => {
      delivered.push(e.type);
      if (delivered.length === 2) done();
    });

    filtered(env({ type: 'patch', path: '/slow', patches: [['r', 'x', 1]], rev: 2 }));
    filtered(env({ type: 'reconnect', preserved: true }));
    await all;

    assert.deepEqual(delivered, ['patch', 'reconnect']);
  });

  it('a failing event falls back to an invalidate (loud), the chain recovers and stays ordered', async (t) => {
    // ns6p.4 invariant 16: a filter exception fails closed on the PAYLOAD but
    // must still signal the holder — silence would freeze their cache forever.
    const base = await setupNodes();
    const failing: typeof base = {
      ...base,
      async get(path, ctx) {
        if (path === '/slow') throw new Error('storage hiccup');
        return base.get(path, ctx);
      },
    };
    const errors = t.mock.method(console, 'error');

    const delivered: WireEvent[] = [];
    let done!: () => void;
    const all = new Promise<void>(r => { done = r; });
    const filtered = createFilteredPush(failing, 'bob', CLAIMS, (e) => {
      delivered.push(e);
      if (delivered.length === 2) done();
    });

    filtered(env({ type: 'patch', path: '/slow', patches: [['r', 'x', 1]], rev: 2 }, { paths: ['/slow'] }));
    filtered(env({ type: 'patch', path: '/fast', patches: [['r', 'x', 1]], rev: 2 }));
    await all;

    assert.equal(delivered.length, 2);
    const fallback = delivered[0];
    if (fallback.type !== 'invalidate') throw new Error(`expected invalidate fallback, got ${fallback.type}`);
    assert.deepEqual(fallback.paths, ['/slow'], 'provenance-held path signalled');
    assert.ok(!('patches' in fallback), 'no payload leaked through the failure');
    assert.equal((delivered[1] as { path?: string }).path, '/fast', 'chain recovered, order kept');
    assert.ok(errors.mock.calls.length >= 1, 'the failure is logged, not swallowed');
  });
});

// ── Pathless invalidate fallback (core-dm1/0i3) ──
// A data event that dirties a query view but is ACL-dropped for the reader must
// still deliver the coarse "refetch this view" signal — otherwise the reader
// (who just lost access to the node that moved) keeps a stale row forever.

describe('watch-filter — invalidate fallback on ACL-dropped events', () => {
  const drain = () => new Promise(r => setImmediate(r));
  const BOB = ['u:bob', 'authenticated'];

  it('reader lost R on the mutated node → pathless invalidate, no path/payload leaked', async () => {
    const tree = createMemoryTree();
    // authenticated p=0 denies bob R on /x
    await tree.set({ $path: '/x', $type: 't', $acl: [{ g: 'authenticated', p: 0 }], title: 'hi' } as NodeData);

    const events: WireEvent[] = [];
    const filtered = createFilteredPush(tree, 'bob', BOB, (e) => events.push(e));
    filtered(env(
      { type: 'set', path: '/x', node: { $type: 't', title: 'hi' }, invalidateVps: ['/views/open'], seq: 7, epoch: 'E1' },
      { vps: ['/views/open'] },
    ));
    await drain();

    assert.equal(events.length, 1, 'invalidate delivered despite the reader losing access');
    const ev = events[0];
    if (ev.type !== 'invalidate') throw new Error(`expected invalidate, got ${ev.type}`);
    assert.deepEqual(ev.vps, ['/views/open']);
    assert.equal(ev.seq, 7, 'seq preserved so the resume watermark advances in lockstep');
    assert.equal(ev.epoch, 'E1', 'epoch preserved — a signal-only client must still learn it (anz4.28e)');
    assert.ok(!('path' in ev), 'no node path leaked to a reader who cannot see it');
    assert.ok(!('paths' in ev), 'vp-only recipient: held no exact path, learns no path');
    assert.ok(!('node' in ev), 'no payload leaked');
  });

  it('every patch op ACL-hidden → invalidate instead of a silent drop', async () => {
    const tree = createMemoryTree();
    await tree.set({
      $path: '/x', $type: 't', $acl: [{ g: 'authenticated', p: R }],
      '#secret': { $type: 'sec', k: 'v', $acl: [{ g: 'authenticated', p: 0 }] },
    } as NodeData);

    const events: WireEvent[] = [];
    const filtered = createFilteredPush(tree, 'bob', BOB, (e) => events.push(e));
    // bob has R on /x but not on #secret — the only op targets the hidden comp
    filtered(env(
      { type: 'patch', path: '/x', patches: [['r', '#secret.k', 'v2']], rev: 3, invalidateVps: ['/views/open'] },
      { vps: ['/views/open'] },
    ));
    await drain();

    assert.equal(events.length, 1);
    const ev = events[0];
    if (ev.type !== 'invalidate') throw new Error(`expected invalidate, got ${ev.type}`);
    assert.deepEqual(ev.vps, ['/views/open']);
  });

  it('remove under an unreadable parent → invalidate still reaches the vp watcher', async () => {
    const tree = createMemoryTree();
    await tree.set({ $path: '/secret', $type: 'dir', $acl: [{ g: 'authenticated', p: 0 }] } as NodeData);

    const events: WireEvent[] = [];
    const filtered = createFilteredPush(tree, 'bob', BOB, (e) => events.push(e));
    filtered(env({ type: 'remove', path: '/secret/doc', invalidateVps: ['/views/open'] }, { vps: ['/views/open'] }));
    await drain();

    assert.equal(events.length, 1);
    const ev = events[0];
    if (ev.type !== 'invalidate') throw new Error(`expected invalidate, got ${ev.type}`);
    assert.deepEqual(ev.vps, ['/views/open']);
  });

  it('exact-path holder: dropped payload → invalidate names the HELD path (ns6p.4 §3.4)', async () => {
    // Pre-slice-1 this was the silent-drop hole: no invalidateVps → nothing
    // emitted, the exact holder kept a stale cache forever. Invariant 16:
    // every routed drop signals; provenance bounds what it may name.
    const tree = createMemoryTree();
    await tree.set({ $path: '/x', $type: 't', $acl: [{ g: 'authenticated', p: 0 }], title: 'hi' } as NodeData);

    const events: WireEvent[] = [];
    const filtered = createFilteredPush(tree, 'bob', BOB, (e) => events.push(e));
    filtered(env({ type: 'set', path: '/x', node: { $type: 't', title: 'hi' }, seq: 3, epoch: 'E1' }, { paths: ['/x'] }));
    await drain();

    assert.equal(events.length, 1, 'routed drop must signal the exact holder');
    const ev = events[0];
    if (ev.type !== 'invalidate') throw new Error(`expected invalidate, got ${ev.type}`);
    assert.deepEqual(ev.paths, ['/x'], 'held path named — recipient already holds it, no reveal');
    assert.deepEqual(ev.vps, [], 'vps stays present (min []) for old clients');
    assert.equal(ev.seq, 3);
    assert.equal(ev.epoch, 'E1');
    assert.ok(!('node' in ev), 'no payload leaked');
  });

  it('same dropped event, vp-only recipient: vps only, NEVER the source path (anz4.27-adjacent pin)', async () => {
    const tree = createMemoryTree();
    await tree.set({ $path: '/x', $type: 't', $acl: [{ g: 'authenticated', p: 0 }], title: 'hi' } as NodeData);

    const events: WireEvent[] = [];
    const filtered = createFilteredPush(tree, 'bob', BOB, (e) => events.push(e));
    // Routed to this recipient only via their query view — the envelope holds
    // no exact path, so the fallback may not name one.
    filtered(env(
      { type: 'set', path: '/x', node: { $type: 't', title: 'hi' }, invalidateVps: ['/views/open'], seq: 4 },
      { vps: ['/views/open'] },
    ));
    await drain();

    assert.equal(events.length, 1);
    const ev = events[0];
    if (ev.type !== 'invalidate') throw new Error(`expected invalidate, got ${ev.type}`);
    assert.deepEqual(ev.vps, ['/views/open']);
    assert.ok(!('paths' in ev), 'hidden source path stays hidden from a vp-only recipient');
    assert.ok(!('path' in ev), 'no bare path either');
  });

  it('drop with empty provenance still signals (seq watermark advances, nothing named)', async () => {
    const tree = createMemoryTree();
    await tree.set({ $path: '/x', $type: 't', $acl: [{ g: 'authenticated', p: 0 }], title: 'hi' } as NodeData);

    const events: WireEvent[] = [];
    const filtered = createFilteredPush(tree, 'bob', BOB, (e) => events.push(e));
    filtered(env({ type: 'set', path: '/x', node: { $type: 't', title: 'hi' }, seq: 5 }));
    await drain();

    assert.equal(events.length, 1, 'invariant 16: every routed drop produces a signal');
    const ev = events[0];
    if (ev.type !== 'invalidate') throw new Error(`expected invalidate, got ${ev.type}`);
    assert.deepEqual(ev.vps, []);
    assert.ok(!('paths' in ev));
    assert.equal(ev.seq, 5);
  });

  it('reader RETAINS access → normal data event with invalidateVps, no invalidate frame', async () => {
    const tree = createMemoryTree();
    await tree.set({ $path: '/x', $type: 't', $acl: [{ g: 'authenticated', p: R }], title: 'hi' } as NodeData);

    const events: WireEvent[] = [];
    const filtered = createFilteredPush(tree, 'bob', BOB, (e) => events.push(e));
    filtered(env(
      { type: 'set', path: '/x', node: { $type: 't', title: 'hi' }, invalidateVps: ['/views/open'], seq: 4 },
      { vps: ['/views/open'] },
    ));
    await drain();

    assert.equal(events.length, 1);
    const ev = events[0];
    // Readable → the field mechanism carries the signal on the data event itself.
    assert.equal(ev.type, 'set');
    assert.deepEqual('invalidateVps' in ev ? ev.invalidateVps : undefined, ['/views/open']);
  });
});
