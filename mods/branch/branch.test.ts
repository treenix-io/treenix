import { A, getComponentByName, isRef, makeNode, R, register, S, W, type NodeData } from '@treenx/core';
import { registerType } from '@treenx/core/comp';
import { OpError } from '@treenx/core/errors';
import { withMounts } from '@treenx/core/mount';
import { loadSchemasFromDir } from '@treenx/core/schema/load';
import { executeAction } from '@treenx/core/server/actions';
import { createMemoryTree, type Tree } from '@treenx/core/tree';
import { BRANCH_DELTA_TYPE, BRANCH_WHITEOUT_TYPE } from '@treenx/core/tree/branch';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fileMergeApprovals } from './approvals';
import type { DiffEntry } from './types';
import './seed';
import './service'; // types + the t.mount.branch adapter (server split)

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
    assert.equal(getComponentByName(mountNode!, 'mount')?.$type, 't.mount.branch');
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

type MergeResult = { merged: number; applied: string[]; conflicts: { path: string; expectedRev: number | null; actualRev: number | null }[] };

describe('branch mod: requestMerge + merge', () => {
  it('requestMerge flips status only; the approval is filed by the watcher', async () => {
    const { tree, branchPath } = await setup();

    await executeAction(tree, branchPath, undefined, undefined, 'requestMerge', { note: 'please review' }, ACTOR);

    assert.equal((await tree.get(branchPath))?.status, 'review');
    const before = await tree.getChildren('/guardian/approvals');
    assert.equal(before.items.length, 0, 'requestMerge itself writes no approval node');

    await assert.rejects(
      executeAction(tree, branchPath, undefined, undefined, 'requestMerge', undefined, ACTOR),
      isCode('CONFLICT'),
    );

    // The orchestrator watcher projects status=review into the inbox — once.
    assert.equal(await fileMergeApprovals(tree), 1);
    assert.equal(await fileMergeApprovals(tree), 0);
    const { items } = await tree.getChildren('/guardian/approvals');
    assert.equal(items.length, 1);
    assert.equal(items[0].$type, 'ai.approval');
    assert.equal(items[0].branchRef, branchPath);
    assert.equal(items[0].status, 'pending');
    assert.equal(items[0].tool, 'branch.merge');
  });

  it('watcher settles the card after the branch resolves: merged → approved, abandoned → denied', async () => {
    const a = await setup();
    await executeAction(a.tree, a.branchPath, undefined, undefined, 'requestMerge', undefined, ACTOR);
    await fileMergeApprovals(a.tree);
    await executeAction(a.tree, a.branchPath, undefined, undefined, 'merge', undefined, ACTOR);
    await fileMergeApprovals(a.tree);
    const merged = (await a.tree.getChildren('/guardian/approvals')).items;
    assert.equal(merged.length, 1);
    assert.equal(merged[0].status, 'approved');

    const b = await setup();
    await executeAction(b.tree, b.branchPath, undefined, undefined, 'requestMerge', undefined, ACTOR);
    await fileMergeApprovals(b.tree);
    await executeAction(b.tree, b.branchPath, undefined, undefined, 'abandon', undefined, ACTOR);
    await fileMergeApprovals(b.tree);
    const abandoned = (await b.tree.getChildren('/guardian/approvals')).items;
    assert.equal(abandoned[0].status, 'denied');
  });

  it('/.branch control window: read, list, act on the REAL branch from inside the view', async () => {
    const { root, tree, branchPath, view } = await setup();
    const self = `${view}/.branch`;

    const ctl = await tree.get(self);
    assert.equal(ctl?.$type, 't.branch');
    assert.equal(ctl?.status, 'open');
    assert.equal(ctl?.owner, OWNER);

    const { items } = await tree.getChildren(view);
    assert.ok(items.some(n => n.$path === self), '/.branch listed in the view root');

    // diff through the window sees the branch's own delta
    await tree.set(makeNode(`${view}/company/doc`, 'branchtest.doc', { title: 'wip', count: 3 }));
    const { entries } = await executeAction<{ entries: DiffEntry[] }>(
      tree, self, undefined, undefined, 'diff', undefined, ACTOR,
    );
    assert.equal(entries.length, 1);
    assert.equal(entries[0].path, '/company/doc');

    // requestMerge through the window flips the REAL node, not a delta copy
    await executeAction(tree, self, undefined, undefined, 'requestMerge', undefined, ACTOR);
    assert.equal((await root.get(branchPath))?.status, 'review');
    assert.equal(await root.get(`${branchPath}/delta${branchPath}`), undefined, 'no delta copy of the branch node');

    await assert.rejects(tree.remove(self), isCode('FORBIDDEN'));
  });

  it('clean merge applies create/set in one atomic batch, skips noop, journals revs via OCC', async () => {
    const { root, tree, branchPath, view } = await setup();

    await tree.set(makeNode(`${view}/company/doc`, 'branchtest.doc', { title: 'merged-title', count: 7 }));
    await tree.set(makeNode(`${view}/fresh`, 'branchtest.doc', { title: 'born', count: 0 }));
    await tree.set(makeNode(`${view}/tmp`, 'branchtest.doc', { title: 'gone', count: 0 }));
    await tree.remove(`${view}/tmp`);

    await executeAction(tree, branchPath, undefined, undefined, 'requestMerge', undefined, ACTOR);
    const res = await executeAction<MergeResult>(
      tree, branchPath, undefined, undefined, 'merge', undefined, ACTOR,
    );

    assert.equal(res.conflicts.length, 0);
    assert.equal(res.merged, 2);
    assert.deepEqual([...res.applied].sort(), ['/company/doc', '/fresh']);

    const doc = await root.get('/company/doc');
    assert.equal(doc?.title, 'merged-title');
    assert.equal(doc?.$rev, 2); // OCC: set with $rev=1 bumped to 2
    assert.equal((await root.get('/fresh'))?.title, 'born');
    assert.equal(await root.get('/tmp'), undefined);

    const branch = await tree.get(branchPath);
    assert.equal(branch?.status, 'merged');
    assert.ok(typeof branch?.mergedAt === 'number' && branch.mergedAt > 0);
  });

  // core-anz4.6: PatchManyEntry has no remove member — a remove applied outside
  // the batch would reopen the partial-merge hole, so merge refuses whole.
  it('merge with a remove entry is refused loudly before any write', async () => {
    const { root, tree, branchPath, view } = await setup();

    await tree.set(makeNode(`${view}/company/doc`, 'branchtest.doc', { title: 'kept-edit', count: 2 }));
    await tree.remove(`${view}/company/other`);

    await assert.rejects(
      executeAction(tree, branchPath, undefined, undefined, 'merge', undefined, ACTOR),
      isCode('BAD_REQUEST'),
    );

    assert.equal((await root.get('/company/doc'))?.title, 'live', 'set entry not applied');
    assert.equal((await root.get('/company/other'))?.title, 'other', 'remove entry not applied');
    assert.equal((await tree.get(branchPath))?.status, 'open', 'no status flip on refusal');
    assert.equal((await root.get(`${branchPath}/delta/company/other`))?.$type, BRANCH_WHITEOUT_TYPE, 'delta intact');
  });

  it('preflight conflict: live drift reports all conflicts, applies NOTHING', async () => {
    const { root, tree, branchPath, view } = await setup();

    await tree.set(makeNode(`${view}/company/doc`, 'branchtest.doc', { title: 'branch-edit', count: 2 }));
    await tree.set(makeNode(`${view}/fresh`, 'branchtest.doc', { title: 'branch-born', count: 0 }));

    // Live drifts after the branch captured baseRevs.
    const live = await root.get('/company/doc');
    await root.set({ ...live!, title: 'live-raced' });
    await root.set(makeNode('/fresh', 'branchtest.doc', { title: 'live-born-first', count: 0 }));

    const res = await executeAction<MergeResult>(
      tree, branchPath, undefined, undefined, 'merge', undefined, ACTOR,
    );

    assert.equal(res.merged, 0);
    assert.deepEqual(res.applied, []);
    assert.equal(res.conflicts.length, 2);
    const byPath = new Map(res.conflicts.map(c => [c.path, c]));
    assert.deepEqual(byPath.get('/company/doc'), { path: '/company/doc', expectedRev: 1, actualRev: 2 });
    assert.deepEqual(byPath.get('/fresh'), { path: '/fresh', expectedRev: null, actualRev: 1 });

    assert.equal((await root.get('/company/doc'))?.title, 'live-raced');
    const branch = await tree.get(branchPath);
    assert.equal(branch?.status, 'conflict');
    assert.equal((branch?.conflicts as unknown[])?.length, 2);
  });

  // core-anz4.6 regression: a writer slipping in between preflight and apply
  // (stale $rev on the SECOND member) must deny the WHOLE batch — the old
  // sequential apply left the first member live.
  it('mid-batch OCC slip: nothing applied, branch intact, conflict surfaced', async () => {
    const { root, tree, branchPath, view } = await setup();

    await tree.set(makeNode(`${view}/company/doc`, 'branchtest.doc', { title: 'first', count: 1 }));
    await tree.set(makeNode(`${view}/company/other`, 'branchtest.doc', { title: 'second', count: 2 }));

    // Sabotage: an out-of-band writer bumps the second target after preflight,
    // right before the batch commits — OCC staging must deny the whole batch.
    const sabotaged: Tree = {
      ...tree,
      async patchMany(ancestor, entries, ctx) {
        const other = await root.get('/company/other');
        await root.set({ ...other!, title: 'raced' });
        return tree.patchMany!(ancestor, entries, ctx);
      },
    };

    const res = await executeAction<MergeResult>(
      sabotaged, branchPath, undefined, undefined, 'merge', undefined, ACTOR,
    );

    assert.equal(res.merged, 0);
    assert.deepEqual(res.applied, []);
    assert.deepEqual(res.conflicts, [{ path: '/company/other', expectedRev: 1, actualRev: 2 }]);

    assert.equal((await root.get('/company/doc'))?.title, 'live', 'first member NOT applied');
    assert.equal((await root.get('/company/other'))?.title, 'raced');
    assert.equal((await tree.get(branchPath))?.status, 'conflict');

    // Delta untouched — the branch can be re-merged after the conflict clears.
    assert.equal((await root.get(`${branchPath}/delta/company/doc`))?.$type, BRANCH_DELTA_TYPE);
  });

  // core-anz4.22: refs written through the view carry view coordinates —
  // merge must relocate them to the base namespace or they dangle after the
  // branch mount is gone. Refs pointing outside the view stay untouched.
  it('merged nodes carry refs rewritten to base namespace; outside refs untouched', async () => {
    const { root, tree, branchPath, view } = await setup();

    const linked = makeNode(`${view}/company/linked`, 'branchtest.doc', { title: 'linked', count: 0 });
    linked.inside = { $type: 'ref', $ref: `${view}/company/doc`, $refId: 'id-doc' };
    linked.outside = { $type: 'ref', $ref: '/company/other' };
    linked.$refs = [{ t: `${view}/company/doc` }];
    await tree.set(linked);

    const { entries } = await executeAction<{ entries: DiffEntry[] }>(
      tree, branchPath, undefined, undefined, 'diff', undefined, ACTOR,
    );
    assert.equal(entries.length, 1);
    const diffed = entries[0].node;
    assert.ok(diffed && isRef(diffed.inside) && isRef(diffed.outside));
    assert.equal(diffed.inside.$ref, '/company/doc');
    assert.equal(diffed.inside.$refId, 'id-doc', 'identity untouched by the path rewrite');
    assert.equal(diffed.outside.$ref, '/company/other');
    assert.equal(diffed.$refs?.[0]?.t, '/company/doc', 'standalone $refs entry rewritten');

    await executeAction(tree, branchPath, undefined, undefined, 'merge', undefined, ACTOR);
    const live = await root.get('/company/linked');
    assert.ok(live && isRef(live.inside) && isRef(live.outside));
    assert.equal(live.inside.$ref, '/company/doc');
    assert.equal(live.inside.$refId, 'id-doc');
    assert.equal(live.outside.$ref, '/company/other');
  });

  it('merge is refused on merged/abandoned branches', async () => {
    const { tree, branchPath } = await setup();
    await executeAction(tree, branchPath, undefined, undefined, 'abandon', undefined, ACTOR);
    await assert.rejects(
      executeAction(tree, branchPath, undefined, undefined, 'merge', undefined, ACTOR),
      isCode('CONFLICT'),
    );
  });
});
