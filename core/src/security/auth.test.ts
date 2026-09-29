import { A, type ComponentData, createNode, type NodeData, R, register, S, W } from '#core';
import { clearRegistry } from '#testing';
import { createMemoryTree, isSetEntry, type PatchManyEntry, type Tree } from '#tree';
import { DEFAULT_BUDGET } from '#tree/read-runtime';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { ancestorPaths, componentPerm, resolvePermission, stripComponents, typeAclRule } from './acl';
import { withAcl } from './acl-tree';
import { assertNotSystem, buildClaims, SYSTEM_CLAIM } from './claims';
import { buildSessionCookie } from './cookies';
import { createSession, resolveToken, revokeSession, SESSION_TTL_MS, sessionPath } from './sessions';
import { devLogin, loginUser, registerUser } from './ops';
import { GROUPS_ACL } from './groups';
import { KernelError } from '#errors';

const withEnv = async (env: Record<string, string | undefined>, fn: () => Promise<void>) => {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) prev[k] = process.env[k];
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { await fn(); }
  finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};

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
      '#meta': { $type: 'metadata', title: 'hi' },
      '#status': { $type: 'status', value: 'ok' },
    };
    const stripped = stripComponents(node, 'alice', ['u:alice']);
    assert.ok('#meta' in stripped);
    assert.ok('#status' in stripped);
  });

  it('$id survives the read strip — identity is client-visible (gk8.10)', () => {
    const node = { ...createNode('/test', 'test'), $id: '01ARZ3NDEKTSV4RRFFQ69G5FAV' };
    const stripped = stripComponents(node, 'alice', ['u:alice']);
    assert.equal(stripped.$id, '01ARZ3NDEKTSV4RRFFQ69G5FAV');
  });

  it('strips component with type default ACL', () => {
    register('secret', 'acl', () => [{ g: 'admins', p: R }]);
    const node = {
      ...createNode('/test', 'test'),
      $owner: 'alice',
      '#meta': { $type: 'metadata', title: 'hi' },
      '#token': { $type: 'secret', value: 's3cret' },
    };
    // alice is not admin
    const stripped = stripComponents(node, 'alice', ['u:alice']);
    assert.ok('#meta' in stripped);
    assert.ok(!('#token' in stripped));
  });

  it('allows component with type ACL when user matches', () => {
    register('secret', 'acl', () => [{ g: 'admins', p: R }]);
    const node = {
      ...createNode('/test', 'test'),
      '#token': { $type: 'secret', value: 's3cret' },
    };
    const stripped = stripComponents(node, 'admin', ['u:admin', 'admins']);
    assert.ok('#token' in stripped);
  });

  it('strips component with instance $acl', () => {
    const node = {
      ...createNode('/test', 'test'),
      $owner: 'alice',
      '#settings': { $type: 'config', $acl: [{ g: 'owner', p: R }], api: 'key' },
    };
    // bob is not owner
    const stripped = stripComponents(node, 'bob', ['u:bob']);
    assert.ok(!('#settings' in stripped));
    // alice is owner
    const stripped2 = stripComponents(node, 'alice', ['u:alice']);
    assert.ok('#settings' in stripped2);
  });

  it('bare $type-carrying value is node body — never stripped (strict namespace)', () => {
    register('secret', 'acl', () => [{ g: 'admins', p: R }]);
    const node = {
      ...createNode('/test', 'test'),
      snapshot: { $type: 'secret', value: 'stored-as-data' },
    };
    const stripped = stripComponents(node, 'alice', ['u:alice']);
    assert.ok('snapshot' in stripped, 'bare key is body — node-level R already covers it');
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

  it('preserves $refId on ref nodes — lazy adoption must see it (gk8.10 stage 2)', () => {
    const node: NodeData = { ...createNode('/sys/autostart/bot', 'ref'), $ref: '/bot', $refId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' };
    const stripped = stripComponents(node, null, []);
    assert.equal(stripped.$refId, '01ARZ3NDEKTSV4RRFFQ69G5FAV');
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
      '#groups': { $type: 'groups', list: ['admins', 'editors'] },
    });
    const claims = await buildClaims(tree, 'alice');
    assert.ok(claims.includes('admins'));
    assert.ok(claims.includes('editors'));
    assert.ok(claims.includes('u:alice'));
    assert.ok(claims.includes('authenticated'));
  });

  // Privilege-escalation gate: a component planted at key 'groups' but with a different $type
  // (which bypasses the registered groups type-acl on write) must NOT contribute claims.
  it('ignores groups key with mismatched $type (poisoning attempt)', async () => {
    await tree.set({
      ...createNode('/auth/users/mallory', 'user'),
      $owner: 'mallory',
      '#groups': { $type: 'x', list: ['admins'] },
    });
    const claims = await buildClaims(tree, 'mallory');
    assert.ok(!claims.includes('admins'), 'must not gain admins via fake $type');
    assert.ok(claims.includes('u:mallory'));
  });

  // Regression (F15): production calls buildClaims through withAcl(tree,'system',['system']),
  // NOT a raw store. The user node ACL ({owner:R|W},{authenticated:0}) grants the 'system'
  // identity nothing on that node — so the system reader must inherit R from the root grant,
  // otherwise stripComponents drops `groups` and the user loses every group claim.
});

// F15 regression: buildClaims/register/devLogin read+write the user's `groups`
// component through withAcl(tree,'system',['system']). The groups type-ACL must grant
// 'system' like any other group — otherwise componentPerm strips/denies it and the
// kernel can neither establish group claims nor provision users. (chicken-and-egg:
// the groups read needs the very claim that reading groups would establish.)
describe('system identity — groups component access (F15)', () => {
  const seedAdmin = async (t: Tree) => {
    register('groups', 'acl', () => GROUPS_ACL);
    await t.set({ ...createNode('/', 'root'), $acl: [{ g: 'system', p: R | W | A | S }] });
    await t.set({
      ...createNode('/auth/users/admin', 'user'),
      $owner: 'admin',
      $acl: [{ g: 'owner', p: R | W }, { g: 'authenticated', p: 0 }],
      '#groups': { $type: 'groups', list: ['admins'] },
    });
  };

  it('buildClaims resolves groups through the system tree (read path)', async () => {
    const prod = createMemoryTree();
    await seedAdmin(prod);
    const systemTree = withAcl(prod, 'system', ['system']);
    const claims = await buildClaims(systemTree, 'admin');
    assert.ok(claims.includes('admins'), `expected admins, got ${JSON.stringify(claims)}`);
  });

  it('system tree can write a user node carrying a groups component (write path)', async () => {
    const prod = createMemoryTree();
    register('groups', 'acl', () => GROUPS_ACL);
    await prod.set({ ...createNode('/', 'root'), $acl: [{ g: 'system', p: R | W | A | S }] });
    const systemTree = withAcl(prod, 'system', ['system']);
    await systemTree.set({
      ...createNode('/auth/users/bob', 'user'),
      $owner: 'bob',
      '#groups': { $type: 'groups', list: ['admins'] },
    });
    const claims = await buildClaims(systemTree, 'bob');
    assert.ok(claims.includes('admins'), `expected admins after write, got ${JSON.stringify(claims)}`);
  });
});

