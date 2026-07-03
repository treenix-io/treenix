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
import type { NodeEvent } from './index';

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

    const events: NodeEvent[] = [];
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
    filtered(poisoned);

    // filterEvent is async — wait for microtasks to drain
    await new Promise(r => setImmediate(r));

    assert.equal(events.length, 1, 'event delivered to bob (R on /x via authenticated)');
    const evt = events[0];
    if (evt.type !== 'set') throw new Error(`expected set event, got ${evt.type}`);
    assert.equal(evt.node['#secret'], undefined, 'secret stripped — bob is not real owner of stored node');
  });

  it('drops set event when stored node is gone (race with remove)', async () => {
    const tree = createMemoryTree();

    const node: NodeData = {
      $path: '/x', $type: 't',
      $acl: [{ g: 'authenticated', p: R }],
    };
    await tree.set(node);

    const events: NodeEvent[] = [];
    const filtered = createFilteredPush(tree, 'bob', ['u:bob', 'authenticated'], (e) => { events.push(e); });

    // Remove the node, then deliver a stale set event
    await tree.remove('/x');

    const stale: NodeEvent = {
      type: 'set', path: '/x', node: { $type: 't', $acl: [{ g: 'authenticated', p: R }] },
    };
    filtered(stale);
    await new Promise(r => setImmediate(r));

    assert.equal(events.length, 0, 'stale set event dropped — stored node gone');
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

    filtered({ type: 'patch', path: '/slow', patches: [['r', 'x', 1]], rev: 2 });
    filtered({ type: 'patch', path: '/fast', patches: [['r', 'x', 1]], rev: 2 });
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

    filtered({ type: 'patch', path: '/slow', patches: [['r', 'x', 1]], rev: 2 });
    filtered({ type: 'reconnect', preserved: true });
    await all;

    assert.deepEqual(delivered, ['patch', 'reconnect']);
  });

  it('a failing event is dropped but the chain recovers and stays ordered', async () => {
    const base = await setupNodes();
    const failing: typeof base = {
      ...base,
      async get(path, ctx) {
        if (path === '/slow') throw new Error('storage hiccup');
        return base.get(path, ctx);
      },
    };

    const delivered: string[] = [];
    let done!: () => void;
    const all = new Promise<void>(r => { done = r; });
    const filtered = createFilteredPush(failing, 'bob', CLAIMS, (e) => {
      delivered.push((e as { path?: string }).path ?? e.type);
      done();
    });

    filtered({ type: 'patch', path: '/slow', patches: [['r', 'x', 1]], rev: 2 });
    filtered({ type: 'patch', path: '/fast', patches: [['r', 'x', 1]], rev: 2 });
    await all;

    assert.deepEqual(delivered, ['/fast'], 'failing event dropped, next event still delivered');
  });
});
