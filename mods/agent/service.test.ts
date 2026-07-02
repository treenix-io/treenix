// Orchestrator branch-placement helpers (core-wm6.4). The runAgent wiring
// itself needs a live SDK run; these cover the pure seams it composes.

import { A, createNode, makeNode, R, S, W } from '@treenx/core';
import { withMounts } from '@treenx/core/mount';
import { loadSchemasFromDir } from '@treenx/core/schema/load';
import { executeAction } from '@treenx/core/server/actions';
import { createMemoryTree, type Tree } from '@treenx/core/tree';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import '#branch/service'; // pulls types + the t.mount.branch adapter
import { branchPromptSection, settleBranchAfterRun } from './service';

loadSchemasFromDir(new URL('../branch/schemas', import.meta.url).pathname);

const OWNER = 'agent-workload:r-test';

async function setup(): Promise<{ tree: Tree; branchPath: string; view: string }> {
  const root = createMemoryTree();
  const tree = withMounts(root);
  const rootNode = createNode('/', 'root');
  rootNode.$acl = [{ g: 'admins', p: R | W | A | S }, { g: 'authenticated', p: R | S }];
  await tree.set(rootNode);
  await tree.set(createNode('/branches', 't.branches'));
  await tree.set(createNode('/company', 'dir'));
  await tree.set(createNode('/company/doc', 'doc', { title: 'live' }));

  const { path } = await executeAction<{ path: string }>(
    tree, '/branches', undefined, undefined, 'create', { title: 'run branch', owner: OWNER },
  );
  return { tree, branchPath: path, view: `${path}/tree` };
}

describe('branchPromptSection', () => {
  it('explains the placement and embeds the /branches description', () => {
    const section = branchPromptSection('WORKFLOW TEXT');
    assert.ok(section.includes('/.branch'));
    assert.ok(section.includes("requestMerge"));
    assert.ok(section.includes('WORKFLOW TEXT'));
  });

  it('omits the description block when empty', () => {
    const section = branchPromptSection('');
    assert.ok(section.includes('/.branch'));
    assert.ok(!section.includes('undefined'));
  });
});

describe('settleBranchAfterRun', () => {
  it('abandons an untouched branch', async () => {
    const { tree, branchPath } = await setup();
    const note = await settleBranchAfterRun(tree, branchPath);
    assert.ok(note.includes('abandoned'));
    assert.equal((await tree.get(branchPath))?.status, 'abandoned');
  });

  it('keeps unrequested changes open and reports them loudly', async () => {
    const { tree, branchPath, view } = await setup();
    await tree.set(makeNode(`${view}/company/doc`, 'doc', { title: 'changed' }));

    const note = await settleBranchAfterRun(tree, branchPath);
    assert.ok(note.includes('NOT submitted'));
    assert.equal((await tree.get(branchPath))?.status, 'open');
  });

  it('reports a requested merge as pending review', async () => {
    const { tree, branchPath, view } = await setup();
    await tree.set(makeNode(`${view}/company/doc`, 'doc', { title: 'changed' }));
    await executeAction(tree, branchPath, undefined, undefined, 'requestMerge', undefined);

    const note = await settleBranchAfterRun(tree, branchPath);
    assert.ok(note.includes('/guardian/approvals'));
    assert.equal((await tree.get(branchPath))?.status, 'review');
  });
});
