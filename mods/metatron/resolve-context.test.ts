// Tests for metatron resolveContext — ACL enforcement + sensitive field filtering

import { createNode, type NodeData } from '@treenx/core';
import { createMemoryTree } from '@treenx/core/tree';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveContext } from './service';

// Helper: seed a tree with ACL-protected and public nodes
async function seedTree() {
  const tree = createMemoryTree();

  // Root ACL — authenticated can read+write (R=1|W=2=3), public can read (R=1)
  await tree.set({
    $path: '/',
    $type: 'dir',
    $acl: [{ g: 'authenticated', p: 3 }, { g: 'public', p: 1 }],
  } as NodeData);

  // Public node — inherits root ACL (everyone can read)
  await tree.set(createNode('/demo/public', 'test.page', {
    title: 'Public Page',
    content: 'Hello world',
  }));

  // Protected node — deny authenticated, allow only admin
  await tree.set({
    $path: '/secrets/keys',
    $type: 'test.config',
    $acl: [{ g: 'authenticated', p: 0 }, { g: 'public', p: 0 }, { g: 'admin', p: 1 }], // deny all except admin
    apiKey: 'sk-secret-12345',
    password: 'hunter2',
    token: 'jwt-token-xyz',
    name: 'API Config',
  } as NodeData);

  // Node with sensitive fields but no ACL restriction
  await tree.set(createNode('/demo/user', 'test.user', {
    name: 'Alice',
    email: 'alice@example.com',
    passwordHash: 'bcrypt$2b$...',
    secretAnswer: 'fluffy',
    tokenExpiry: 1234567890,
    bio: 'Regular user',
  }));

  // Node with named component containing sensitive fields
  await tree.set({
    $path: '/demo/service',
    $type: 'test.service',
    label: 'My Service',
    config: { $type: 'test.config', endpoint: 'https://api.example.com', apiKey: 'secret123' },
  } as NodeData);

  return tree;
}

describe('resolveContext ACL enforcement', () => {
  it('blocks access to ACL-protected nodes for unprivileged users', async () => {
    const tree = await seedTree();
    const result = await resolveContext(tree, ['Check @/secrets/keys'], 'alice');
    assert.ok(result.includes('not found or access denied'), 'should deny access');
    assert.ok(!result.includes('sk-secret-12345'), 'must not leak apiKey');
  });

  it('allows access to ACL-protected nodes for admin users', async () => {
    const tree = await seedTree();
    const result = await resolveContext(tree, ['Check @/secrets/keys'], 'admin-user');
    // admin-user without explicit group membership gets 'authenticated' claim
    // The node requires 'admin' group — so even authenticated users are blocked
    assert.ok(result.includes('not found or access denied'));
  });

  it('allows access to public nodes', async () => {
    const tree = await seedTree();
    const result = await resolveContext(tree, ['Check @/demo/public'], 'alice');
    assert.ok(result.includes('Public Page'), 'should include public node content');
    assert.ok(result.includes('/demo/public'));
  });

  it('null createdBy falls back to public claims (most restrictive)', async () => {
    const tree = await seedTree();
    const result = await resolveContext(tree, ['Check @/secrets/keys'], null);
    assert.ok(result.includes('not found or access denied'));
    assert.ok(!result.includes('sk-secret-12345'));
  });
});

describe('resolveContext sensitive field filtering', () => {
  it('strips fields matching sensitive patterns', async () => {
    const tree = await seedTree();
    const result = await resolveContext(tree, ['Check @/demo/user'], 'alice');

    // Normal fields present
    assert.ok(result.includes('Alice'), 'name should be included');
    assert.ok(result.includes('alice@example.com'), 'email should be included');
    assert.ok(result.includes('Regular user'), 'bio should be included');

    // Sensitive fields stripped (substring match)
    assert.ok(!result.includes('bcrypt'), 'passwordHash should be stripped');
    assert.ok(!result.includes('fluffy'), 'secretAnswer should be stripped');
    assert.ok(!result.includes('1234567890'), 'tokenExpiry should be stripped');
  });

  it('strips sensitive fields from named components', async () => {
    const tree = await seedTree();
    const result = await resolveContext(tree, ['Check @/demo/service'], 'alice');

    assert.ok(result.includes('https://api.example.com'), 'endpoint should be included');
    assert.ok(!result.includes('secret123'), 'apiKey in component should be stripped');
  });

  it('strips $acl and $owner from output', async () => {
    const tree = await seedTree();
    // Use a node that admin CAN read but that has $acl set
    // We'll add admin group to the tree for this test
    await tree.set({
      $path: '/auth/users/admin1',
      $type: 'auth.user',
      groups: { $type: 'auth.groups', list: ['admin'] },
    } as NodeData);

    const result = await resolveContext(tree, ['Check @/secrets/keys'], 'admin1');
    assert.ok(!result.includes('$acl'), '$acl should not appear in context');
    assert.ok(!result.includes('$owner'), '$owner should not appear in context');
  });

  it('returns empty string when no mentions in prompts', async () => {
    const tree = await seedTree();
    const result = await resolveContext(tree, ['Just a plain prompt, no mentions'], 'alice');
    assert.equal(result, '');
  });
});
