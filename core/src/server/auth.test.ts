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
import { OpError } from '#errors';

let tree: Tree;

beforeEach(async () => {
  clearRegistry();
  tree = createMemoryTree();
  // Root: public read
  await tree.set({ ...createNode('/', 'root'), $acl: [{ g: 'public', p: R }] });
  // /users: authenticated read, public denied
  await tree.set({
    ...createNode('/users', 'dir'),
    $acl: [
      { g: 'authenticated', p: R },
      { g: 'public', p: 0 },
    ],
  });
  // /users/alice: owner full, authenticated denied
  await tree.set({
    ...createNode('/users/alice', 'user'),
    $owner: 'alice',
    $acl: [
      { g: 'owner', p: R | W | A },
      { g: 'authenticated', p: 0 },
    ],
  });
  await tree.set(createNode('/users/alice/page', 'page'));
  // /users/bob
  await tree.set({
    ...createNode('/users/bob', 'user'),
    $owner: 'bob',
    $acl: [
      { g: 'owner', p: R | W | A },
      { g: 'authenticated', p: 0 },
    ],
  });
  await tree.set(createNode('/users/bob/page', 'page'));
  // /types: public read
  await tree.set({ ...createNode('/types', 'dir'), $acl: [{ g: 'public', p: R }] });
  await tree.set(createNode('/types/block.hero', 'type'));
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
    const perm = await resolvePermission(tree, '/users/alice/page', 'alice', [
      'u:alice',
      'authenticated',
    ]);
    assert.equal(perm, R | W | A);
  });

  it("bob cannot access alice's subtree (deny sticky)", async () => {
    const perm = await resolvePermission(tree, '/users/alice/page', 'bob', [
      'u:bob',
      'authenticated',
    ]);
    assert.equal(perm, 0);
  });

  it('public can read root', async () => {
    const perm = await resolvePermission(tree, '/', null, ['public']);
    assert.equal(perm, R);
  });

  it('public can read /types', async () => {
    const perm = await resolvePermission(tree, '/types/block.hero', null, ['public']);
    assert.equal(perm, R);
  });

  it('public cannot write root', async () => {
    const perm = await resolvePermission(tree, '/', null, ['public']);
    assert.equal(perm & W, 0);
  });

  it('owner pseudo-group resolves via $owner', async () => {
    const perm = await resolvePermission(tree, '/users/alice', 'alice', [
      'u:alice',
      'authenticated',
    ]);
    assert.equal(perm, R | W | A);
  });

  it('owner pseudo-group does not match wrong user', async () => {
    // bob matches "authenticated" which is denied at /users/alice
    const perm = await resolvePermission(tree, '/users/alice', 'bob', ['u:bob', 'authenticated']);
    assert.equal(perm, 0);
  });

  it('deny is sticky — cannot override below', async () => {
    // Add a node below alice's denied subtree that tries to re-grant
    const existing = await tree.get('/users/alice/page');
    await tree.set({
      ...existing,
      ...createNode('/users/alice/page', 'page'),
      $acl: [{ g: 'authenticated', p: R }], // tries to re-grant
    });
    const perm = await resolvePermission(tree, '/users/alice/page', 'bob', [
      'u:bob',
      'authenticated',
    ]);
    assert.equal(perm, 0); // still denied
  });

  it('permission can widen when not denied', async () => {
    // /shared: authenticated read
    await tree.set({ ...createNode('/shared', 'dir'), $acl: [{ g: 'authenticated', p: R }] });
    // /shared/editable: authenticated read+write
    await tree.set({
      ...createNode('/shared/editable', 'dir'),
      $acl: [{ g: 'authenticated', p: R | W }],
    });
    const perm = await resolvePermission(tree, '/shared/editable', 'bob', [
      'u:bob',
      'authenticated',
    ]);
    assert.equal(perm, R | W);
  });

  it('inherits from parent when no $acl', async () => {
    // /users/alice/page has no $acl, inherits from /users/alice
    const perm = await resolvePermission(tree, '/users/alice/page', 'alice', [
      'u:alice',
      'authenticated',
    ]);
    assert.equal(perm, R | W | A);
  });

  it('caches results', async () => {
    const cache = new Map<string, number>();
    await resolvePermission(
      tree,
      '/users/alice/page',
      'alice',
      ['u:alice', 'authenticated'],
      cache,
    );
    assert.ok(cache.has('/users/alice/page'));
    // Second call uses cache
    const perm = await resolvePermission(
      tree,
      '/users/alice/page',
      'alice',
      ['u:alice', 'authenticated'],
      cache,
    );
    assert.equal(perm, R | W | A);
  });

  it('admin group gets full access', async () => {
    const root = await tree.get('/');
    await tree.set({
      ...root,
      ...createNode('/', 'root'),
      $acl: [
        { g: 'public', p: R },
        { g: 'admins', p: R | W | A },
      ],
    });
    const perm = await resolvePermission(tree, '/users/alice/page', 'admin', [
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
    const claims = await buildClaims(tree, 'alice');
    assert.ok(claims.includes('u:alice'));
    assert.ok(claims.includes('authenticated'));
  });

  it('includes groups from user node', async () => {
    await tree.set({
      ...createNode('/auth/users/alice', 'user'),
      $owner: 'alice',
      groups: { $type: 'groups', list: ['admins', 'editors'] },
    });
    const claims = await buildClaims(tree, 'alice');
    assert.ok(claims.includes('admins'));
    assert.ok(claims.includes('editors'));
    assert.ok(claims.includes('u:alice'));
    assert.ok(claims.includes('authenticated'));
  });
});

