import { A, type ComponentData, createNode, R, register, S, W } from '#core';
import { clearRegistry } from '#core/index.test';
import { createMemoryTree, type Tree } from '#tree';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import {
  ancestorPaths,
  buildClaims,
  componentPerm,
  createSession,
  resolvePermission,
  resolveToken,
  revokeSession,
  stripComponents,
  withAcl,
} from './auth';

let store: Tree;

beforeEach(async () => {
  clearRegistry();
  store = createMemoryTree();
  // Root: public read
  await store.set({ ...createNode('/', 'root'), $acl: [{ g: 'public', p: R }] });
  // /users: authenticated read, public denied
  await store.set({
    ...createNode('/users', 'dir'),
    $acl: [
      { g: 'authenticated', p: R },
      { g: 'public', p: 0 },
    ],
  });
  // /users/alice: owner full, authenticated denied
  await store.set({
    ...createNode('/users/alice', 'user'),
    $owner: 'alice',
    $acl: [
      { g: 'owner', p: R | W | A },
      { g: 'authenticated', p: 0 },
    ],
  });
  await store.set(createNode('/users/alice/page', 'page'));
  // /users/bob
  await store.set({
    ...createNode('/users/bob', 'user'),
    $owner: 'bob',
    $acl: [
      { g: 'owner', p: R | W | A },
      { g: 'authenticated', p: 0 },
    ],
  });
  await store.set(createNode('/users/bob/page', 'page'));
  // /types: public read
  await store.set({ ...createNode('/types', 'dir'), $acl: [{ g: 'public', p: R }] });
  await store.set(createNode('/types/block.hero', 'type'));
});

describe('ancestorPaths', () => {
  it('root', () => {
    assert.deepEqual(ancestorPaths('/'), ['/']);
  });
  it('nested', () => {
    assert.deepEqual(ancestorPaths('/a/b/c'), ['/', '/a', '/a/b', '/a/b/c']);
  });
  it('single level', () => {
    assert.deepEqual(ancestorPaths('/users'), ['/', '/users']);
  });
});

describe('resolvePermission', () => {
  it('alice has full access to her subtree', async () => {
    const perm = await resolvePermission(store, '/users/alice/page', 'alice', [
      'u:alice',
      'authenticated',
    ]);
    assert.equal(perm, R | W | A);
  });

  it("bob cannot access alice's subtree (deny sticky)", async () => {
    const perm = await resolvePermission(store, '/users/alice/page', 'bob', [
      'u:bob',
      'authenticated',
    ]);
    assert.equal(perm, 0);
  });

  it('public can read root', async () => {
    const perm = await resolvePermission(store, '/', null, ['public']);
    assert.equal(perm, R);
  });

  it('public can read /types', async () => {
    const perm = await resolvePermission(store, '/types/block.hero', null, ['public']);
    assert.equal(perm, R);
  });

  it('public cannot write root', async () => {
    const perm = await resolvePermission(store, '/', null, ['public']);
    assert.equal(perm & W, 0);
  });

  it('owner pseudo-group resolves via $owner', async () => {
    const perm = await resolvePermission(store, '/users/alice', 'alice', [
      'u:alice',
      'authenticated',
    ]);
    assert.equal(perm, R | W | A);
  });

  it('owner pseudo-group does not match wrong user', async () => {
    // bob matches "authenticated" which is denied at /users/alice
    const perm = await resolvePermission(store, '/users/alice', 'bob', ['u:bob', 'authenticated']);
    assert.equal(perm, 0);
  });

  it('deny is sticky — cannot override below', async () => {
    // Add a node below alice's denied subtree that tries to re-grant
    const existing = await store.get('/users/alice/page');
    await store.set({
      ...existing,
      ...createNode('/users/alice/page', 'page'),
      $acl: [{ g: 'authenticated', p: R }], // tries to re-grant
    });
    const perm = await resolvePermission(store, '/users/alice/page', 'bob', [
      'u:bob',
      'authenticated',
    ]);
    assert.equal(perm, 0); // still denied
  });

  it('permission can widen when not denied', async () => {
    // /shared: authenticated read
    await store.set({ ...createNode('/shared', 'dir'), $acl: [{ g: 'authenticated', p: R }] });
    // /shared/editable: authenticated read+write
    await store.set({
      ...createNode('/shared/editable', 'dir'),
      $acl: [{ g: 'authenticated', p: R | W }],
    });
    const perm = await resolvePermission(store, '/shared/editable', 'bob', [
      'u:bob',
      'authenticated',
    ]);
    assert.equal(perm, R | W);
  });

  it('inherits from parent when no $acl', async () => {
    // /users/alice/page has no $acl, inherits from /users/alice
    const perm = await resolvePermission(store, '/users/alice/page', 'alice', [
      'u:alice',
      'authenticated',
    ]);
    assert.equal(perm, R | W | A);
  });

  it('caches results', async () => {
    const cache = new Map<string, number>();
    await resolvePermission(
      store,
      '/users/alice/page',
      'alice',
      ['u:alice', 'authenticated'],
      cache,
    );
    assert.ok(cache.has('/users/alice/page'));
    // Second call uses cache
    const perm = await resolvePermission(
      store,
      '/users/alice/page',
      'alice',
      ['u:alice', 'authenticated'],
      cache,
    );
    assert.equal(perm, R | W | A);
  });

  it('admin group gets full access', async () => {
    const root = await store.get('/');
    await store.set({
      ...root,
      ...createNode('/', 'root'),
      $acl: [
        { g: 'public', p: R },
        { g: 'admins', p: R | W | A },
      ],
    });
    const perm = await resolvePermission(store, '/users/alice/page', 'admin', [
      'u:admin',
      'authenticated',
      'admins',
    ]);
    // admins not denied at /users/alice (only "authenticated" is denied there)
    // admins first appears at "/" with R|W|A, carries forward
    assert.equal(perm, R | W | A);
  });
});

