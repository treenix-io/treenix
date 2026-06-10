import { A, makeNode, R, register, S, W, type NodeData } from '@treenx/core';
import { registerType } from '@treenx/core/comp';
import { OpError } from '@treenx/core/errors';
import { withMounts } from '@treenx/core/mount';
import { loadSchemasFromDir } from '@treenx/core/schema/load';
import { executeAction } from '@treenx/core/server/actions';
import { createMemoryTree, type Tree } from '@treenx/core/tree';
import { BRANCH_DELTA_TYPE, BRANCH_WHITEOUT_TYPE } from '@treenx/core/tree/branch';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DiffEntry } from './types';
import './seed';
import './types';

// Action args are schema-validated fail-closed — load the generated schemas
// the way the mod loader does at boot.
loadSchemasFromDir(new URL('./schemas', import.meta.url).pathname);

const isCode = (code: string) => (e: unknown) => e instanceof OpError && e.code === code;

const OWNER = 'u-build';
const ACTOR = { userId: OWNER, claims: [`u:${OWNER}`, 'agents', 'authenticated'] };

class BranchTestDoc {
  title = '';
  count = 0;
  bump() { this.count++; }
}
registerType('branchtest.doc', BranchTestDoc);
register('branchtest.doc', 'schema', () => ({
  $id: 'branchtest.doc',
  type: 'object',
  properties: { title: { type: 'string' }, count: { type: 'integer' } },
  methods: { bump: { arguments: [] } },
}));

type Env = { root: Tree; tree: Tree; branchPath: string; view: string };

async function setup(): Promise<Env> {
  const root = createMemoryTree();
  const tree = withMounts(root);

  const rootNode = makeNode('/', 'root');
  rootNode.$acl = [
    { g: 'system', p: R | W | A | S },
    { g: 'admins', p: R | W | A | S },
    { g: 'agents', p: R | S },
    { g: 'authenticated', p: R | S },
  ];
  await tree.set(rootNode);

  await tree.set(makeNode(`/auth/users/${OWNER}`, 'user', undefined, {
    groups: { $type: 'groups', list: ['agents'] },
  }));

  await tree.set(makeNode('/company', 'dir'));
  await tree.set(makeNode('/company/doc', 'branchtest.doc', { title: 'live', count: 1 }));
  await tree.set(makeNode('/company/other', 'branchtest.doc', { title: 'other', count: 0 }));

  const secrets = makeNode('/secrets', 'dir');
  secrets.$acl = [
    { g: 'admins', p: R | W | A | S },
    { g: 'agents', p: 0 },
    { g: 'authenticated', p: 0 },
    { g: 'public', p: 0 },
  ];
  await tree.set(secrets);
  await tree.set(makeNode('/secrets/hidden', 'dir', { value: 'top' }));

  const branches = makeNode('/branches', 't.branches');
  branches.$acl = [
    { g: 'admins', p: R | W | A | S },
    { g: 'agents', p: R | W | A | S },
  ];
  await tree.set(branches);

  const res = await executeAction<{ path: string }>(
    tree, '/branches', undefined, undefined, 'create', { title: 'test branch' }, ACTOR,
  );
  return { root, tree, branchPath: res.path, view: `${res.path}/tree` };
}