describe('granular sticky deny', () => {
  it('parent denies W (sticky), child cannot grant W', async () => {
    // /docs: editors can R, deny W sticky
    await tree.set({
      ...createNode('/docs', 'dir'),
      $acl: [
        { g: 'editors', p: R },
        { g: 'editors', p: -(W | A) },
      ],
    });
    // /docs/page: editors try to grant W
    await tree.set({
      ...createNode('/docs/page', 'doc'),
      $acl: [{ g: 'editors', p: R | W }],
    });
    const perm = await resolvePermission(tree, '/docs/page', 'ed1', ['u:ed1', 'editors']);
    assert.equal(perm, R); // W is masked out
  });

  it('parent denies A only, allows R|W', async () => {
    await tree.set({
      ...createNode('/projects', 'dir'),
      $acl: [
        { g: 'devs', p: R | W },
        { g: 'devs', p: -A },
      ],
    });
    await tree.set(createNode('/projects/app', 'doc'));
    const perm = await resolvePermission(tree, '/projects/app', 'dev1', ['u:dev1', 'devs']);
    assert.equal(perm, R | W); // A denied sticky
  });

  it('child tries to grant denied bits, they are masked', async () => {
    await tree.set({
      ...createNode('/wiki', 'dir'),
      $acl: [{ g: 'readers', p: -(W | A) }],
    });
    await tree.set({
      ...createNode('/wiki/article', 'doc'),
      $acl: [{ g: 'readers', p: R | W | A }],
    });
    const perm = await resolvePermission(tree, '/wiki/article', 'r1', ['u:r1', 'readers']);
    assert.equal(perm, R); // W|A denied, only R remains
  });

  it('p=0 still works as deny all (backward compat)', async () => {
    await tree.set({
      ...createNode('/private', 'dir'),
      $acl: [{ g: 'public', p: 0 }],
    });
    await tree.set(createNode('/private/secret', 'doc'));
    const perm = await resolvePermission(tree, '/private/secret', null, ['public']);
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
    const s = withAcl(tree, 'alice', ['u:alice', 'authenticated']);
    assert.ok(await s.get('/users/alice/page'));
  });

  it("alice cannot read bob's page", async () => {
    const s = withAcl(tree, 'alice', ['u:alice', 'authenticated']);
    assert.equal(await s.get('/users/bob/page'), undefined);
  });

  it('filters getChildren', async () => {
    const s = withAcl(tree, 'alice', ['u:alice', 'authenticated']);
    const children = await s.getChildren('/users', { depth: Infinity });
    const paths = children.items.map((c) => c.$path);
    assert.ok(paths.includes('/users/alice'));
    assert.ok(!paths.includes('/users/bob'));
  });

  it('throws on write without permission', async () => {
    const s = withAcl(tree, 'alice', ['u:alice', 'authenticated']);
    await assert.rejects(() => s.set(createNode('/users/bob/x', 'x')));
  });

  it('allows write within own subtree', async () => {
    const s = withAcl(tree, 'alice', ['u:alice', 'authenticated']);
    await s.set(createNode('/users/alice/new', 'doc'));
    assert.ok(await tree.get('/users/alice/new'));
  });

  it('throws on remove without permission', async () => {
    const s = withAcl(tree, 'alice', ['u:alice', 'authenticated']);
    await assert.rejects(() => s.remove('/users/bob/page'));
  });

  it('unauthenticated: public read only', async () => {
    const s = withAcl(tree, null, ['public']);
    assert.ok(await s.get('/types/block.hero'));
    assert.equal(await s.get('/users/alice/page'), undefined);
    await assert.rejects(() => s.set(createNode('/types/x', 'x')));
  });

  it('getPerm returns cached value after get', async () => {
    const s = withAcl(tree, 'alice', ['u:alice', 'authenticated']);
    await s.get('/users/alice/page');
    const perm = await s.getPerm('/users/alice/page');
    assert.equal(perm, R | W | A); // owner full access
  });

  it('getPerm reflects S bit', async () => {
    await tree.set({ ...createNode('/watchable', 'dir'), $acl: [{ g: 'public', p: R | S }] });
    await tree.set({ ...createNode('/no-watch', 'dir'), $acl: [{ g: 'public', p: R }] });
    const s = withAcl(tree, null, ['public']);
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

  it('session nodes have admin-only $acl', async () => {
    const token = await createSession(ss, 'alice');
    const node = await ss.get(`/auth/sessions/${token}`);
    assert.ok(node?.$acl, 'session node must have $acl');
    assert.equal(node!.$acl!.length, 1);
    assert.equal(node!.$acl![0].g, 'admins');
    assert.equal(node!.$acl![0].p, R | W | A | S);
  });

  it('non-admin cannot read session nodes via ACL', async () => {
    // Set up parent ACL like seed data
    await ss.set({ $path: '/auth', $type: 'dir', $acl: [{ g: 'admins', p: R | W | A | S }, { g: 'public', p: 0 }] });
    await ss.set({ $path: '/auth/sessions', $type: 'dir', $acl: [{ g: 'admins', p: R | W | A | S }, { g: 'authenticated', p: 0 }, { g: 'public', p: 0 }] });
    const token = await createSession(ss, 'alice');

    // Authenticated non-admin: denied
    const userTree = withAcl(ss, 'alice', ['u:alice', 'authenticated']);
    const node = await userTree.get(`/auth/sessions/${token}`);
    assert.equal(node, undefined, 'non-admin should not read session node');

    // Admin: allowed
    const adminTree = withAcl(ss, 'admin', ['u:admin', 'admins', 'authenticated']);
    const adminNode = await adminTree.get(`/auth/sessions/${token}`);
    assert.ok(adminNode, 'admin should read session node');
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

describe('getChildren truncation', () => {
  beforeEach(() => clearRegistry());

  it('sets truncated=true when ACL scan limit is hit', async () => {
    const base = createMemoryTree();

    // Create a proxy tree that pretends getChildren returned MAX_ACL_SCAN items
    // by returning exactly 10_000 dummy nodes, triggering the truncation path
    const items: import('#core').NodeData[] = [];
    for (let i = 0; i < 10_000; i++) {
      items.push(createNode(`/big/${i}`, 'doc'));
    }
    const fakeTree: Tree = {
      ...base,
      async getChildren() {
        return { items, total: items.length };
      },
    };

    const s = withAcl(fakeTree, 'admin', ['u:admin', 'authenticated']);
    const result = await s.getChildren('/big');
    assert.equal(result.truncated, true);
  });

  it('truncated is undefined for normal results', async () => {
    const base = createMemoryTree();
    await base.set({ $path: '/small', $type: 'folder', $acl: [{ g: 'authenticated', p: R }] });
    await base.set(createNode('/small/a', 'doc'));
    await base.set(createNode('/small/b', 'doc'));

    const s = withAcl(base, 'admin', ['u:admin', 'authenticated']);
    const result = await s.getChildren('/small');
    assert.equal(result.truncated, undefined);
    assert.equal(result.items.length, 2);
  });
});

describe('buildClaims — groups from user record', () => {
  it('includes authenticated + u:<id> + user groups list', async () => {
    await tree.set({
      ...createNode('/auth/users/carol', 'user'),
      $owner: 'carol',
      groups: { $type: 'groups', list: ['editors', 'reviewers'] },
    });
    const claims = await buildClaims(tree, 'carol');
    assert.ok(claims.includes('u:carol'), 'u:carol present');
    assert.ok(claims.includes('authenticated'), 'authenticated present');
    assert.ok(claims.includes('editors'), 'editors group present');
    assert.ok(claims.includes('reviewers'), 'reviewers group present');
  });

  it('anon:* users get public group, never authenticated', async () => {
    const claims = await buildClaims(tree, 'anon:abc123');
    assert.ok(claims.includes('public'));
    assert.ok(!claims.includes('authenticated'));
  });
});

describe('withAcl denial — typed OpError', () => {
  it('set without W throws OpError with code FORBIDDEN', async () => {
    const s = withAcl(tree, 'bob', ['u:bob', 'authenticated']);
    await assert.rejects(
      () => s.set(createNode('/users/alice/page', 'page', { title: 'hijacked' })),
      (e: unknown) => e instanceof OpError && e.code === 'FORBIDDEN',
    );
  });

  it('remove without W throws OpError with code FORBIDDEN', async () => {
    const s = withAcl(tree, 'bob', ['u:bob', 'authenticated']);
    await assert.rejects(
      () => s.remove('/users/alice/page'),
      (e: unknown) => e instanceof OpError && e.code === 'FORBIDDEN',
    );
  });

  it('patch without W throws OpError with code FORBIDDEN', async () => {
    const s = withAcl(tree, 'bob', ['u:bob', 'authenticated']);
    await assert.rejects(
      () => s.patch('/users/alice/page', [['r', 'title', 'hijacked']]),
      (e: unknown) => e instanceof OpError && e.code === 'FORBIDDEN',
    );
  });
});

// Comprehensive C1 fix tests for withAcl.patch (per plan
// /Users/kriz/.claude/plans/c1-acl-patch-bypass.md). TDD order:
// - B* baseline: legitimate flows that must already pass and stay green
// - N* new: behaviors the fix must add (red until fix lands)
// - I* integration: cross-layer guards
describe('withAcl.patch — C1 ACL enforcement', () => {
  // ── Baseline (must be green even before the fix) ──

  // B1: $rev OCC test op succeeds with R+W; subsequent op applies; rev bumps.
  it('B1: $rev OCC test op succeeds with R+W', async () => {
    await tree.set({
      ...createNode('/n', 'doc'),
      $acl: [{ g: 'authenticated', p: R | W }],
      title: 'orig',
    });
    const rev = (await tree.get('/n'))!.$rev!;
    const s = withAcl(tree, 'alice', ['u:alice', 'authenticated']);
    await s.patch('/n', [['t', '$rev', rev], ['r', 'title', 'new']]);
    const after = (await tree.get('/n'))!;
    assert.equal(after.title, 'new');
    assert.equal(after.$rev, rev + 1);
  });

  // B2: stale $rev throws PatchTestError (not FORBIDDEN); state untouched.
  it('B2: $rev OCC mismatch throws PatchTestError, state untouched', async () => {
    await tree.set({
      ...createNode('/n', 'doc'),
      $acl: [{ g: 'authenticated', p: R | W }],
      title: 'orig',
    });
    const s = withAcl(tree, 'alice', ['u:alice', 'authenticated']);
    await assert.rejects(
      () => s.patch('/n', [['t', '$rev', 9999], ['r', 'title', 'hijacked']]),
      (e: any) => e?.code === 'TEST_FAILED',
    );
    assert.equal((await tree.get('/n'))!.title, 'orig');
  });

  // B3: ordinary patch on accessible component succeeds.
  it('B3: patch on accessible non-system component succeeds', async () => {
    await tree.set({
      ...createNode('/n', 'doc'),
      $acl: [{ g: 'authenticated', p: R | W }],
      meta: { $type: 'meta', count: 1 },
    });
    const s = withAcl(tree, 'alice', ['u:alice', 'authenticated']);
    await s.patch('/n', [['r', 'meta.count', 42]]);
    assert.equal(((await tree.get('/n'))!.meta as any).count, 42);
  });

  // B4: patch on missing node throws NOT_FOUND (preserves rawStore semantics).
  it('B4: patch on non-existent node throws NOT_FOUND', async () => {
    const s = withAcl(tree, 'alice', ['u:alice', 'authenticated']);
    // Need R+W on the path inheritance chain; /users grants authenticated R only.
    await tree.set({ ...createNode('/r', 'dir'), $acl: [{ g: 'authenticated', p: R | W }] });
    await assert.rejects(
      () => s.patch('/r/missing', [['r', 'x', 1]]),
      (e: unknown) => e instanceof OpError && e.code === 'NOT_FOUND',
    );
  });

  // B5: patch without W → FORBIDDEN (existing behavior).
  it('B5: patch without W throws FORBIDDEN', async () => {
    const s = withAcl(tree, 'bob', ['u:bob', 'authenticated']);
    await assert.rejects(
      () => s.patch('/users/alice/page', [['r', 'title', 'hijacked']]),
      (e: unknown) => e instanceof OpError && e.code === 'FORBIDDEN',
    );
  });

  // ── Gate ──

  // N1: patch needs R AND W (not only W). Closes test-op oracle gate.
  // Setup: grant only W bit (no R). Alice cannot read but could probe via t-op
  // before the fix.
  it('N1: patch with W but no R throws FORBIDDEN', async () => {
    await tree.set({
      ...createNode('/n', 'doc'),
      $acl: [{ g: 'authenticated', p: W }],   // W only, no R
    });
    const s = withAcl(tree, 'alice', ['u:alice', 'authenticated']);
    await assert.rejects(
      () => s.patch('/n', [['t', '$rev', 1]]),
      (e: unknown) => e instanceof OpError && e.code === 'FORBIDDEN',
    );
  });

  // ── Test-op rules (per stripComponents visibility) ──

  // N2: t on visible system fields ($rev/$path/$type/$ref) allowed with R+W.
  it('N2: t on visible system fields allowed with R+W', async () => {
    await tree.set({
      ...createNode('/n', 'doc'),
      $acl: [{ g: 'authenticated', p: R | W }],
    });
    const node = (await tree.get('/n'))!;
    const s = withAcl(tree, 'alice', ['u:alice', 'authenticated']);
    // Single-batch mixes test-on-$rev/$path/$type with a real mutation
    await s.patch('/n', [
      ['t', '$rev', node.$rev],
      ['t', '$path', '/n'],
      ['t', '$type', node.$type],
      ['r', 'mark', 1],
    ]);
    assert.equal((await tree.get('/n'))!.mark, 1);
  });

  // N3 (= old FX1): t on $refs is FORBIDDEN — $refs always stripped from get.
  it('N3: t on $refs (always-hidden) FORBIDDEN even with R+W+A', async () => {
    await tree.set({
      ...createNode('/probe', 'doc'),
      $acl: [{ g: 'authenticated', p: R | W | A }],
      $refs: [{ t: '/some/target' }],
    });
    const s = withAcl(tree, 'alice', ['u:alice', 'authenticated']);
    await assert.rejects(
      () => s.patch('/probe', [['t', '$refs', [{ t: '/some/target' }]]]),
      (e: unknown) => e instanceof OpError && e.code === 'FORBIDDEN',
    );
  });

  // N4: t on $acl/$owner without A → FORBIDDEN (oracle on stripped fields).
  it('N4: t on $acl/$owner without A FORBIDDEN', async () => {
    await tree.set({
      ...createNode('/n', 'doc'),
      $owner: 'someone',
      $acl: [{ g: 'authenticated', p: R | W }],   // no A
    });
    const s = withAcl(tree, 'alice', ['u:alice', 'authenticated']);
    await assert.rejects(
      () => s.patch('/n', [['t', '$acl', [{ g: 'authenticated', p: R | W }]]]),
      (e: unknown) => e instanceof OpError && e.code === 'FORBIDDEN',
    );
    await assert.rejects(
      () => s.patch('/n', [['t', '$owner', 'someone']]),
      (e: unknown) => e instanceof OpError && e.code === 'FORBIDDEN',
    );
  });

  // N5: t on protected component (no R) → FORBIDDEN.
  it('N5: t on component with no R FORBIDDEN', async () => {
    register('secret', 'acl', () => [{ g: 'owner', p: R | W | A }]);
    await tree.set({
      ...createNode('/n', 'doc'),
      $owner: 'bob',
      $acl: [{ g: 'authenticated', p: R | W }],
      secret: { $type: 'secret', x: 'hidden' },
    });
    const s = withAcl(tree, 'alice', ['u:alice', 'authenticated']);   // alice not owner
    await assert.rejects(
      () => s.patch('/n', [['t', 'secret.x', 'guess']]),
      (e: unknown) => e instanceof OpError && e.code === 'FORBIDDEN',
    );
  });

  // ── Mutation rules ──

  // N6: $acl mutation without A → FORBIDDEN.
  it('N6: $acl mutation without A FORBIDDEN', async () => {
    await tree.set({
      ...createNode('/n', 'doc'),
      $acl: [{ g: 'authenticated', p: R | W }],   // no A
    });
    const s = withAcl(tree, 'alice', ['u:alice', 'authenticated']);
    await assert.rejects(
      () => s.patch('/n', [['r', '$acl', [{ g: 'public', p: R | W | A }]]]),
      (e: unknown) => e instanceof OpError && e.code === 'FORBIDDEN',
    );
  });

  // N7: $owner mutation without A → FORBIDDEN.
  it('N7: $owner mutation without A FORBIDDEN', async () => {
    await tree.set({
      ...createNode('/n', 'doc'),
      $owner: 'bob',
      $acl: [{ g: 'authenticated', p: R | W }],   // no A
    });
    const s = withAcl(tree, 'alice', ['u:alice', 'authenticated']);
    await assert.rejects(
      () => s.patch('/n', [['r', '$owner', 'alice']]),
      (e: unknown) => e instanceof OpError && e.code === 'FORBIDDEN',
    );
  });

  // N8: admin can mutate $acl/$owner.
  it('N8: admin can mutate $acl and $owner', async () => {
    await tree.set({
      ...createNode('/n', 'doc'),
      $owner: 'bob',
      $acl: [{ g: 'admins', p: R | W | A }],
    });
    const admin = withAcl(tree, 'adm', ['u:adm', 'admins', 'authenticated']);
    await admin.patch('/n', [['r', '$owner', 'alice']]);
    await admin.patch('/n', [['r', '$acl', [{ g: 'admins', p: R | W | A }, { g: 'public', p: R }]]]);
    const after = (await tree.get('/n')) as any;
    assert.equal(after.$owner, 'alice');
    assert.deepEqual(after.$acl, [{ g: 'admins', p: R | W | A }, { g: 'public', p: R }]);
  });

  // N9: $type/$path/$rev/$refs mutations FORBIDDEN even for admin.
  it('N9: $type/$path/$rev/$refs mutations FORBIDDEN even for admin', async () => {
    await tree.set({
      ...createNode('/n', 'doc'),
      $acl: [{ g: 'admins', p: R | W | A }],
    });
    const admin = withAcl(tree, 'adm', ['u:adm', 'admins', 'authenticated']);
    for (const op of [
      ['r', '$type', 'evil'] as const,
      ['r', '$rev', 999] as const,
      ['r', '$path', '/evil'] as const,
      ['d', '$refs'] as const,
    ]) {
      await assert.rejects(
        () => admin.patch('/n', [op]),
        (e: unknown) => e instanceof OpError && e.code === 'FORBIDDEN',
        `should FORBIDDEN ${op[0]} ${op[1]}`,
      );
    }
  });

  // N10 (= old FX2): legitimate $ref retarget on ref nodes with R+W.
  it('N10: $ref retarget on a ref node with R+W succeeds', async () => {
    await tree.set({
      ...createNode('/sys/autostart/bot', 'ref'),
      $ref: '/bot',
      $acl: [{ g: 'authenticated', p: R | W }],
    } as any);
    const s = withAcl(tree, 'alice', ['u:alice', 'authenticated']);
    await s.patch('/sys/autostart/bot', [['r', '$ref', '/new-bot']]);
    assert.equal(((await tree.get('/sys/autostart/bot')) as any).$ref, '/new-bot');
  });

  // ── Component-W rules ──

  // N11: modify-existing-protected-component → FORBIDDEN.
  it('N11: modify existing component with no W FORBIDDEN', async () => {
    register('secret', 'acl', () => [{ g: 'owner', p: R | W | A }]);
    await tree.set({
      ...createNode('/n', 'doc'),
      $owner: 'bob',
      $acl: [{ g: 'authenticated', p: R | W }],
      secret: { $type: 'secret', x: 'orig' },
    });
    const s = withAcl(tree, 'alice', ['u:alice', 'authenticated']);
    await assert.rejects(
      () => s.patch('/n', [['r', 'secret.x', 'hacked']]),
      (e: unknown) => e instanceof OpError && e.code === 'FORBIDDEN',
    );
  });

  // N12: replace-existing-protected → FORBIDDEN.
  it('N12: replace existing component with no W FORBIDDEN', async () => {
    register('secret', 'acl', () => [{ g: 'owner', p: R | W | A }]);
    await tree.set({
      ...createNode('/n', 'doc'),
      $owner: 'bob',
      $acl: [{ g: 'authenticated', p: R | W }],
      secret: { $type: 'secret', x: 'orig' },
    });
    const s = withAcl(tree, 'alice', ['u:alice', 'authenticated']);
    await assert.rejects(
      () => s.patch('/n', [['r', 'secret', { $type: 'secret', x: 'new' }]]),
      (e: unknown) => e instanceof OpError && e.code === 'FORBIDDEN',
    );
  });

  // N13: delete-existing-protected → FORBIDDEN.
  it('N13: delete existing component with no W FORBIDDEN', async () => {
    register('secret', 'acl', () => [{ g: 'owner', p: R | W | A }]);
    await tree.set({
      ...createNode('/n', 'doc'),
      $owner: 'bob',
      $acl: [{ g: 'authenticated', p: R | W }],
      secret: { $type: 'secret', x: 'orig' },
    });
    const s = withAcl(tree, 'alice', ['u:alice', 'authenticated']);
    await assert.rejects(
      () => s.patch('/n', [['d', 'secret']]),
      (e: unknown) => e instanceof OpError && e.code === 'FORBIDDEN',
    );
  });

  // N14: incoming new component requires W on the new value.
  it('N14: add new component requires W on incoming value', async () => {
    // Type-acl on `restricted`: only `staff` group can W.
    register('restricted', 'acl', () => [{ g: 'staff', p: R | W }]);
    await tree.set({
      ...createNode('/n', 'doc'),
      $acl: [{ g: 'authenticated', p: R | W }],
    });
    const s = withAcl(tree, 'alice', ['u:alice', 'authenticated']);   // not in 'staff'
    await assert.rejects(
      () => s.patch('/n', [['a', 'newComp', { $type: 'restricted', data: 'x' }]]),
      (e: unknown) => e instanceof OpError && e.code === 'FORBIDDEN',
    );
  });

  // N15 (= old FX3): component check sees post-mutation $owner in same batch.
  it('N15: component ACL in batch sees post-mutation $owner', async () => {
    register('secret', 'acl', () => [{ g: 'owner', p: R | W | A }]);
    await tree.set({
      ...createNode('/n', 'doc'),
      $owner: 'bob',
      $acl: [{ g: 'admins', p: R | W | A }, { g: 'public', p: 0 }],
      secret: { $type: 'secret', x: 'orig' },
    });
    // Admin reassigns owner to himself first, then writes secret.x.
    // Stale-owner impl would deny secret.x (admin not bob); fresh-owner allows.
    const s = withAcl(tree, 'adm', ['u:adm', 'admins', 'authenticated']);
    await s.patch('/n', [
      ['r', '$owner', 'adm'],
      ['r', 'secret.x', 'updated'],
    ]);
    const after = (await tree.get('/n')) as any;
    assert.equal(after.$owner, 'adm');
    assert.equal(after.secret.x, 'updated');
  });

  // N16 (= old FX4): action-emitted $-field op from non-admin → FORBIDDEN.
  it('N16: simulated action $-field injection from non-admin FORBIDDEN', async () => {
    await tree.set({
      ...createNode('/target', 'doc'),
      $owner: 'bob',
      $acl: [{ g: 'authenticated', p: R | W }, { g: 'public', p: 0 }],
    });
    const s = withAcl(tree, 'alice', ['u:alice', 'authenticated']);
    // Equivalent to executeAction(s, '/target', undefined, undefined, 'default.patch',
    //   { $owner: 'evil' }) — handler deep-merges $owner; immerToPatchOps emits this op.
    await assert.rejects(
      () => s.patch('/target', [['r', '$owner', 'evil']]),
      (e: unknown) => e instanceof OpError && e.code === 'FORBIDDEN',
    );
    assert.equal(((await tree.get('/target')) as any).$owner, 'bob');
  });

  // ── Codex round 2 findings ──

  // N17: nested $-segment in path (component envelope) follows same rules.
  // User has W on `secret` initially → could patch `secret.$acl` to relax/tighten,
  // then keep mutating `secret.*` under stale ACL. Forbid envelope mutation
  // unless admin (matches assertMutationSystemField for $acl).
  it('N17: non-admin nested $acl mutation FORBIDDEN', async () => {
    register('secret', 'acl', () => [{ g: 'authenticated', p: R | W }]);
    await tree.set({
      ...createNode('/n', 'doc'),
      $acl: [{ g: 'authenticated', p: R | W }],
      secret: { $type: 'secret', x: 'orig' },
    });
    const s = withAcl(tree, 'alice', ['u:alice', 'authenticated']);
    await assert.rejects(
      () => s.patch('/n', [['r', 'secret.$acl', [{ g: 'others', p: W }]]]),
      (e: unknown) => e instanceof OpError && e.code === 'FORBIDDEN',
    );
  });

  // N18: $type at any depth FORBIDDEN even for admin (identity at any level).
  it('N18: nested $type mutation FORBIDDEN even for admin', async () => {
    register('secret', 'acl', () => [{ g: 'admins', p: R | W | A }]);
    await tree.set({
      ...createNode('/n', 'doc'),
      $acl: [{ g: 'admins', p: R | W | A }],
      secret: { $type: 'secret', x: 'orig' },
    });
    const s = withAcl(tree, 'adm', ['u:adm', 'admins', 'authenticated']);
    await assert.rejects(
      () => s.patch('/n', [['r', 'secret.$type', 'evil']]),
      (e: unknown) => e instanceof OpError && e.code === 'FORBIDDEN',
    );
  });

  // N19: `a` (add) op on $owner is also a setter (patch.ts:58-66 setByPath);
  // owner-tracking must handle it the same as `r`. Without the fix, subsequent
  // component checks see stale owner.
  it('N19: $owner tracking includes `a` op (not just `r`/`d`)', async () => {
    register('secret', 'acl', () => [{ g: 'owner', p: R | W | A }]);
    // Existing node has no $owner — `a/$owner` is the natural way to add it.
    await tree.set({
      ...createNode('/n', 'doc'),
      $acl: [{ g: 'admins', p: R | W | A }, { g: 'public', p: 0 }],
      secret: { $type: 'secret', x: 'orig' },
    });
    const s = withAcl(tree, 'adm', ['u:adm', 'admins', 'authenticated']);
    await s.patch('/n', [
      ['a', '$owner', 'adm'],
      ['r', 'secret.x', 'updated'],
    ]);
    const after = (await tree.get('/n')) as any;
    assert.equal(after.$owner, 'adm');
    assert.equal(after.secret.x, 'updated');
  });

  // ── Integration ──

  // I1: full pipeline composition (withRefIndex below withAcl) — internal $refs
  // replay still works after the fix; user patches that touch ref-bearing fields
  // do NOT trip the system-field guard since the [r, $refs, ...] op is appended
  // BELOW withAcl (in withRefIndex), where applyOps's own assertSafePatchPath
  // permits $refs.
  it('I1: withAcl → withRefIndex pipeline preserves auto-$refs derivation', async () => {
    const inner = createMemoryTree();
    await inner.set({ ...createNode('/', 'root'), $acl: [{ g: 'public', p: R | W | A }] });
    const refsIndexed = (await import('./refs')).withRefIndex(inner);
    const s = withAcl(refsIndexed, 'alice', ['u:alice', 'public']);

    await s.set({
      ...createNode('/order', 'doc'),
      $acl: [{ g: 'public', p: R | W }],
      customer: { $type: 'ref', $ref: '/customers/alice' },
    });
    await s.patch('/order', [['r', 'customer', { $type: 'ref', $ref: '/customers/bob' }]]);

    const after = (await inner.get('/order')) as any;
    assert.ok(Array.isArray(after.$refs) && after.$refs.length === 1);
    assert.equal(after.$refs[0].t, '/customers/bob');
  });
});
