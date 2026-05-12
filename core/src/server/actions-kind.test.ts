import { register } from '#core';
import { clearRegistry } from '#core/index.test';
import { createMemoryTree } from '#tree';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { executeAction, type ActionCtx } from './actions';

describe('executeAction — kind enforcement', () => {
  beforeEach(() => {
    clearRegistry();
  });

  it('@read action: ctx.tree.set throws KIND_VIOLATION', async () => {
    register('test.kind.read', 'schema', () => ({
      $id: 'test.kind.read',
      type: 'object',
      properties: {},
      methods: {
        readAction: { arguments: [], kind: 'read' as const },
      },
    }));

    register('test.kind.read', 'action:readAction', async (ctx: ActionCtx) => {
      await ctx.tree.set({ $path: '/should-not-write', $type: 'foo' });
    });

    const tree = createMemoryTree();
    await tree.set({ $path: '/n', $type: 'test.kind.read' });

    await assert.rejects(
      () => executeAction(tree, '/n', undefined, undefined, 'readAction'),
      (err: any) => err?.code === 'KIND_VIOLATION' || err?.name === 'KindViolationError',
    );
  });

  it('@read action calling @write via ctx.nc().execute throws KIND_VIOLATION', async () => {
    register('test.kind.r', 'schema', () => ({
      $id: 'test.kind.r',
      type: 'object',
      properties: {},
      methods: {
        readCallsWrite: { arguments: [], kind: 'read' as const },
      },
    }));

    register('test.kind.w', 'schema', () => ({
      $id: 'test.kind.w',
      type: 'object',
      properties: {},
      methods: {
        writeOp: { arguments: [], kind: 'write' as const },
      },
    }));

    register('test.kind.r', 'action:readCallsWrite', async (ctx: ActionCtx) => {
      // Nested executeAction — kind-stack should reject read→write at entry.
      await executeAction(ctx.tree, '/target', undefined, undefined, 'writeOp');
    });

    register('test.kind.w', 'action:writeOp', async (ctx: ActionCtx) => {
      (ctx.node as any).touched = true;
    });

    const tree = createMemoryTree();
    await tree.set({ $path: '/caller', $type: 'test.kind.r' });
    await tree.set({ $path: '/target', $type: 'test.kind.w' });

    await assert.rejects(
      () => executeAction(tree, '/caller', undefined, undefined, 'readCallsWrite'),
      (err: any) => err?.code === 'KIND_VIOLATION' || err?.name === 'KindViolationError',
    );
  });

  it('@write action proceeds normally (no regression for unmarked or @write)', async () => {
    register('test.kind.w2', 'schema', () => ({
      $id: 'test.kind.w2',
      type: 'object',
      properties: { count: { type: 'number' } },
      methods: {
        bump: { arguments: [], kind: 'write' as const },
      },
    }));

    register('test.kind.w2', 'action:bump', async (ctx: ActionCtx) => {
      (ctx.node as any).count = ((ctx.node as any).count ?? 0) + 1;
    });

    const tree = createMemoryTree();
    await tree.set({ $path: '/x', $type: 'test.kind.w2', count: 0 });

    await executeAction(tree, '/x', undefined, undefined, 'bump');

    const after = await tree.get('/x');
    assert.equal((after as any)?.count, 1);
  });

  it('@read action: this.x = ... throws KIND_VIOLATION (via readonly proxy on node)', async () => {
    register('test.kind.this', 'schema', () => ({
      $id: 'test.kind.this',
      type: 'object',
      properties: { count: { type: 'number' } },
      methods: { tryWrite: { arguments: [], kind: 'read' as const } },
    }));

    register('test.kind.this', 'action:tryWrite', async (ctx: ActionCtx) => {
      (ctx.node as any).count = 1;
    });

    const tree = createMemoryTree();
    await tree.set({ $path: '/t', $type: 'test.kind.this', count: 0 });

    await assert.rejects(
      () => executeAction(tree, '/t', undefined, undefined, 'tryWrite'),
      (err: any) => err?.code === 'KIND_VIOLATION' || err?.name === 'KindViolationError',
    );
  });

  it('out-of-band tree.set (no executeAction frame) is allowed', async () => {
    const tree = createMemoryTree();
    // Direct write without entering executeAction — e.g. seed/migration code.
    await tree.set({ $path: '/seeded', $type: 'whatever' });

    const got = await tree.get('/seeded');
    assert.equal((got as any)?.$type, 'whatever');
  });
});