describe('stripComponents', () => {
  it('keeps all components when no ACL', () => {
    const node = {
      ...createNode('/test', 'test'),
      meta: { $type: 'metadata', title: 'hi' },
      status: { $type: 'status', value: 'ok' },
    };
    const stripped = stripComponents(node, 'alice', ['u:alice']);
    assert.ok('meta' in stripped);
    assert.ok('status' in stripped);
  });

  it('strips component with type default ACL', () => {
    register('secret', 'acl', () => [{ g: 'admins', p: R }]);
    const node = {
      ...createNode('/test', 'test'),
      $owner: 'alice',
      meta: { $type: 'metadata', title: 'hi' },
      token: { $type: 'secret', value: 's3cret' },
    };
    // alice is not admin
    const stripped = stripComponents(node, 'alice', ['u:alice']);
    assert.ok('meta' in stripped);
    assert.ok(!('token' in stripped));
  });

  it('allows component with type ACL when user matches', () => {
    register('secret', 'acl', () => [{ g: 'admins', p: R }]);
    const node = {
      ...createNode('/test', 'test'),
      token: { $type: 'secret', value: 's3cret' },
    };
    const stripped = stripComponents(node, 'admin', ['u:admin', 'admins']);
    assert.ok('token' in stripped);
  });

  it('strips component with instance $acl', () => {
    const node = {
      ...createNode('/test', 'test'),
      $owner: 'alice',
      settings: { $type: 'config', $acl: [{ g: 'owner', p: R }], api: 'key' },
    };
    // bob is not owner
    const stripped = stripComponents(node, 'bob', ['u:bob']);
    assert.ok(!('settings' in stripped));
    // alice is owner
    const stripped2 = stripComponents(node, 'alice', ['u:alice']);
    assert.ok('settings' in stripped2);
  });

  it('preserves $path, $type, $acl, $owner', () => {
    const node = { ...createNode('/x', 'y'), $acl: [{ g: 'public', p: R }], $owner: 'alice' };
    const stripped = stripComponents(node, null, []);
    assert.equal(stripped.$path, '/x');
    assert.equal(stripped.$type, 't.y');
    assert.deepEqual(stripped.$acl, [{ g: 'public', p: R }]);
    assert.equal(stripped.$owner, 'alice');
  });

  it('preserves $ref on ref nodes', () => {
    const node = { ...createNode('/sys/autostart/bot', 'ref'), $ref: '/bot' } as any;
    const stripped = stripComponents(node, null, []);
    assert.equal((stripped as any).$ref, '/bot');
  });

  it('preserves $rev on nodes', () => {
    const node = { ...createNode('/x', 'y'), $rev: 5 };
    const stripped = stripComponents(node, null, []);
    assert.equal(stripped.$rev, 5);
  });
});

describe('buildClaims', () => {
  it('basic claims without groups', async () => {
    const claims = await buildClaims(store, 'alice');
    assert.ok(claims.includes('u:alice'));
    assert.ok(claims.includes('authenticated'));
  });

  it('includes groups from user node', async () => {
    await store.set({
      ...createNode('/auth/users/alice', 'user'),
      $owner: 'alice',
      groups: { $type: 'groups', list: ['admins', 'editors'] },
    });
    const claims = await buildClaims(store, 'alice');
    assert.ok(claims.includes('admins'));
    assert.ok(claims.includes('editors'));
    assert.ok(claims.includes('u:alice'));
    assert.ok(claims.includes('authenticated'));
  });
});