// F4: mount adapters reach outside the tree (disk, network, DB). Authoring or
// reading their config is a server capability — even an owner with A on their
// subtree must not mount the server's filesystem there.
describe('mount authoring (F4)', () => {
  const alice = () => withAcl(tree, 'alice', ['u:alice', 'authenticated']);
  const forbidden = (e: unknown) => e instanceof KernelError && e.code === 'FORBIDDEN';

  beforeEach(() => {
    register('test.mount.disk', 'mount', () => createMemoryTree());
    register('test.mount.view', 'mount', () => createMemoryTree(), { userAuthorable: true });
  });

  it('owner cannot author a server mount on their own subtree (set, patch, any key)', async () => {
    const disk = { $type: 'test.mount.disk', root: '/' };
    await assert.rejects(() => alice().set(createNode('/users/alice/x', 'dir', {}, { mount: disk })), forbidden);
    await assert.rejects(() => alice().set(createNode('/users/alice/x', 'dir', {}, { layer: disk })), forbidden);
    await assert.rejects(() => alice().patch('/users/alice/page', [['r', '#mount', disk]]), forbidden);
    assert.equal(await tree.get('/users/alice/x'), undefined);
  });

  it('admins and system author server mounts', async () => {
    await tree.set({ ...createNode('/', 'root'), $acl: [{ g: 'admins', p: R | W | A }, { g: 'system', p: R | W | A }] });
    const disk = { $type: 'test.mount.disk', root: '/data' };
    await withAcl(tree, 'root', ['u:root', 'admins']).set(createNode('/a', 'dir', {}, { mount: disk }));
    await withAcl(tree, 'system', ['system']).set(createNode('/s', 'dir', {}, { mount: disk }));
    assert.ok(await tree.get('/a'));
    assert.ok(await tree.get('/s'));
  });

  it('server mount config is hidden from non-admin readers', () => {
    const node = createNode('/users/alice/m', 'dir', {}, { mount: { $type: 'test.mount.disk', token: 'secret' } });
    assert.equal(stripComponents(node, 'alice', ['u:alice', 'authenticated'])['#mount'], undefined);
    assert.ok(stripComponents(node, 'root', ['u:root', 'admins'])['#mount']);
  });

  it('a userAuthorable adapter (in-tree view) stays open to the node writer', async () => {
    await alice().set(createNode('/users/alice/col', 'dir', {}, {
      mount: { $type: 'test.mount.view' },
    }));
    assert.ok((await tree.get('/users/alice/col'))?.['#mount']);
  });

  it('plain component types carry no type rule', () => {
    assert.equal(typeAclRule('dir'), undefined);
    assert.ok(typeAclRule('test.mount.disk'));
    assert.equal(typeAclRule('test.mount.view'), undefined);
  });
});

// Long-lived wrappers (systemTree, an MCP session) must see revocations: the
// ancestor memo resets every second instead of living as long as the wrapper.
describe('withAcl revocation', () => {
  afterEach(() => mock.timers.reset());

  it('a revoked ancestor grant reaches a long-lived wrapper within the memo window', async () => {
    mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
    await tree.set({ ...createNode('/proj', 'dir'), $acl: [{ g: 'agents', p: R | W }] });
    await tree.set(createNode('/proj/a', 'doc'));
    await tree.set(createNode('/proj/b', 'doc'));
    const agent = withAcl(tree, 'ag', ['u:ag', 'agents']);
    assert.ok(await agent.get('/proj/a'));

    await tree.patch('/proj', [['r', '$acl', [{ g: 'agents', p: 0 }]]]);
    mock.timers.tick(1001);
    const forbidden = (e: unknown) => e instanceof KernelError && e.code === 'FORBIDDEN';
    await assert.rejects(() => agent.get('/proj/a'), forbidden);
    await assert.rejects(() => agent.get('/proj/b'), forbidden);
    await assert.rejects(() => agent.set(createNode('/proj/b', 'doc')), forbidden);
  });
});

