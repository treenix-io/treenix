// executeWithCapability — entry helper that wraps executeAction for workload identities.
// Two checks before delegating: allowedExec (action whitelist) + writePaths (target path).
// Tree handed to action is wrapped via withCapability so internal writes stay in scope.

import { createMemoryTree, type Tree } from '@treenx/core/tree';
import { withAcl } from '@treenx/core/server/auth';
import { OpError } from '@treenx/core/errors';
import { register, R, W } from '@treenx/core';
import { clearRegistry } from '@treenx/core/core/index.test';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { executeWithCapability, type Capability } from './capability';
import type { ActionCtx } from '@treenx/core/server/actions';

const cap: Capability = {
  readPaths: ['/work', '/work/*'],
  writePaths: ['/work/*'],
  allowedExec: ['allowed'],
};

const aclWrap = (tree: Tree) => withAcl(tree, 'workload', ['agent']);

beforeEach(() => clearRegistry());

async function makeTree(): Promise<Tree> {
  const tree = createMemoryTree();
  await tree.set({ $path: '/', $type: 'root', $acl: [{ g: 'agent', p: R | W }] });
  await tree.set({ $path: '/work', $type: 'dir' });
  await tree.set({ $path: '/work/n', $type: 'thing', value: 0 });
  return tree;
}

function registerThing() {
  register('thing', 'schema', () => ({
    $id: 'thing', title: 'T', type: 'object' as const, properties: {},
    methods: {
      allowed: { arguments: [] },
      forbidden: { arguments: [] },
      escape: { arguments: [] },
    },
  }));
}

describe('executeWithCapability — exec whitelist', () => {
  it('allows action listed in allowedExec', async () => {
    registerThing();
    let captured: unknown = null;
    register('thing', 'action:allowed', (ctx: ActionCtx) => { captured = ctx.actor; });

    const tree = await makeTree();
    await executeWithCapability(aclWrap(tree), cap,
      { path: '/work/n', action: 'allowed' },
      { id: 'agent-workload:r-1', taskPath: '/board/tasks/1' },
    );

    assert.deepEqual(captured, { id: 'agent-workload:r-1', taskPath: '/board/tasks/1' });
  });

  it('denies action not in allowedExec', async () => {
    registerThing();
    register('thing', 'action:forbidden', () => {});

    const tree = await makeTree();
    await assert.rejects(
      executeWithCapability(aclWrap(tree), cap,
        { path: '/work/n', action: 'forbidden' },
        { id: 'agent-workload:r-1' },
      ),
      (e: any) => e instanceof OpError && e.code === 'FORBIDDEN',
    );
  });

  it('denies action even if writePaths matches but action not whitelisted', async () => {
    registerThing();
    register('thing', 'action:forbidden', () => {});
    const tree = await makeTree();
    await assert.rejects(
      executeWithCapability(aclWrap(tree), cap,
        { path: '/work/n', action: 'forbidden' },
        { id: 'agent-workload:r-1' },
      ),
      (e: any) => e instanceof OpError && e.code === 'FORBIDDEN',
    );
  });
});

describe('executeWithCapability — internal tree wrap', () => {
  it('action handler that writes outside writePaths fails (confused-deputy guard)', async () => {
    registerThing();
    // Action writes to /escape outside /work/* — must be denied via wrapped ctx.tree
    register('thing', 'action:escape', async (ctx: ActionCtx) => {
      await ctx.tree.set({ $path: '/escape', $type: 'leaf', value: 'pwn' });
    });
    // allowedExec includes 'escape' to prove path-scope (not exec-scope) denies
    const escapeCap: Capability = { ...cap, allowedExec: ['escape'] };

    const tree = await makeTree();
    await assert.rejects(
      executeWithCapability(aclWrap(tree), escapeCap,
        { path: '/work/n', action: 'escape' },
        { id: 'agent-workload:r-1' },
      ),
      (e: any) => e instanceof OpError && e.code === 'FORBIDDEN',
    );
    // Verify nothing actually written
    const escaped = await tree.get('/escape');
    assert.equal(escaped, undefined);
  });
});

describe('executeWithCapability — input validation', () => {
  it('denies write to path outside writePaths (target path check)', async () => {
    registerThing();
    register('thing', 'action:allowed', () => {});
    const tree = await makeTree();
    await tree.set({ $path: '/other', $type: 'thing' });
    await assert.rejects(
      executeWithCapability(aclWrap(tree), cap,
        { path: '/other', action: 'allowed' },
        { id: 'agent-workload:r-1' },
      ),
      (e: any) => e instanceof OpError && e.code === 'FORBIDDEN',
    );
  });
});