describe('granular sticky deny', () => {
  it('parent denies W (sticky), child cannot grant W', async () => {
    // /docs: editors can R, deny W sticky
    await store.set({
      ...createNode('/docs', 'dir'),
      $acl: [
        { g: 'editors', p: R },
        { g: 'editors', p: -(W | A) },
      ],
    });
    // /docs/page: editors try to grant W
    await store.set({
      ...createNode('/docs/page', 'doc'),
      $acl: [{ g: 'editors', p: R | W }],
    });
    const perm = await resolvePermission(store, '/docs/page', 'ed1', ['u:ed1', 'editors']);
    assert.equal(perm, R); // W is masked out
  });

  it('parent denies A only, allows R|W', async () => {
    await store.set({
      ...createNode('/projects', 'dir'),
      $acl: [
        { g: 'devs', p: R | W },
        { g: 'devs', p: -A },
      ],
    });
    await store.set(createNode('/projects/app', 'doc'));
    const perm = await resolvePermission(store, '/projects/app', 'dev1', ['u:dev1', 'devs']);
    assert.equal(perm, R | W); // A denied sticky
  });

  it('child tries to grant denied bits, they are masked', async () => {
    await store.set({
      ...createNode('/wiki', 'dir'),
      $acl: [{ g: 'readers', p: -(W | A) }],
    });
    await store.set({
      ...createNode('/wiki/article', 'doc'),
      $acl: [{ g: 'readers', p: R | W | A }],
    });
    const perm = await resolvePermission(store, '/wiki/article', 'r1', ['u:r1', 'readers']);
    assert.equal(perm, R); // W|A denied, only R remains
  });

  it('p=0 still works as deny all (backward compat)', async () => {
    await store.set({
      ...createNode('/private', 'dir'),
      $acl: [{ g: 'public', p: 0 }],
    });
    await store.set(createNode('/private/secret', 'doc'));
    const perm = await resolvePermission(store, '/private/secret', null, ['public']);
    assert.equal(perm, 0);
  });

  it('component ACL with granular deny', async () => {
    register('secret-data', 'acl', () => [{ g: 'public', p: -(R | W | A) }]);
    const node = {
      ...createNode('/test', 'doc'),
      secretData: { $type: 'secret-data', value: 'hidden' },
    };
    const perm = componentPerm(
      node.secretData as ComponentData,
      null,
      ['public'],
      undefined,
    );
    assert.equal(perm, 0); // all bits denied
  });
});

describe('withAcl', () => {
  it('alice reads her own page', async () => {
    const s = withAcl(store, 'alice', ['u:alice', 'authenticated']);
    assert.ok(await s.get('/users/alice/page'));
  });

  it("alice cannot read bob's page", async () => {
    const s = withAcl(store, 'alice', ['u:alice', 'authenticated']);
    assert.equal(await s.get('/users/bob/page'), undefined);
  });

  it('filters getChildren', async () => {
    const s = withAcl(store, 'alice', ['u:alice', 'authenticated']);
    const children = await s.getChildren('/users', { depth: Infinity });
    const paths = children.items.map((c) => c.$path);
    assert.ok(paths.includes('/users/alice'));
    assert.ok(!paths.includes('/users/bob'));
  });

  it('throws on write without permission', async () => {
    const s = withAcl(store, 'alice', ['u:alice', 'authenticated']);
    await assert.rejects(() => s.set(createNode('/users/bob/x', 'x')));
  });

  it('allows write within own subtree', async () => {
    const s = withAcl(store, 'alice', ['u:alice', 'authenticated']);
    await s.set(createNode('/users/alice/new', 'doc'));
    assert.ok(await store.get('/users/alice/new'));
  });

  it('throws on remove without permission', async () => {
    const s = withAcl(store, 'alice', ['u:alice', 'authenticated']);
    await assert.rejects(() => s.remove('/users/bob/page'));
  });

  it('unauthenticated: public read only', async () => {
    const s = withAcl(store, null, ['public']);
    assert.ok(await s.get('/types/block.hero'));
    assert.equal(await s.get('/users/alice/page'), undefined);
    await assert.rejects(() => s.set(createNode('/types/x', 'x')));
  });

  it('getPerm returns cached value after get', async () => {
    const s = withAcl(store, 'alice', ['u:alice', 'authenticated']);
    await s.get('/users/alice/page');
    const perm = await s.getPerm('/users/alice/page');
    assert.equal(perm, R | W | A); // owner full access
  });

  it('getPerm reflects S bit', async () => {
    await store.set({ ...createNode('/watchable', 'dir'), $acl: [{ g: 'public', p: R | S }] });
    await store.set({ ...createNode('/no-watch', 'dir'), $acl: [{ g: 'public', p: R }] });
    const s = withAcl(store, null, ['public']);
    assert.ok((await s.getPerm('/watchable')) & S);
    assert.ok(!((await s.getPerm('/no-watch')) & S));
  });
});

describe('sessions', () => {
  let ss: Tree;
  beforeEach(() => {
    ss = createMemoryTree();
  });

  it('create and resolve', async () => {
    const token = await createSession(ss, 'alice');
    const session = await resolveToken(ss, token);
    assert.equal(session?.userId, 'alice');
  });

  it('unknown token returns null', async () => {
    assert.equal(await resolveToken(ss, 'bogus'), null);
  });

  it('revoke', async () => {
    const token = await createSession(ss, 'bob');
    assert.ok(await revokeSession(ss, token));
    assert.equal(await resolveToken(ss, token), null);
    assert.equal(await revokeSession(ss, token), false);
  });
});
