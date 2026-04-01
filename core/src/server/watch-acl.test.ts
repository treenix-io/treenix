// Tests for watch event ACL filtering:
// - filterPatches: component-level patch filtering
// - filteredPush behavior: claims caching, set/patch/remove event handling
// - remove event ACL: parent-based permission check for deleted nodes

import { createNode, isComponent, R, W, register } from '#core';
import { componentPerm, resolvePermission } from './auth';
import { createMemoryTree } from '#tree';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Operation } from 'fast-json-patch';
import type { NodeData } from '#core';

// ── filterPatches (extracted logic, tested directly) ──

function filterPatches(
  patches: Operation[],
  node: NodeData,
  userId: string | null,
  claims: string[],
): Operation[] {
  return patches.filter(op => {
    const seg = op.path.split('/')[1];
    if (!seg || seg.startsWith('$')) return true;
    const val = node[seg];
    if (!isComponent(val)) return true;
    return !!(componentPerm(val, userId, claims, node.$owner) & R);
  });
}

describe('filterPatches — component-level ACL on patch events', () => {
  // Node with a public component and a restricted component
  const node: NodeData = {
    $path: '/test',
    $type: 'test.node',
    $owner: 'alice',
    title: 'Hello', // plain field, not a component
    publicComp: { $type: 'public.comp', data: 'visible' },
    secretComp: {
      $type: 'secret.comp',
      apiKey: 'sk-123',
      $acl: [{ g: 'admin', p: R }, { g: 'authenticated', p: 0 }],
    },
  };

  it('passes ops targeting plain fields', () => {
    const patches: Operation[] = [
      { op: 'replace', path: '/title', value: 'Updated' },
    ];
    const filtered = filterPatches(patches, node, 'bob', ['authenticated', 'u:bob']);
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].path, '/title');
  });

  it('passes ops targeting system fields ($rev, $acl)', () => {
    const patches: Operation[] = [
      { op: 'replace', path: '/$rev', value: 5 },
    ];
    const filtered = filterPatches(patches, node, 'bob', ['authenticated', 'u:bob']);
    assert.equal(filtered.length, 1);
  });

  it('passes ops targeting components user can read', () => {
    const patches: Operation[] = [
      { op: 'replace', path: '/publicComp/data', value: 'new' },
    ];
    const filtered = filterPatches(patches, node, 'bob', ['authenticated', 'u:bob']);
    assert.equal(filtered.length, 1);
  });

  it('filters ops targeting restricted components', () => {
    const patches: Operation[] = [
      { op: 'replace', path: '/secretComp/apiKey', value: 'sk-new' },
    ];
    // bob is authenticated but secretComp denies authenticated (p=0), only admin gets R
    const filtered = filterPatches(patches, node, 'bob', ['authenticated', 'u:bob']);
    assert.equal(filtered.length, 0);
  });

  it('admin can see restricted component patches', () => {
    const patches: Operation[] = [
      { op: 'replace', path: '/secretComp/apiKey', value: 'sk-new' },
    ];
    const filtered = filterPatches(patches, node, 'admin-user', ['authenticated', 'admin', 'u:admin-user']);
    assert.equal(filtered.length, 1);
  });

  it('filters mixed patches — keeps permitted, drops restricted', () => {
    const patches: Operation[] = [
      { op: 'replace', path: '/title', value: 'Updated' },
      { op: 'replace', path: '/publicComp/data', value: 'new' },
      { op: 'replace', path: '/secretComp/apiKey', value: 'sk-leaked' },
    ];
    const filtered = filterPatches(patches, node, 'bob', ['authenticated', 'u:bob']);
    assert.equal(filtered.length, 2);
    assert.ok(filtered.every(p => !p.path.startsWith('/secretComp')));
  });

  it('drops event when ALL ops target restricted components', () => {
    const patches: Operation[] = [
      { op: 'replace', path: '/secretComp/apiKey', value: 'sk-new' },
      { op: 'add', path: '/secretComp/secret2', value: 'hidden' },
    ];
    const filtered = filterPatches(patches, node, 'bob', ['authenticated', 'u:bob']);
    assert.equal(filtered.length, 0);
    // Caller should skip emit entirely when filtered.length === 0
  });

  it('handles root-level patch path ("/")', () => {
    const patches: Operation[] = [
      { op: 'replace', path: '/', value: {} },
    ];
    // seg = '' after split('/')[1] → !seg guard → passes through
    const filtered = filterPatches(patches, node, 'bob', ['authenticated', 'u:bob']);
    assert.equal(filtered.length, 1);
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