// A component's $acl is permission data: W without A must not plant or change it.
describe('component $acl needs A', () => {
  const forbidden = (e: unknown) => e instanceof KernelError && e.code === 'FORBIDDEN';

  it('writer without A cannot plant a component $acl — by patch or set', async () => {
    await tree.set({ ...createNode('/shared', 'dir'), $acl: [{ g: 'u:bob', p: R | W }] });
    await tree.set(createNode('/shared/doc', 'doc'));
    const bob = withAcl(tree, 'bob', ['u:bob', 'authenticated']);
    const stash = { $type: 'stash', $acl: [{ g: 'u:bob', p: R | W }] };

    await assert.rejects(() => bob.patch('/shared/doc', [['r', '#stash', stash]]), forbidden);
    await assert.rejects(() => bob.set(createNode('/shared/doc', 'doc', {}, { stash })), forbidden);
    assert.equal((await tree.get('/shared/doc'))?.['#stash'], undefined);

    await bob.patch('/shared/doc', [['r', '#note', { $type: 'note', text: 'ok' }]]);
    assert.ok((await tree.get('/shared/doc'))?.['#note'], 'components without $acl stay writable');
  });

  it('owner with A sets a component $acl', async () => {
    const alice = withAcl(tree, 'alice', ['u:alice', 'authenticated']);
    await alice.patch('/users/alice/page', [['r', '#priv', { $type: 'priv', $acl: [{ g: 'u:alice', p: R | W }] }]]);
    assert.ok((await tree.get('/users/alice/page'))?.['#priv']);
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

  it('same-node allow then deny revokes the granted bit (order-independent)', async () => {
    await tree.set({
      ...createNode('/sad', 'doc'),
      $acl: [
        { g: 'editors', p: R | W },
        { g: 'editors', p: -W },
      ],
    });
    const perm = await resolvePermission(tree, '/sad', 'ed1', ['u:ed1', 'editors']);
    assert.equal(perm, R); // deny applies even though the allow came first
  });

  it('ancestor allow, descendant deny — deny wins (sticky downward)', async () => {
    await tree.set({
      ...createNode('/anc', 'dir'),
      $acl: [{ g: 'editors', p: R | W }],
    });
    await tree.set({
      ...createNode('/anc/desc', 'doc'),
      $acl: [{ g: 'editors', p: -W }],
    });
    const perm = await resolvePermission(tree, '/anc/desc', 'ed1', ['u:ed1', 'editors']);
    assert.equal(perm, R); // descendant -W must revoke the ancestor's W grant
  });

  it('component ACL allow then deny revokes the granted bit', async () => {
    const comp: ComponentData = {
      $type: 'doc',
      $acl: [
        { g: 'editors', p: R | W },
        { g: 'editors', p: -W },
      ],
    };
    const perm = componentPerm(comp, 'ed1', ['u:ed1', 'editors'], undefined);
    assert.equal(perm, R);
  });
});

describe('withAcl', () => {
  it('alice reads her own page', async () => {
    const s = withAcl(tree, 'alice', ['u:alice', 'authenticated']);
    assert.ok(await s.get('/users/alice/page'));
  });

  it("alice cannot read bob's page", async () => {
    const s = withAcl(tree, 'alice', ['u:alice', 'authenticated']);
    await assert.rejects(s.get('/users/bob/page'), (e: any) => e.code === 'FORBIDDEN');
  });

  it('filters getChildren', async () => {
    const s = withAcl(tree, 'alice', ['u:alice', 'authenticated']);
    const children = await s.getChildren('/users', { depth: -1 });
    const paths = children.items.map((c) => c.$path);
    assert.ok(paths.includes('/users/alice'));
    assert.ok(!paths.includes('/users/bob'));
  });

  it('preserves caller query before ACL filtering', async () => {
    await tree.set({
      ...createNode('/projects', 'dir'),
      $acl: [{ g: 'authenticated', p: R }],
    });
    await tree.set({
      ...createNode('/projects/open', 'doc', { status: 'open' }),
      $acl: [{ g: 'authenticated', p: R }],
    });
    await tree.set({
      ...createNode('/projects/closed', 'doc', { status: 'closed' }),
      $acl: [{ g: 'authenticated', p: R }],
    });

    const s = withAcl(tree, 'alice', ['u:alice', 'authenticated']);
    const children = await s.getChildren('/projects', { query: { status: 'open' } });

    assert.deepEqual(children.items.map(c => c.$path), ['/projects/open']);
    assert.equal(children.total, 1);
  });

  it('paginates query views by cursor — no duplicate, no skip (core-92z)', async () => {
    await tree.set({
      ...createNode('/tasks', 'dir'),
      $acl: [{ g: 'authenticated', p: R }],
    });
    for (const [name, status] of [['a', 'open'], ['b', 'closed'], ['c', 'open'], ['d', 'open']] as const) {
      await tree.set({
        ...createNode(`/tasks/${name}`, 'task', { status }),
        $acl: [{ g: 'authenticated', p: R }],
      });
    }

    const s = withAcl(tree, 'alice', ['u:alice', 'authenticated']);
    const page1 = await s.getChildren('/tasks', { query: { status: 'open' }, limit: 2 });
    assert.deepEqual(page1.items.map(c => c.$path), ['/tasks/a', '/tasks/c']);
    assert.equal(page1.total, 2); // returned count only — never an exact total
    assert.ok(page1.nextCursor, 'more matches exist → nextCursor present');

    const page2 = await s.getChildren('/tasks', { query: { status: 'open' }, limit: 2, cursor: page1.nextCursor });
    assert.deepEqual(page2.items.map(c => c.$path), ['/tasks/d']);
    assert.equal(page2.nextCursor, undefined, 'end of matches → no nextCursor');
  });

  it('paginates plain listings by cursor', async () => {
    await tree.set({
      ...createNode('/tasks2', 'dir'),
      $acl: [{ g: 'authenticated', p: R }],
    });
    await tree.set(createNode('/tasks2/a', 'task'));
    await tree.set(createNode('/tasks2/b', 'task'));

    const s = withAcl(tree, 'alice', ['u:alice', 'authenticated']);
    const page1 = await s.getChildren('/tasks2', { limit: 1 });
    assert.ok(page1.nextCursor);
    const page2 = await s.getChildren('/tasks2', { limit: 1, cursor: page1.nextCursor });
    assert.deepEqual([...page1.items, ...page2.items].map(n => n.$path), ['/tasks2/a', '/tasks2/b']);
  });

  it('deep query reads paginate by cursor; ACL filters at every depth (core-0bl)', async () => {
    await tree.set({
      ...createNode('/wiki', 'dir'),
      $acl: [{ g: 'authenticated', p: R }],
    });
    await tree.set(createNode('/wiki/a', 'doc', { status: 'open' }));
    await tree.set(createNode('/wiki/a/x', 'doc', { status: 'open' }));
    await tree.set(createNode('/wiki/a/y', 'doc', { status: 'done' }));
    await tree.set(createNode('/wiki/b', 'doc', { status: 'open' }));
    await tree.set({
      ...createNode('/wiki/b/private', 'doc', { status: 'open' }),
      $owner: 'bob',
      $acl: [
        { g: 'owner', p: R | W | A },
        { g: 'authenticated', p: 0 },
      ],
    });

    const s = withAcl(tree, 'alice', ['u:alice', 'authenticated']);
    const page1 = await s.getChildren('/wiki', { depth: -1, query: { status: 'open' }, limit: 2 });
    assert.deepEqual(page1.items.map(c => c.$path), ['/wiki/a', '/wiki/a/x']);
    assert.ok(page1.nextCursor, 'more matches exist → nextCursor present');

    const page2 = await s.getChildren('/wiki', { depth: -1, query: { status: 'open' }, limit: 2, cursor: page1.nextCursor });
    assert.deepEqual(page2.items.map(c => c.$path), ['/wiki/b'], "bob's node filtered out at depth 2");
    assert.equal(page2.nextCursor, undefined);

    // Cursor↔plan binding (core-8an): a deep-scan cursor cannot resume a
    // depth-1 read — depth is part of plan identity.
    await assert.rejects(
      () => s.getChildren('/wiki', { query: { status: 'open' }, limit: 2, cursor: page1.nextCursor }),
      (e: unknown) => e instanceof KernelError && e.code === 'INVALID',
    );
  });

  it('does not let query probe hidden component fields', async () => {
    register('private.secret', 'acl', () => [{ g: 'authenticated', p: 0 }]);
    await tree.set({
      ...createNode('/docs', 'dir'),
      $acl: [{ g: 'authenticated', p: R }],
    });
    await tree.set({
      ...createNode('/docs/a', 'doc', { title: 'A' }, {
        secret: { $type: 'private.secret', value: 'alpha' },
      }),
      $acl: [{ g: 'authenticated', p: R }],
    });
    await tree.set({
      ...createNode('/docs/b', 'doc', { title: 'B' }, {
        secret: { $type: 'private.secret', value: 'beta' },
      }),
      $acl: [{ g: 'authenticated', p: R }],
    });

    const s = withAcl(tree, 'alice', ['u:alice', 'authenticated']);
    const all = await s.getChildren('/docs');
    assert.deepEqual(all.items.map(c => c.$path), ['/docs/a', '/docs/b']);
    assert.ok(all.items.every(c => !('#secret' in c)));

    // The predicate evaluates on alice's projection, where #secret is absent: a
    // right and a wrong guess answer identically. (An earlier FORBIDDEN-when-raw-
    // matches rule WAS the oracle — it extracted hidden values char by char.)
    for (const guess of ['alpha', 'zeta', { $gte: 'a' }, { $gte: 'z' }]) {
      const page = await s.getChildren('/docs', { query: { '#secret.value': guess } });
      assert.deepEqual(page.items, [], `guess ${JSON.stringify(guess)}`);
    }
  });

  it('does not let query probe stripped $owner or $acl fields', async () => {
    await tree.set({
      ...createNode('/owned', 'dir'),
      $acl: [{ g: 'authenticated', p: R }],
    });
    await tree.set({
      ...createNode('/owned/a', 'doc'),
      $owner: 'alice',
      $acl: [{ g: 'authenticated', p: R }],
    });

    const s = withAcl(tree, 'bob', ['u:bob', 'authenticated']);
    assert.equal((await s.getChildren('/owned')).items.length, 1);

    // bob has R but not A, so $owner/$acl are stripped from his projection —
    // querying them is a hidden-field oracle → FORBIDDEN (core-fnv).
    await assert.rejects(
      () => s.getChildren('/owned', { query: { $owner: 'alice' } }),
      (e: unknown) => e instanceof KernelError && e.code === 'FORBIDDEN',
    );
    await assert.rejects(
      () => s.getChildren('/owned', { query: { $acl: { $exists: true } } }),
      (e: unknown) => e instanceof KernelError && e.code === 'FORBIDDEN',
    );
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
    await assert.rejects(s.get('/users/alice/page'), (e: any) => e.code === 'FORBIDDEN');
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

  // MVP rule 7: a query mount whose virtual path is readable but whose
  // source directory is not must NOT leak source-children even if those
  // children individually grant R — that would be a capability view.
  it('rejects query mount over unreadable source even when children grant R', async () => {
    await tree.set({
      ...createNode('/virtual', 'mount-point'),
      $acl: [{ g: 'authenticated', p: R }],
      '#mount': { $type: 't.mount.query', source: '/private', match: {} },
    });
    // /private: no R for authenticated → unreadable source
    await tree.set({ ...createNode('/private', 'dir'), $acl: [] });
    // child grants R directly — without the source-readability gate, the
    // scan would project this child as visible.
    await tree.set({
      ...createNode('/private/leaked', 'doc'),
      $acl: [{ g: 'authenticated', p: R }],
    });

    const s = withAcl(tree, 'alice', ['u:alice', 'authenticated']);
    await assert.rejects(
      () => s.getChildren('/virtual'),
      (e: unknown) => e instanceof KernelError && e.code === 'FORBIDDEN',
    );
  });
});

describe('sessions', () => {
  let ss: Tree;
  beforeEach(async () => {
    ss = createMemoryTree();
    for (const id of ['alice', 'bob']) await ss.set(createNode(`/auth/users/${id}`, 'user', { status: 'active' }));
  });

  it('create and resolve', async () => {
    const token = await createSession(ss, 'alice');
    const session = await resolveToken(ss, token);
    assert.equal(session?.userId, 'alice');
  });

  // A session is only as alive as its account.
  it('a blocked, pending or deleted account kills its live sessions', async () => {
    const token = await createSession(ss, 'alice');
    for (const status of ['blocked', 'pending']) {
      await ss.patch('/auth/users/alice', [['r', 'status', status]]);
      assert.equal(await resolveToken(ss, token), null, status);
    }
    await ss.patch('/auth/users/alice', [['r', 'status', 'active']]);
    assert.equal((await resolveToken(ss, token))?.userId, 'alice', 'reactivation restores it');
    await ss.remove('/auth/users/alice');
    assert.equal(await resolveToken(ss, token), null, 'deleted');
  });

  it('the owner can neither read nor rewrite their password hash', async () => {
    register('credentials', 'acl', () => [{ g: 'system', p: R | W }, { g: 'admins', p: R | W }]);
    await ss.set({
      ...createNode('/auth/users/carol', 'user', { status: 'active' }, { credentials: { $type: 'credentials', hash: 'h' } }),
      $owner: 'carol',
      $acl: [{ g: 'owner', p: R | W }],
    });
    const carol = withAcl(ss, 'carol', ['u:carol', 'authenticated']);
    assert.equal((await carol.get('/auth/users/carol'))?.['#credentials'], undefined);
    await assert.rejects(
      () => carol.patch('/auth/users/carol', [['r', '#credentials', { $type: 'credentials', hash: 'mine' }]]),
      (e: unknown) => e instanceof KernelError && e.code === 'FORBIDDEN',
    );
  });

  it('default session and cookie last several days', async () => {
    const token = await createSession(ss, 'alice');
    const node = await ss.get(sessionPath(token));

    assert.equal(typeof node?.createdAt, 'number');
    assert.equal(typeof node?.expiresAt, 'number');
    if (typeof node?.createdAt !== 'number' || typeof node.expiresAt !== 'number') {
      throw new Error('session timestamps missing');
    }

    assert.equal(node.expiresAt - node.createdAt, SESSION_TTL_MS);
    assert.match(buildSessionCookie(token), /Max-Age=604800(?:;|$)/);
  });

  it('session nodes have admin-only $acl', async () => {
    const token = await createSession(ss, 'alice');
    const node = await ss.get(sessionPath(token));
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
    await assert.rejects(
      userTree.get(sessionPath(token)),
      (e: any) => e.code === 'FORBIDDEN',
      'non-admin should not read session node',
    );

    // Admin: allowed
    const adminTree = withAcl(ss, 'admin', ['u:admin', 'admins', 'authenticated']);
    const adminNode = await adminTree.get(sessionPath(token));
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

  it('R4-AUTH-5: session path is the hash, not the plaintext token', async () => {
    const token = await createSession(ss, 'alice');
    // Plaintext-token path must NOT be a stored node — that would mean a DB dump leaks bearers.
    const rawPathNode = await ss.get(`/auth/sessions/${token}`);
    assert.equal(rawPathNode, undefined,
      'session must NOT be stored under the plaintext token path — leaks bearer on storage exposure');

    // Hashed path resolves; resolveToken still finds the session via the plaintext token.
    const hashedNode = await ss.get(sessionPath(token));
    assert.ok(hashedNode, 'session must exist under sha256(token) path');
    const session = await resolveToken(ss, token);
    assert.equal(session?.userId, 'alice');
  });

  it('resolveToken returns custom metadata fields written to session node', async () => {
    const token = await createSession(ss, 'alice');
    // Mod patches session-node with arbitrary fields (taskPath, runPath, etc.)
    await ss.patch(sessionPath(token), [
      ['a', 'taskPath', '/board/tasks/123'],
      ['a', 'runPath', '/agents/landing-bot/runs/r-7f2a'],
    ]);
    const session = await resolveToken(ss, token) as Record<string, unknown> | null;
    assert.equal(session?.userId, 'alice');
    assert.equal(session?.taskPath, '/board/tasks/123');
    assert.equal(session?.runPath, '/agents/landing-bot/runs/r-7f2a');
  });

  it('resolveToken does not expose $-prefixed system fields', async () => {
    const token = await createSession(ss, 'alice');
    const session = await resolveToken(ss, token) as Record<string, unknown> | null;
    assert.ok(session);
    for (const key of Object.keys(session!)) {
      assert.ok(!key.startsWith('$'), `system field leaked: ${key}`);
    }
  });
});

describe('system identity guards (F15)', () => {
  it('SYSTEM_CLAIM is the reserved string "system"', () => {
    assert.equal(SYSTEM_CLAIM, 'system');
  });

  it('assertNotSystem rejects userId "system"', () => {
    assert.throws(() => assertNotSystem('system'), (e: any) => e instanceof KernelError && e.code === 'FORBIDDEN');
  });

  it('assertNotSystem rejects claims containing "system"', () => {
    assert.throws(
      () => assertNotSystem('alice', ['authenticated', 'system']),
      (e: any) => e instanceof KernelError && e.code === 'FORBIDDEN',
    );
  });

  it('assertNotSystem accepts ordinary users and claim lists', () => {
    assert.doesNotThrow(() => assertNotSystem('alice'));
    assert.doesNotThrow(() => assertNotSystem('alice', ['authenticated', 'u:alice']));
  });

  it('createSession refuses userId "system"', async () => {
    const ss = createMemoryTree();
    await assert.rejects(
      createSession(ss, 'system'),
      (e: any) => e instanceof KernelError && e.code === 'FORBIDDEN',
    );
  });

  it('createSession refuses opts.claims containing "system"', async () => {
    const ss = createMemoryTree();
    await assert.rejects(
      createSession(ss, 'alice', { claims: ['authenticated', 'system'] }),
      (e: any) => e instanceof KernelError && e.code === 'FORBIDDEN',
    );
  });

  it('buildClaims refuses userId "system"', async () => {
    const ss = createMemoryTree();
    await assert.rejects(
      buildClaims(ss, 'system'),
      (e: any) => e instanceof KernelError && e.code === 'FORBIDDEN',
    );
  });

  it('buildClaims strips "system" if it appears in user groups list', async () => {
    const ss = createMemoryTree();
    // A poisoned user record with "system" in its groups list must never escalate.
    await ss.set({
      $path: '/auth/users/alice', $type: 'user',
      '#groups': { $type: 'groups', list: ['admins', 'system'] },
    });
    const claims = await buildClaims(ss, 'alice');
    assert.ok(claims.includes('admins'), 'real groups preserved');
    assert.ok(!claims.includes('system'), 'system claim must be filtered out');
  });

  it('resolveToken drops a forged session whose userId is "system"', async () => {
    const ss = createMemoryTree();
    const { randomBytes } = await import('node:crypto');
    const token = randomBytes(32).toString('hex');
    const now = Date.now();
    // Directly write a session with the reserved userId — simulates a future ACL hole.
    await ss.set({
      $path: sessionPath(token), $type: 'session',
      userId: 'system', createdAt: now, expiresAt: now + 60_000,
    });
    assert.equal(await resolveToken(ss, token), null);
    // Defence-in-depth: the forged session is also removed on the way out.
    assert.equal(await ss.get(sessionPath(token)), undefined);
  });

  it('resolveToken drops a forged session whose claims contain "system"', async () => {
    const ss = createMemoryTree();
    const { randomBytes } = await import('node:crypto');
    const token = randomBytes(32).toString('hex');
    const now = Date.now();
    await ss.set({
      $path: sessionPath(token), $type: 'session',
      userId: 'alice', createdAt: now, expiresAt: now + 60_000,
      claims: ['authenticated', 'system'],
    });
    assert.equal(await resolveToken(ss, token), null);
    assert.equal(await ss.get(sessionPath(token)), undefined);
  });

  it('registerUser rejects userId "system"', async () => {
    const ss = createMemoryTree();
    await assert.rejects(
      registerUser(ss, 'system', 'pw'),
      (e: any) => e instanceof KernelError && e.code === 'FORBIDDEN',
    );
  });

  it('loginUser rejects userId "system"', async () => {
    const ss = createMemoryTree();
    await assert.rejects(
      loginUser(ss, 'system', 'pw'),
      (e: any) => e instanceof KernelError && e.code === 'FORBIDDEN',
    );
  });
});

describe('getChildren truncation', () => {
  beforeEach(() => clearRegistry());

  it('plain listings stop at the page limit and return a cursor', async () => {
    const base = createMemoryTree();
    // Parent must be readable now that getChildren throws FORBIDDEN on
    // unreadable parents — otherwise we'd never reach the truncation path.
    await base.set({
      ...createNode('/big', 'folder'),
      $acl: [{ g: 'authenticated', p: R }],
    });
    for (let i = 0; i < 1_001; i++) {
      await base.set(createNode(`/big/${String(i).padStart(4, '0')}`, 'doc'));
    }

    const s = withAcl(base, 'admin', ['u:admin', 'authenticated']);
    const result = await s.getChildren('/big');
    assert.equal(result.items.length, 100);
    assert.ok(result.nextCursor);
    assert.equal(result.truncated, undefined);
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

  // e47f8e2 changed executeList to return {items, truncated:true} on budget
  // exhaustion instead of throwing. Verify withAcl.getChildren
  // propagates that flag — the consumer must see "incomplete", not partial
  // success dressed as success. Default budget is 10_000 raw items; we seed
  // > budget with a never-matching query so the scan exhausts before
  // collecting limit+1.
  it('propagates executeList truncated:true when callerWhere never matches and budget exhausts', async () => {
    const base = createMemoryTree();
    await base.set({
      ...createNode('/huge', 'folder'),
      $acl: [{ g: 'authenticated', p: R }],
    });
    // Seed budget+1 so the executeList loop scans every entry without
    // collecting any (impossible callerWhere), then trips the budget guard.
    // Importing DEFAULT_BUDGET keeps this test in sync with the runtime constant.
    const N = DEFAULT_BUDGET.maxRawScanned + 1;
    for (let i = 0; i < N; i++) {
      await base.set(createNode(`/huge/${String(i).padStart(5, '0')}`, 'doc'));
    }

    const s = withAcl(base, 'admin', ['u:admin', 'authenticated']);
    const result = await s.getChildren('/huge', { query: { neverMatchField: 'impossible' } });
    assert.equal(result.truncated, true, 'truncated must propagate from executeList');
    assert.equal(result.items.length, 0, 'no items match the impossible predicate');
  });
});

describe('buildClaims — groups from user record', () => {
  it('includes authenticated + u:<id> + user groups list', async () => {
    await tree.set({
      ...createNode('/auth/users/carol', 'user'),
      $owner: 'carol',
      '#groups': { $type: 'groups', list: ['editors', 'reviewers'] },
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

describe('withAcl denial — typed KernelError', () => {
  it('set without W throws KernelError with code FORBIDDEN', async () => {
    const s = withAcl(tree, 'bob', ['u:bob', 'authenticated']);
    await assert.rejects(
      () => s.set(createNode('/users/alice/page', 'page', { title: 'hijacked' })),
      (e: unknown) => e instanceof KernelError && e.code === 'FORBIDDEN',
    );
  });

  it('remove without W throws KernelError with code FORBIDDEN', async () => {
    const s = withAcl(tree, 'bob', ['u:bob', 'authenticated']);
    await assert.rejects(
      () => s.remove('/users/alice/page'),
      (e: unknown) => e instanceof KernelError && e.code === 'FORBIDDEN',
    );
  });

  it('patch without W throws KernelError with code FORBIDDEN', async () => {
    const s = withAcl(tree, 'bob', ['u:bob', 'authenticated']);
    await assert.rejects(
      () => s.patch('/users/alice/page', [['r', 'title', 'hijacked']]),
      (e: unknown) => e instanceof KernelError && e.code === 'FORBIDDEN',
    );
  });
});

// ── Commit receipts at the ACL boundary (core-ns6p.2) ──
// Receipts are read-backs: images must obey the SAME projection as get() —
// $acl/$owner gated on A, components stripped — and a caller who cannot READ
// the path commits blind (opaque receipt), never sees before-images.

describe('withAcl — receipt projection (core-ns6p.2)', () => {
  it('R+W without A: receipt images carry data but never $acl/$owner', async () => {
    await tree.set({
      ...createNode('/rcpt/a', 'doc'),
      $acl: [{ g: 'authenticated', p: R | W }],
      title: 'v1',
    });
    const s = withAcl(tree, 'alice', ['u:alice', 'authenticated']);

    const node = (await s.get('/rcpt/a'))!;
    const receipt = await s.set({ ...node, title: 'v2' });

    const c = receipt.changes?.[0];
    assert.ok(c?.after, 'receipt present for a readable writer');
    assert.equal(c.after.title, 'v2');
    assert.equal(c.after.$acl, undefined, '$acl projected out without A');
    assert.equal(c.before?.title, 'v1');
    assert.equal(c.before?.$acl, undefined);
  });

  it('W-without-R: the write commits but the receipt is opaque — no images', async () => {
    await tree.set({
      ...createNode('/rcpt/blind', 'doc'),
      $acl: [{ g: 'authenticated', p: W }],
      secret: 'hidden-before',
    });
    const s = withAcl(tree, 'alice', ['u:alice', 'authenticated']);

    const receipt = await s.set(createNode('/rcpt/blind', 'doc', { note: 'dropped off' }));
    assert.equal(receipt.changes, null, 'no R — fail closed, images stay server-side');
    assert.equal((await tree.get('/rcpt/blind'))?.note, 'dropped off', 'the write itself landed');
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
      (e: unknown) => e instanceof KernelError && e.code === 'NOT_FOUND',
    );
  });

  // B5: patch without W → FORBIDDEN (existing behavior).
  it('B5: patch without W throws FORBIDDEN', async () => {
    const s = withAcl(tree, 'bob', ['u:bob', 'authenticated']);
    await assert.rejects(
      () => s.patch('/users/alice/page', [['r', 'title', 'hijacked']]),
      (e: unknown) => e instanceof KernelError && e.code === 'FORBIDDEN',
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
      (e: unknown) => e instanceof KernelError && e.code === 'FORBIDDEN',
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
      (e: unknown) => e instanceof KernelError && e.code === 'FORBIDDEN',
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
      (e: unknown) => e instanceof KernelError && e.code === 'FORBIDDEN',
    );
    await assert.rejects(
      () => s.patch('/n', [['t', '$owner', 'someone']]),
      (e: unknown) => e instanceof KernelError && e.code === 'FORBIDDEN',
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
      (e: unknown) => e instanceof KernelError && e.code === 'FORBIDDEN',
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
      (e: unknown) => e instanceof KernelError && e.code === 'FORBIDDEN',
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
      (e: unknown) => e instanceof KernelError && e.code === 'FORBIDDEN',
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
        (e: unknown) => e instanceof KernelError && e.code === 'FORBIDDEN',
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

  // N10b: $refId mutates wherever $ref does — retarget/repair write both.
  it('N10b: $refId add/replace allowed wherever $ref replace is allowed (R+W)', async () => {
    await tree.set({
      ...createNode('/sys/autostart/bot', 'ref'),
      $ref: '/bot',
      $acl: [{ g: 'authenticated', p: R | W }],
    });
    const s = withAcl(tree, 'alice', ['u:alice', 'authenticated']);
    await s.patch('/sys/autostart/bot', [
      ['r', '$ref', '/new-bot'],
      ['a', '$refId', '01ARZ3NDEKTSV4RRFFQ69G5FAV'],
    ]);
    const after = (await tree.get('/sys/autostart/bot'))!;
    assert.equal(after.$ref, '/new-bot');
    assert.equal(after.$refId, '01ARZ3NDEKTSV4RRFFQ69G5FAV');
  });

  // N10c: $refId is read-visible → t-op allowed (no oracle).
  it('N10c: t on $refId allowed with R+W', async () => {
    await tree.set({
      ...createNode('/sys/autostart/bot', 'ref'),
      $ref: '/bot',
      $refId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      $acl: [{ g: 'authenticated', p: R | W }],
    });
    const s = withAcl(tree, 'alice', ['u:alice', 'authenticated']);
    await s.patch('/sys/autostart/bot', [
      ['t', '$refId', '01ARZ3NDEKTSV4RRFFQ69G5FAV'],
      ['r', '$ref', '/moved-bot'],
    ]);
    assert.equal((await tree.get('/sys/autostart/bot'))!.$ref, '/moved-bot');
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
      (e: unknown) => e instanceof KernelError && e.code === 'FORBIDDEN',
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
      (e: unknown) => e instanceof KernelError && e.code === 'FORBIDDEN',
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
      (e: unknown) => e instanceof KernelError && e.code === 'FORBIDDEN',
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
      (e: unknown) => e instanceof KernelError && e.code === 'FORBIDDEN',
    );
  });

  it('set rejects replacing existing component with no W by non-component value', async () => {
    register('secret', 'acl', () => [{ g: 'owner', p: R | W | A }]);
    await tree.set({
      ...createNode('/set-protected', 'doc'),
      $owner: 'bob',
      $acl: [{ g: 'authenticated', p: R | W }],
      secret: { $type: 'secret', x: 'orig' },
    });

    const s = withAcl(tree, 'alice', ['u:alice', 'authenticated']);
    const badNode: NodeData = {
      ...createNode('/set-protected', 'doc'),
      $owner: 'bob',
      $acl: [{ g: 'authenticated', p: R | W }],
      secret: null,
    };
    await assert.rejects(
      () => s.set(badNode),
      (e: unknown) => e instanceof KernelError && e.code === 'FORBIDDEN',
    );

    const after = await tree.get('/set-protected') as NodeData;
    assert.deepEqual(after.secret, { $type: 'secret', x: 'orig' });
  });

  it('set reattaches omitted existing component with no W', async () => {
    register('secret', 'acl', () => [{ g: 'owner', p: R | W | A }]);
    await tree.set({
      ...createNode('/set-echo', 'doc'),
      $owner: 'bob',
      $acl: [{ g: 'authenticated', p: R | W }],
      secret: { $type: 'secret', x: 'orig' },
    });

    const s = withAcl(tree, 'alice', ['u:alice', 'authenticated']);
    await s.set({
      ...createNode('/set-echo', 'doc'),
      $owner: 'bob',
      $acl: [{ g: 'authenticated', p: R | W }],
      title: 'visible edit',
    } as NodeData);

    const after = await tree.get('/set-echo') as NodeData;
    assert.equal(after.title, 'visible edit');
    assert.deepEqual(after.secret, { $type: 'secret', x: 'orig' });
  });

  it('set rejects adding new component when incoming value has no W', async () => {
    register('restricted', 'acl', () => [{ g: 'staff', p: R | W }]);
    await tree.set({
      ...createNode('/set-new-protected', 'doc'),
      $acl: [{ g: 'authenticated', p: R | W }],
    });

    const s = withAcl(tree, 'alice', ['u:alice', 'authenticated']);
    await assert.rejects(
      () => s.set({
        ...createNode('/set-new-protected', 'doc'),
        $acl: [{ g: 'authenticated', p: R | W }],
        newComp: { $type: 'restricted', data: 'x' },
      } as NodeData),
      (e: unknown) => e instanceof KernelError && e.code === 'FORBIDDEN',
    );

    const after = await tree.get('/set-new-protected') as NodeData;
    assert.equal(after.newComp, undefined);
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
      (e: unknown) => e instanceof KernelError && e.code === 'FORBIDDEN',
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
      (e: unknown) => e instanceof KernelError && e.code === 'FORBIDDEN',
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
      (e: unknown) => e instanceof KernelError && e.code === 'FORBIDDEN',
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

  // I1: full pipeline composition ($refs step below withAcl) — internal $refs
  // derivation still works after the fix; user patches that touch ref-bearing
  // fields do NOT trip the system-field guard since $refs is derived BELOW
  // withAcl (at set-time inside the storage policy), never in the user's ops.
  it('I1: withAcl → storage-policy pipeline preserves auto-$refs derivation', async () => {
    const inner = createMemoryTree();
    await inner.set({ ...createNode('/', 'root'), $acl: [{ g: 'public', p: R | W | A }] });
    const policied = (await import('#tree/policy')).withStoragePolicy(inner).tree;
    const s = withAcl(policied, 'alice', ['u:alice', 'public']);

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

// gk8.10 stage 2: set-members in patchMany are full-node writes (may CREATE)
// gated at R+W and REWRITTEN through the same ACL rules as set().
describe('withAcl.patchMany — set-members', () => {
  it('set-member without W → FORBIDDEN, nothing written', async () => {
    await tree.set({ ...createNode('/dir', 'dir'), $acl: [{ g: 'authenticated', p: R }] });
    await tree.set(createNode('/dir/n', 'doc', { title: 'orig' }));
    const s = withAcl(tree, 'alice', ['u:alice', 'authenticated']);
    await assert.rejects(
      () => s.patchMany!('/dir', [{ path: '/dir/n', node: createNode('/dir/n', 'doc', { title: 'hacked' }) }]),
      (e: unknown) => e instanceof KernelError && e.code === 'FORBIDDEN',
    );
    assert.equal((await tree.get('/dir/n'))!.title, 'orig');
  });

  it('set-member with W but no R → FORBIDDEN (uniform R+W; plain set stays W-only)', async () => {
    await tree.set({ ...createNode('/dir', 'dir'), $acl: [{ g: 'authenticated', p: W }] });
    const s = withAcl(tree, 'alice', ['u:alice', 'authenticated']);
    // Contrast: plain set() through the same actor is W-only and passes.
    await s.set(createNode('/dir/plain', 'doc', { n: 1 }));
    assert.equal((await tree.get('/dir/plain'))!.n, 1);
    await assert.rejects(
      () => s.patchMany!('/dir', [{ path: '/dir/created', node: createNode('/dir/created', 'doc', { n: 2 }) }]),
      (e: unknown) => e instanceof KernelError && e.code === 'FORBIDDEN',
    );
    assert.equal(await tree.get('/dir/created'), undefined);
  });

  it('R+W user creates via set-member; ops-members in the same batch still apply', async () => {
    await tree.set({ ...createNode('/dir', 'dir'), $acl: [{ g: 'authenticated', p: R | W }] });
    await tree.set(createNode('/dir/a', 'doc', { n: 1 }));
    const s = withAcl(tree, 'alice', ['u:alice', 'authenticated']);
    await s.patchMany!('/dir', [
      { path: '/dir/new', node: createNode('/dir/new', 'doc', { n: 10 }) },
      { path: '/dir/a', ops: [['r', 'n', 2]] },
    ]);
    assert.equal((await tree.get('/dir/new'))!.n, 10);
    assert.equal((await tree.get('/dir/a'))!.n, 2);
  });

  it('set-member with ALTERED $acl by non-A user → FORBIDDEN', async () => {
    await tree.set({ ...createNode('/dir', 'dir'), $acl: [{ g: 'authenticated', p: R | W }] });
    await tree.set({ ...createNode('/dir/n', 'doc', { title: 'orig' }), $acl: [{ g: 'authenticated', p: R | W }] });
    const s = withAcl(tree, 'alice', ['u:alice', 'authenticated']);
    await assert.rejects(
      () => s.patchMany!('/dir', [{
        path: '/dir/n',
        node: { ...createNode('/dir/n', 'doc', { title: 'x' }), $acl: [{ g: 'authenticated', p: R | W | A }] },
      }]),
      (e: unknown) => e instanceof KernelError && e.code === 'FORBIDDEN',
    );
    assert.equal((await tree.get('/dir/n'))!.title, 'orig');
  });

  it('set-member omitting $acl forwards the preserved $acl — rewrite, not pass-through', async () => {
    const raw = createMemoryTree();
    await raw.set({ ...createNode('/', 'root'), $acl: [{ g: 'public', p: R }] });
    await raw.set({ ...createNode('/dir', 'dir'), $acl: [{ g: 'authenticated', p: R | W }] });
    await raw.set({ ...createNode('/dir/n', 'doc', { title: 'orig' }), $acl: [{ g: 'authenticated', p: R | W }] });

    let forwarded: PatchManyEntry[] | undefined;
    const spy: Tree = {
      get: (p, c) => raw.get(p, c),
      getChildren: (p, o, c) => raw.getChildren(p, o, c),
      set: (n, c) => raw.set(n, c),
      remove: (p, c) => raw.remove(p, c),
      patch: (p, o, c) => raw.patch(p, o, c),
      patchMany: (a, e, c) => { forwarded = e; return raw.patchMany!(a, e, c); },
    };

    const s = withAcl(spy, 'alice', ['u:alice', 'authenticated']);
    await s.patchMany!('/dir', [{ path: '/dir/n', node: createNode('/dir/n', 'doc', { title: 'edited' }) }]);

    assert.equal(forwarded?.length, 1);
    const entry = forwarded![0];
    if (!isSetEntry(entry)) assert.fail('expected a set-member to be forwarded');
    assert.deepEqual(entry.node.$acl, [{ g: 'authenticated', p: R | W }]);
    const after = (await raw.get('/dir/n'))!;
    assert.equal(after.title, 'edited');
    assert.deepEqual(after.$acl, [{ g: 'authenticated', p: R | W }]);
  });
});

// F6: /sys ACL must block non-admin writes via inheritance, even when root.json is permissive.
describe('F6 — /sys admin-only writes via ACL inheritance', () => {
  it('non-admin authenticated cannot write under /sys, even with permissive root', async () => {
    const t = createMemoryTree();
    // Permissive root — simulates an operator's root.json
    await t.set({ ...createNode('/', 'root'), $acl: [
      { g: 'admins', p: R | W | A },
      { g: 'authenticated', p: R | W },
      { g: 'public', p: R },
    ]});
    // /sys with restrictive ACL (mirrors the core seed prefab)
    await t.set({ ...createNode('/sys', 't.system'), $acl: [
      { g: 'admins', p: R | W | A | S },
      { g: 'authenticated', p: R },
      { g: 'public', p: R },
    ]});

    const alice = withAcl(t, 'alice', ['u:alice', 'authenticated']);
    await assert.rejects(
      () => alice.set(createNode('/sys/autostart/evil', 'foo')),
      (e: unknown) => e instanceof KernelError && e.code === 'FORBIDDEN',
    );
  });

  it('admin can write under /sys', async () => {
    const t = createMemoryTree();
    await t.set({ ...createNode('/', 'root'), $acl: [{ g: 'admins', p: R | W | A }]});
    await t.set({ ...createNode('/sys', 't.system'), $acl: [
      { g: 'admins', p: R | W | A | S },
      { g: 'authenticated', p: R },
    ]});

    const adm = withAcl(t, 'root', ['u:root', 'authenticated', 'admins']);
    await adm.set(createNode('/sys/autostart/legit', 'foo'));
    assert.ok(await adm.get('/sys/autostart/legit'));
  });
});

// F1: devLogin must require BOTH NODE_ENV=development AND VITE_DEV_LOGIN.
// Single-env-var typo in production must NOT create an admin session.
describe('devLogin — env gate', () => {
  it('throws FORBIDDEN when NODE_ENV is not development, even with VITE_DEV_LOGIN set', async () => {
    await withEnv({ NODE_ENV: 'production', VITE_DEV_LOGIN: '1' }, async () => {
      await assert.rejects(
        () => devLogin(tree),
        (e: unknown) => e instanceof KernelError && e.code === 'FORBIDDEN',
      );
    });
  });

  it('throws FORBIDDEN when VITE_DEV_LOGIN is unset, even in development', async () => {
    await withEnv({ NODE_ENV: 'development', VITE_DEV_LOGIN: undefined }, async () => {
      await assert.rejects(
        () => devLogin(tree),
        (e: unknown) => e instanceof KernelError && e.code === 'FORBIDDEN',
      );
    });
  });

  it('succeeds with both NODE_ENV=development AND VITE_DEV_LOGIN set', async () => {
    await withEnv({ NODE_ENV: 'development', VITE_DEV_LOGIN: '1' }, async () => {
      const result = await devLogin(tree);
      assert.equal(result.userId, 'dev');
      assert.equal(typeof result.token, 'string');
      assert.equal(result.token.length, 64);
    });
  });
});
