// executeWithCapability — entry helper that wraps executeAction for workload identities.
// Two checks before delegating: allowedExec (action whitelist) + writePaths (target path).
// Tree handed to action is wrapped via withCapability so internal writes stay in scope.

import { createMemoryTree, type Tree } from '@treenx/core/tree';
import { withAcl } from '@treenx/core/security';
import { KernelError } from '@treenx/core/errors';
import { createNode, register, R, W } from '@treenx/core';
import { clearRegistry } from '@treenx/core/testing';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, it } from 'node:test';
import { executeWithCapability, type Capability, withCapability } from './capability';
import { type ActionCtx, executeAction, withExecute } from '@treenx/core/server/actions';

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
  it('a nested ordinary action cannot use ACL write rights outside the capability', async () => {
    registerThing();
    let effects = 0;
    register('thing', 'action:allowed', () => ++effects);
    const tree = withCapability(aclWrap(await makeTree()), { ...cap, writePaths: [] });

    await assert.rejects(
      executeAction(tree, '/work/n', undefined, undefined, 'allowed'),
      (error: unknown) => error instanceof KernelError && error.code === 'FORBIDDEN',
    );
    assert.equal(effects, 0);
  });

  it('an allowed capability cannot grant an ordinary action to an ACL reader', async () => {
    registerThing();
    let effects = 0;
    register('thing', 'action:allowed', () => ++effects);
    const raw = await makeTree();
    await raw.set({ $path: '/', $type: 'root', $acl: [{ g: 'agent', p: R }] });

    await assert.rejects(
      executeWithCapability(aclWrap(raw), cap, { path: '/work/n', action: 'allowed' }, { id: 'workload' }),
      (error: unknown) => error instanceof KernelError && error.code === 'FORBIDDEN',
    );
    assert.equal(effects, 0);
  });

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
      (e: any) => e instanceof KernelError && e.code === 'FORBIDDEN',
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
      (e: any) => e instanceof KernelError && e.code === 'FORBIDDEN',
    );
  });
});

describe('executeWithCapability — internal tree wrap', () => {
  it('a narrower capability cannot replay an outcome collected outside its read scope', async () => {
    registerThing();
    const raw = await makeTree();
    await raw.set(createNode('/private', 'dir', { value: 'sensitive-outside-narrow-scope' }));
    let attempts = 0;
    register('thing', 'action:allowed', async (ctx: ActionCtx) => {
      attempts++;
      return (await ctx.tree.get('/private'))?.value;
    });
    const full: Capability = { ...cap, readPaths: ['/**'] };
    const input = { path: '/work/n', action: 'allowed', opId: randomUUID() };
    const actor = { id: 'workload' };
    assert.equal(await executeWithCapability(aclWrap(raw), full, input, actor), 'sensitive-outside-narrow-scope');
    await assert.rejects(() => executeWithCapability(aclWrap(raw), cap, { ...input, opId: undefined }, actor),
      (error: unknown) => error instanceof KernelError && error.code === 'FORBIDDEN');
    await assert.rejects(() => executeWithCapability(aclWrap(raw), cap, input, actor),
      (error: unknown) => error instanceof KernelError && error.code === 'INVALID');
    assert.equal(attempts, 2);
  });

  it('equivalent fresh ACL and capability wrappers share the original execution', async () => {
    registerThing();
    const raw = await makeTree();
    let attempts = 0;
    register('thing', 'action:allowed', () => ++attempts);
    const input = { path: '/work/n', action: 'allowed', opId: randomUUID() };
    const actor = { id: 'workload' };
    const equivalent: Capability = { ...cap, readPaths: [...cap.readPaths].reverse().concat(cap.readPaths) };
    const first = await executeWithCapability(aclWrap(raw), cap, input, actor);
    assert.equal(await executeWithCapability(aclWrap(raw), equivalent, input, actor), first);
    assert.equal(attempts, 1);
  });

  for (const narrowed of ['writePaths', 'allowedExec']) {
    it(`a change to ${narrowed} rejects replay while the original target remains allowed`, async () => {
      registerThing();
      const raw = await makeTree();
      let attempts = 0;
      register('thing', 'action:allowed', () => ++attempts);
      const input = { path: '/work/n', action: 'allowed', opId: randomUUID() };
      const actor = { id: 'workload' };
      const broader: Capability = {
        ...cap,
        writePaths: narrowed === 'writePaths' ? [...cap.writePaths, '/elsewhere/**'] : cap.writePaths,
        allowedExec: narrowed === 'allowedExec' ? [...cap.allowedExec, 'other'] : cap.allowedExec,
      };
      await executeWithCapability(aclWrap(raw), broader, input, actor);
      await assert.rejects(() => executeWithCapability(aclWrap(raw), cap, input, actor),
        (error: unknown) => error instanceof KernelError && error.code === 'INVALID');
      assert.equal(attempts, 1);
    });
  }

  it('a reused capability wrapper reflects a narrowed scope in replay authorization', async () => {
    registerThing();
    const raw = await makeTree();
    await raw.set(createNode('/private', 'dir', { value: 'sensitive' }));
    let attempts = 0;
    register('thing', 'action:allowed', async (ctx: ActionCtx) => {
      attempts++;
      return (await ctx.tree.get('/private'))?.value;
    });
    const mutable: Capability = { ...cap, readPaths: ['/**'] };
    const tree = withCapability(aclWrap(raw), mutable);
    const opts = { userId: 'workload', opId: randomUUID() };
    assert.equal(await executeAction(tree, '/work/n', undefined, undefined, 'allowed', {}, opts), 'sensitive');
    mutable.readPaths = cap.readPaths;
    await assert.rejects(() => executeAction(tree, '/work/n', undefined, undefined, 'allowed', {}, opts),
      (error: unknown) => error instanceof KernelError && error.code === 'INVALID');
    assert.equal(attempts, 1);
  });

  it('an execute wrapper retains current capability scope after narrowing', async () => {
    registerThing();
    const raw = await makeTree();
    await raw.set(createNode('/private', 'dir', { value: 'sensitive' }));
    let attempts = 0;
    register('thing', 'action:allowed', async (ctx: ActionCtx) => {
      attempts++;
      return (await ctx.tree.get('/private'))?.value;
    });
    const mutable: Capability = { ...cap, readPaths: ['/**'] };
    const tree = withExecute(withCapability(aclWrap(raw), mutable), { identity: { userId: 'workload' } });
    const opts = { opId: randomUUID() };
    assert.equal(await tree.execute('/work/n', 'allowed', {}, opts), 'sensitive');
    mutable.readPaths = cap.readPaths;
    await assert.rejects(() => tree.execute('/work/n', 'allowed', {}, opts),
      (error: unknown) => error instanceof KernelError && error.code === 'INVALID');
    assert.equal(attempts, 1);
  });

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
      (e: any) => e instanceof KernelError && e.code === 'FORBIDDEN',
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
      (e: any) => e instanceof KernelError && e.code === 'FORBIDDEN',
    );
  });
});