describe('branch mod: create + mounted view', () => {
  it('create stamps owner, ACL, delta dir and mounted tree node', async () => {
    const { tree, branchPath } = await setup();

    const branch = await tree.get(branchPath);
    assert.equal(branch?.$type, 't.branch');
    assert.equal(branch?.owner, OWNER);
    assert.equal(branch?.status, 'open');
    assert.ok(branch?.$acl?.some(a => a.g === `u:${OWNER}` && a.p === (R | W | A | S)));

    assert.equal((await tree.get(`${branchPath}/delta`))?.$type, 't.dir');
    const mountNode = await tree.get(`${branchPath}/tree`);
    assert.equal((mountNode?.mount as { $type?: string } | undefined)?.$type, 't.mount.branch');
  });

  it('create without session user and without explicit owner fails loud', async () => {
    const { tree } = await setup();
    await assert.rejects(
      executeAction(tree, '/branches', undefined, undefined, 'create', {}),
      isCode('BAD_REQUEST'),
    );
  });

  it('view falls through to live for untouched paths', async () => {
    const { tree, view } = await setup();
    const doc = await tree.get(`${view}/company/doc`);
    assert.equal(doc?.title, 'live');
    assert.equal(doc?.count, 1);
  });

  it('writes through the view are isolated: live untouched, delta captured', async () => {
    const { root, tree, branchPath, view } = await setup();

    await tree.set(makeNode(`${view}/company/doc`, 'branchtest.doc', { title: 'branched', count: 5 }));

    assert.equal((await tree.get(`${view}/company/doc`))?.title, 'branched');
    assert.equal((await root.get('/company/doc'))?.title, 'live');

    const wrapper = await root.get(`${branchPath}/delta/company/doc`);
    assert.equal(wrapper?.$type, BRANCH_DELTA_TYPE);
    assert.equal(wrapper?.baseRev, 1);
  });

  it('remove through the view writes a whiteout, live stays', async () => {
    const { root, tree, branchPath, view } = await setup();

    assert.equal(await tree.remove(`${view}/company/doc`), true);
    assert.equal(await tree.get(`${view}/company/doc`), undefined);
    assert.equal((await root.get('/company/doc'))?.title, 'live');
    assert.equal((await root.get(`${branchPath}/delta/company/doc`))?.$type, BRANCH_WHITEOUT_TYPE);
  });

  it('actions execute against the view and land in delta', async () => {
    const { root, tree, view } = await setup();

    await executeAction(tree, `${view}/company/doc`, undefined, undefined, 'bump', undefined, ACTOR);

    assert.equal((await tree.get(`${view}/company/doc`))?.count, 2);
    assert.equal((await root.get('/company/doc'))?.count, 1);
  });

  it('owner projection: live paths denied to the owner stay denied through the view', async () => {
    const { tree, view } = await setup();

    await assert.rejects(tree.get(`${view}/secrets/hidden`), isCode('FORBIDDEN'));

    const { items } = await tree.getChildren(view);
    assert.ok(!items.some(n => n.$path.endsWith('/secrets')));
  });

  it('recursion guard: /branches does not exist inside the view', async () => {
    const { tree, view } = await setup();

    await assert.rejects(tree.get(`${view}/branches`), isCode('FORBIDDEN'));

    const { items } = await tree.getChildren(view);
    assert.ok(!items.some(n => n.$path.endsWith('/branches')));
    assert.ok(items.some(n => n.$path.endsWith('/company')));
  });

  it('scanChildren streams the merged view', async () => {
    const { tree, view } = await setup();
    await tree.set(makeNode(`${view}/company/added`, 'branchtest.doc', { title: 'new', count: 0 }));

    const paths: string[] = [];
    for await (const e of tree.scanChildren!(`${view}/company`, { depth: -1 })) {
      paths.push(e.node.$path);
    }
    assert.deepEqual(paths, [
      `${view}/company/added`,
      `${view}/company/doc`,
      `${view}/company/other`,
    ]);
  });
});

describe('branch mod: diff + abandon', () => {
  it('diff reports create/set/remove/noop with live paths and baseRev', async () => {
    const { tree, branchPath, view } = await setup();

    await tree.set(makeNode(`${view}/company/doc`, 'branchtest.doc', { title: 'changed', count: 9 }));
    await tree.remove(`${view}/company/other`);
    await tree.set(makeNode(`${view}/fresh`, 'branchtest.doc', { title: 'fresh', count: 0 }));
    await tree.set(makeNode(`${view}/tmp`, 'branchtest.doc', { title: 'gone', count: 0 }));
    await tree.remove(`${view}/tmp`);

    const { entries } = await executeAction<{ entries: DiffEntry[] }>(
      tree, branchPath, undefined, undefined, 'diff', undefined, ACTOR,
    );
    const byPath = new Map(entries.map(e => [e.path, e]));

    assert.equal(entries.length, 4);
    assert.deepEqual(
      byPath.get('/company/doc'),
      { path: '/company/doc', op: 'set', baseRev: 1, node: byPath.get('/company/doc')?.node },
    );
    assert.equal(byPath.get('/company/doc')?.node?.title, 'changed');
    assert.equal(byPath.get('/company/other')?.op, 'remove');
    assert.equal(byPath.get('/company/other')?.baseRev, 1);
    assert.equal(byPath.get('/fresh')?.op, 'create');
    assert.equal(byPath.get('/fresh')?.baseRev, null);
    assert.equal(byPath.get('/tmp')?.op, 'noop');
  });

  it('diff of an untouched branch is empty', async () => {
    const { tree, branchPath } = await setup();
    const { entries } = await executeAction<{ entries: DiffEntry[] }>(
      tree, branchPath, undefined, undefined, 'diff', undefined, ACTOR,
    );
    assert.deepEqual(entries, []);
  });

  it('abandon flips status and keeps the delta', async () => {
    const { root, tree, branchPath, view } = await setup();
    await tree.set(makeNode(`${view}/company/doc`, 'branchtest.doc', { title: 'wip', count: 2 }));

    await executeAction(tree, branchPath, undefined, undefined, 'abandon', undefined, ACTOR);

    assert.equal((await tree.get(branchPath))?.status, 'abandoned');
    assert.equal((await root.get(`${branchPath}/delta/company/doc`))?.$type, BRANCH_DELTA_TYPE);
  });
});
