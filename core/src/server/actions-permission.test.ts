import { createNode, R, register, resolveExact, W } from '#core';
import { KernelError } from '#errors';
import { withMounts } from '#mount';
import { registerSchemaAction } from '#schema/action';
import { withAcl } from '#security/acl-tree';
import { clearRegistry } from '#testing';
import { createMemoryTree, type Tree } from '#tree';
import { createRepathTree } from '#tree/repath';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { type ActionCtx, executeAction, executeStream, registerBuiltinActions, withExecute } from './actions';

describe('action call permissions', () => {
  beforeEach(() => clearRegistry());

  async function setup(bits: number) {
    const raw = createMemoryTree();
    await raw.set({ ...createNode('/', 'dir'), $acl: [{ g: 'readers', p: bits }] });
    await raw.set(createNode('/action', 'test.call.rights', { value: 0 }));
    register('test.call.rights', 'schema', () => ({
      type: 'object',
      properties: { value: { type: 'number' } },
      methods: {
        ordinary: { arguments: [] },
        peek: { arguments: [], kind: 'read' as const },
        button: { arguments: [], kind: 'setuid' as const },
        stream: { arguments: [], streaming: true },
      },
    }));
    return { raw, tree: withAcl(raw, 'alice', ['readers']) };
  }

  it('a reader cannot run an ordinary action even when it leaves the node unchanged', async () => {
    const { tree } = await setup(R);
    let effects = 0;
    register('test.call.rights', 'action:ordinary', async () => ++effects);

    await assert.rejects(
      () => executeAction(tree, '/action', undefined, undefined, 'ordinary'),
      (error: unknown) => error instanceof KernelError && error.code === 'FORBIDDEN',
    );
    assert.equal(effects, 0);
  });

  it('a reader can run a declared read action', async () => {
    const { tree } = await setup(R);
    register('test.call.rights', 'action:peek', async (ctx: ActionCtx) => ctx.node.value);

    assert.equal(await executeAction(tree, '/action', undefined, undefined, 'peek'), 0);
  });

  it('a reader can inspect a node schema through the built-in action', async () => {
    const { tree } = await setup(R);
    registerBuiltinActions();
    registerSchemaAction();

    assert.deepEqual(await executeAction(tree, '/action', undefined, undefined, '$schema'), {
      type: 'test.call.rights',
      schema: resolveExact('test.call.rights', 'schema')!(),
      components: {},
    });
  });

  it('a rooted tree keeps the caller permission on the original target', async () => {
    const { raw, tree } = await setup(R | W);
    await raw.set({
      ...createNode('/action', 'test.call.rights', { value: 0 }),
      $acl: [{ g: 'readers', p: R }],
    });
    const rooted = createRepathTree(tree, '/view', '/');
    let effects = 0;
    register('test.call.rights', 'action:ordinary', async () => ++effects);

    await assert.rejects(
      () => executeAction(rooted, '/view/action', undefined, undefined, 'ordinary'),
      (error: unknown) => error instanceof KernelError && error.code === 'FORBIDDEN',
    );
    assert.equal(effects, 0);
  });

  it('a reader can call a setuid action while its writes still use the caller ACL', async () => {
    const { raw, tree } = await setup(R);
    let ran = false;
    register('test.call.rights', 'action:button', async (ctx: ActionCtx) => {
      ran = true;
      await ctx.tree.patch('/action', [['r', 'value', 1]]);
    });

    await assert.rejects(
      () => executeAction(tree, '/action', undefined, undefined, 'button'),
      (error: unknown) => error instanceof KernelError && error.code === 'FORBIDDEN',
    );
    assert.equal(ran, true);
    assert.equal((await raw.get('/action'))?.value, 0);
  });

  it('an ordinary action runs with both read and write rights', async () => {
    const { tree } = await setup(R | W);
    register('test.call.rights', 'action:ordinary', async () => 'called');

    assert.equal(await executeAction(tree, '/action', undefined, undefined, 'ordinary'), 'called');
  });

  it('a failed permission check never starts the action handler', async () => {
    const { tree } = await setup(R | W);
    const broken: Tree = {
      ...tree,
      getPerm: async () => { throw new KernelError('FORBIDDEN', 'Permission unavailable'); },
    };
    let effects = 0;
    register('test.call.rights', 'action:ordinary', async () => ++effects);

    await assert.rejects(
      () => executeAction(broken, '/action', undefined, undefined, 'ordinary'),
      (error: unknown) => error instanceof KernelError && error.code === 'FORBIDDEN',
    );
    assert.equal(effects, 0);
  });

  it('a cached visible target does not authorize a call after read permission is revoked', async () => {
    const { tree } = await setup(R | W);
    const revoked: Tree = { ...tree, getPerm: async () => W };
    let effects = 0;
    register('test.call.rights', 'action:ordinary', async () => ++effects);

    await assert.rejects(
      () => executeAction(revoked, '/action', undefined, undefined, 'ordinary'),
      (error: unknown) => error instanceof KernelError && error.code === 'NOT_FOUND',
    );
    assert.equal(effects, 0);
  });

  it('a nested action cannot discard the caller permission provider', async () => {
    const { raw, tree } = await setup(R | W);
    let effects = 0;
    register('test.call.rights', 'action:ordinary', async () =>
      executeAction(raw, '/action', undefined, undefined, 'button'));
    register('test.call.rights', 'action:button', async () => ++effects);

    await assert.rejects(
      () => executeAction(tree, '/action', undefined, undefined, 'ordinary'),
      (error: unknown) => error instanceof KernelError && error.code === 'FORBIDDEN',
    );
    assert.equal(effects, 0);
  });

  it('write without read hides the action target', async () => {
    const { tree } = await setup(W);
    let ran = false;
    register('test.call.rights', 'action:ordinary', async () => { ran = true; });

    await assert.rejects(
      () => executeAction(tree, '/action', undefined, undefined, 'ordinary'),
      (error: unknown) => error instanceof KernelError && error.code === 'NOT_FOUND',
    );
    assert.equal(ran, false);
  });

  it('a reader cannot start an ordinary action stream', async () => {
    const { tree } = await setup(R);
    let ran = false;
    register('test.call.rights', 'action:stream', async function* () {
      ran = true;
      yield 'chunk';
    });

    const stream = executeStream(tree, '/action', undefined, undefined, 'stream');
    await assert.rejects(
      () => stream.next(),
      (error: unknown) => error instanceof KernelError && error.code === 'FORBIDDEN',
    );
    assert.equal(ran, false);
  });

  it('a reader cannot delegate an action or emit its audit intent', async () => {
    const { tree: inner } = await setup(R);
    let calls = 0;
    let intents = 0;
    const remote: Tree = { ...createMemoryTree(), execute: async () => ++calls };
    const tree = withExecute(inner, {
      delegate: async (path) => ({ tree: remote, mountPath: path }),
      onDelegating: () => { intents++; },
    });

    await assert.rejects(
      () => tree.execute('/action', 'remote'),
      (error: unknown) => error instanceof KernelError && error.code === 'FORBIDDEN',
    );
    assert.equal(calls, 0);
    assert.equal(intents, 0);
  });

  it('a writer can delegate an action', async () => {
    const { tree: inner } = await setup(R | W);
    const remote: Tree = { ...createMemoryTree(), execute: async () => 'remote answer' };
    const tree = withExecute(inner, { delegate: async (path) => ({ tree: remote, mountPath: path }) });

    assert.equal(await tree.execute('/action', 'remote'), 'remote answer');
  });

  async function mounted(bits: number, foreignBits: number) {
    const raw = createMemoryTree();
    await raw.set(createNode('/', 'dir'));
    await raw.set({
      ...createNode('/fed', 'dir', {}, { mount: { $type: 'test.call.mount' } }),
      $acl: [{ g: 'readers', p: bits }],
    });
    const remote = createMemoryTree();
    await remote.set({
      ...createNode('/fed/action', 'dir'),
      $acl: [{ g: 'readers', p: foreignBits }],
    });
    let effects = 0;
    let intents = 0;
    register('test.call.mount', 'mount', () => ({
      ...remote,
      execute: async () => ++effects,
    }));
    const mounts = withMounts(raw);
    const tree = withExecute(withAcl(mounts, 'alice', ['readers']), {
      delegate: (path) => mounts.resolveActionTarget(path),
      onDelegating: () => { intents++; },
    });
    return { tree, remote, effects: () => effects, intents: () => intents };
  }

  it('foreign ACL cannot grant a reader write access to the local mount', async () => {
    const { tree, effects, intents } = await mounted(R, R | W);

    await assert.rejects(
      () => tree.execute('/fed/action', 'remote'),
      (error: unknown) => error instanceof KernelError && error.code === 'FORBIDDEN',
    );
    assert.equal(effects(), 0);
    assert.equal(intents(), 0);
  });

  it('foreign ACL cannot revoke local authority to delegate through a writable mount', async () => {
    const { tree, effects } = await mounted(R | W, 0);

    assert.equal(await tree.execute('/fed/action', 'remote'), 1);
    assert.equal(effects(), 1);
  });

  it('a writable mount delegates without reading whether the remote target exists', async () => {
    const { tree, remote, effects } = await mounted(R | W, R | W);
    await remote.remove('/fed/action');

    assert.equal(await tree.execute('/fed/action', 'remote'), 1);
    assert.equal(effects(), 1);
  });

  for (const streaming of [false, true]) {
    it(`read actions reject external effects before entering the ${streaming ? 'stream' : 'handler'}`, async () => {
      const { tree } = await setup(R);
      let effects = 0;
      register('test.call.rights', 'action:peek', streaming
        ? async function* () { effects++; yield 'leaked'; }
        : async () => ++effects,
      { kind: 'read', io: true });

      await assert.rejects(
        () => streaming
          ? executeStream(tree, '/action', undefined, undefined, 'peek').next()
          : executeAction(tree, '/action', undefined, undefined, 'peek'),
        (error: unknown) => error instanceof KernelError && error.code === 'FORBIDDEN',
      );
      assert.equal(effects, 0);
    });
  }
});
