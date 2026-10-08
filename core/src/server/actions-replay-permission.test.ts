import { createNode, R, register, replaceHandler, W } from '#core';
import { KernelError } from '#errors';
import { withAcl } from '#security';
import { clearRegistry } from '#testing';
import { createMemoryTree, type Tree } from '#tree';
import { createRepathTree } from '#tree/repath';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, it } from 'node:test';
import { executeAction, withExecute, type ActionCtx } from './actions';
import { mutationLock } from './commit';

describe('action replay authorization', () => {
  beforeEach(clearRegistry);

  async function setup() {
    const raw = createMemoryTree();
    await raw.set({ ...createNode('/', 'dir'), $acl: [{ g: 'agents', p: R | W }] });
    await raw.set(createNode('/work', 'test.replay', { total: 0 }));
    await raw.set(createNode('/other', 'test.replay', { total: 0 }));
    register('test.replay', 'schema', () => ({
      type: 'object', properties: {}, methods: {
        collect: { arguments: [] }, other: { arguments: [] }, inspect: { kind: 'read', arguments: [] },
      },
    }));
    let attempts = 0;
    const collect = (ctx: ActionCtx, data: { amount?: number }) => {
      attempts++;
      ctx.node.total = Number(ctx.node.total) + (data.amount ?? 1);
      return { sensitive: 'private outcome', total: ctx.node.total };
    };
    register('test.replay', 'action:collect', collect);
    register('test.replay', 'action:other', collect);
    return { raw, attempts: () => attempts, opId: randomUUID() };
  }

  const denied = (error: unknown) => error instanceof KernelError && error.code === 'FORBIDDEN';
  const changedReplay = (error: unknown) => error instanceof KernelError && error.code === 'INVALID';

  it('fresh equivalent ACL wrappers share the authorized original outcome', async () => {
    const { raw, attempts, opId } = await setup();
    const first = await executeAction(withAcl(raw, 'agent', ['agents', 'extra']), '/work', undefined, undefined,
      'collect', { amount: 2 }, { userId: 'agent', opId });
    const second = await executeAction(withAcl(raw, 'agent', ['extra', 'agents']), '/work', undefined, undefined,
      'collect', { amount: 2 }, { userId: 'agent', opId });
    assert.deepEqual(second, first);
    assert.equal(attempts(), 1);
  });

  it('changed ACL claims cannot release an earlier outcome even while the target remains writable', async () => {
    const { raw, attempts, opId } = await setup();
    await executeAction(withAcl(raw, 'agent', ['agents', 'extra']), '/work', undefined, undefined,
      'collect', {}, { userId: 'agent', opId });
    await assert.rejects(() => executeAction(withAcl(raw, 'agent', ['agents']), '/work', undefined, undefined,
      'collect', {}, { userId: 'agent', opId }), changedReplay);
    assert.equal(attempts(), 1);
  });

  it('rooted trees retain the ACL scope on replay', async () => {
    const { raw, attempts, opId } = await setup();
    const first = createRepathTree(withAcl(raw, 'agent', ['agents', 'extra']), '/mounted');
    await executeAction(first, '/mounted/work', undefined, undefined, 'collect', {}, { userId: 'agent', opId });
    const narrowed = createRepathTree(withAcl(raw, 'agent', ['agents']), '/mounted');
    await assert.rejects(() => executeAction(narrowed, '/mounted/work', undefined, undefined, 'collect', {},
      { userId: 'agent', opId }), changedReplay);
    assert.equal(attempts(), 1);
  });

  it('replay cannot substitute a different rooted target for the same logical path', async () => {
    const { raw, attempts, opId } = await setup();
    const caller = withAcl(raw, 'agent', ['agents']);
    await executeAction(createRepathTree(caller, '/view', '/work'), '/view', undefined, undefined,
      'collect', {}, { userId: 'agent', opId });
    await assert.rejects(() => executeAction(createRepathTree(caller, '/view', '/other'), '/view', undefined, undefined,
      'collect', {}, { userId: 'agent', opId }), changedReplay);
    assert.equal(attempts(), 1);
    assert.equal((await raw.get('/work'))?.total, 1);
    assert.equal((await raw.get('/other'))?.total, 0);
  });

  it('equivalent fresh rooted views retain one authorized execution', async () => {
    const { raw, attempts, opId } = await setup();
    const first = await executeAction(createRepathTree(withAcl(raw, 'agent', ['agents']), '/view', '/work'),
      '/view', undefined, undefined, 'collect', {}, { userId: 'agent', opId });
    assert.deepEqual(await executeAction(createRepathTree(withAcl(raw, 'agent', ['agents']), '/view', '/work'),
      '/view', undefined, undefined, 'collect', {}, { userId: 'agent', opId }), first);
    assert.equal(attempts(), 1);
  });

  it('equal arguments with different property order retain one execution', async () => {
    const { raw, attempts, opId } = await setup();
    const tree = withAcl(raw, 'agent', ['agents']);
    const first = await executeAction(tree, '/work', undefined, undefined, 'collect',
      { amount: 2, details: { a: 1, b: 2 } }, { userId: 'agent', opId });
    assert.deepEqual(await executeAction(tree, '/work', undefined, undefined, 'collect',
      { details: { b: 2, a: 1 }, amount: 2 }, { userId: 'agent', opId }), first);
    assert.equal(attempts(), 1);
  });

  it('changing the original argument object cannot change an existing operation', async () => {
    const { raw, attempts, opId } = await setup();
    const tree = withAcl(raw, 'agent', ['agents']);
    const data = { amount: 2 };
    await executeAction(tree, '/work', undefined, undefined, 'collect', data, { userId: 'agent', opId });
    data.amount = 3;
    await assert.rejects(() => executeAction(tree, '/work', undefined, undefined, 'collect', data,
      { userId: 'agent', opId }), changedReplay);
    assert.equal(attempts(), 1);
    assert.equal((await raw.get('/work'))?.total, 2);
  });

  it('a handler can mutate its arguments without changing the replay request', async () => {
    const { raw, opId } = await setup();
    let attempts = 0;
    replaceHandler('test.replay', 'action:collect', (ctx: ActionCtx, data: { amount: number }) => {
      attempts++;
      data.amount++;
      ctx.node.total = Number(ctx.node.total) + data.amount;
      return ctx.node.total;
    });
    const tree = withAcl(raw, 'agent', ['agents']);
    assert.equal(await executeAction(tree, '/work', undefined, undefined, 'collect', { amount: 2 },
      { userId: 'agent', opId }), 3);
    assert.equal(await executeAction(tree, '/work', undefined, undefined, 'collect', { amount: 2 },
      { userId: 'agent', opId }), 3);
    assert.equal(attempts, 1);
    assert.equal((await raw.get('/work'))?.total, 3);
  });

  it('an operation executes its captured arguments while waiting for the target lock', async () => {
    const { raw, attempts, opId } = await setup();
    const tree = withAcl(raw, 'agent', ['agents']);
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const held = mutationLock('/work', async () => { entered(); await gate; });
    await started;
    const data = { amount: 2 };
    const first = executeAction(tree, '/work', undefined, undefined, 'collect', data, { userId: 'agent', opId });
    data.amount = 3;
    release();
    await held;
    assert.deepEqual(await first, { sensitive: 'private outcome', total: 2 });
    assert.equal(attempts(), 1);
    assert.equal((await raw.get('/work'))?.total, 2);
  });

  it('nested read calls can retain read-only node arguments while deduplicating', async () => {
    const { raw, opId } = await setup();
    let attempts = 0;
    register('test.replay', 'action:inspect', (_ctx: ActionCtx, node: { total: number }) => {
      attempts++;
      return node.total;
    }, { kind: 'read' });
    replaceHandler('test.replay', 'action:other', (ctx: ActionCtx) => executeAction(ctx.tree, '/other', undefined, undefined,
      'inspect', ctx.node, { userId: 'agent', opId }), { kind: 'read' });
    const tree = withAcl(raw, 'agent', ['agents']);
    assert.equal(await executeAction(tree, '/work', undefined, undefined, 'other', {}), 0);
    assert.equal(await executeAction(tree, '/work', undefined, undefined, 'other', {}), 0);
    assert.equal(attempts, 1);
  });

  it('changed caller claims in action options cannot replay an earlier outcome', async () => {
    const { raw, attempts, opId } = await setup();
    const tree = withAcl(raw, 'agent', ['agents']);
    await executeAction(tree, '/work', undefined, undefined, 'collect', {},
      { userId: 'agent', claims: ['agents', 'extra'], opId });
    await assert.rejects(() => executeAction(tree, '/work', undefined, undefined, 'collect', {},
      { userId: 'agent', claims: ['agents'], opId }), changedReplay);
    assert.equal(attempts(), 1);
  });

  it('changed workload ownership cannot replay an earlier outcome', async () => {
    const { raw, attempts, opId } = await setup();
    const tree = withAcl(raw, 'agent', ['agents']);
    await executeAction(tree, '/work', undefined, undefined, 'collect', {},
      { userId: 'agent', actor: { id: 'agent', onBehalfOf: 'alice' }, opId });
    await assert.rejects(() => executeAction(tree, '/work', undefined, undefined, 'collect', {},
      { userId: 'agent', actor: { id: 'agent', onBehalfOf: 'bob' }, opId }), changedReplay);
    assert.equal(attempts(), 1);
  });

  for (const changed of ['path', 'action', 'type', 'key', 'data']) {
    it(`an existing operation id rejects a changed ${changed} before replay or another effect`, async () => {
      const { raw, attempts, opId } = await setup();
      const tree = withAcl(raw, 'agent', ['agents']);
      await executeAction(tree, '/work', undefined, undefined, 'collect', { amount: 2 }, { userId: 'agent', opId });
      await assert.rejects(() => executeAction(tree,
        changed === 'path' ? '/other' : '/work',
        changed === 'type' ? 'other.type' : undefined,
        changed === 'key' ? 'other' : undefined,
        changed === 'action' ? 'other' : 'collect',
        { amount: changed === 'data' ? 3 : 2 }, { userId: 'agent', opId }), changedReplay);
      assert.equal(attempts(), 1);
      assert.equal((await raw.get('/work'))?.total, 2);
      assert.equal((await raw.get('/other'))?.total, 0);
    });
  }

  for (const revoked of [R, W]) {
    it(`a cached outcome requires current target ${revoked === R ? 'write' : 'read'} permission`, async () => {
      const { raw, attempts, opId } = await setup();
      const tree = withAcl(raw, 'agent', ['agents']);
      await executeAction(tree, '/work', undefined, undefined, 'collect', {}, { userId: 'agent', opId });
      const restricted: Tree = { ...tree, getPerm: async () => revoked };
      await assert.rejects(() => executeAction(restricted, '/work', undefined, undefined, 'collect', {},
        { userId: 'agent', opId }), (error: unknown) => error instanceof KernelError
          && error.code === (revoked === R ? 'FORBIDDEN' : 'NOT_FOUND'));
      assert.equal(attempts(), 1);
    });
  }

  it('a read action cannot obtain the cached outcome of a write action', async () => {
    const { raw, attempts, opId } = await setup();
    const tree = withAcl(raw, 'agent', ['agents']);
    await executeAction(tree, '/work', undefined, undefined, 'collect', {}, { userId: 'agent', opId });
    register('test.replay', 'action:inspect', (ctx: ActionCtx) => executeAction(ctx.tree, '/work', undefined, undefined,
      'collect', {}, { userId: 'agent', opId }), { kind: 'read' });
    await assert.rejects(() => executeAction(tree, '/work', undefined, undefined, 'inspect', {}), denied);
    assert.equal(attempts(), 1);
  });

  it('a delegated cached outcome requires current write permission on the local mount', async () => {
    const { raw, opId } = await setup();
    let attempts = 0;
    const remote: Tree = { ...createMemoryTree(), execute: async () => { attempts++; return 'private outcome'; } };
    const caller = withAcl(raw, 'agent', ['agents']);
    const opts = {
      identity: { userId: 'agent' },
      delegate: async () => ({ tree: remote, mountPath: '/work' }),
    };
    await withExecute(caller, opts).execute('/work/foreign', 'collect', {}, { opId });
    const restricted: Tree = { ...caller, getPerm: async () => R };
    await assert.rejects(() => withExecute(restricted, opts).execute('/work/foreign', 'collect', {}, { opId }), denied);
    assert.equal(attempts, 1);
  });
});
