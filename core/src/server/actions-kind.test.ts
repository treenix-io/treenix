import { registerType } from '#comp';
import { type ComponentData, createNode, type NodeData, register } from '#core';
import { OpError } from '#errors';
import { clearRegistry } from '#testing';
import { createMemoryTree } from '#tree';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { executeAction, executeStream, type ActionCtx } from './actions';
import { runWithFrame } from './kind-stack';

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

  it('@read calling @write — nested handler NOT invoked (throws on entry, no side effects)', async () => {
    let writeHandlerRan = false;

    register('test.kind.rNoSide', 'schema', () => ({
      $id: 'test.kind.rNoSide',
      type: 'object',
      properties: {},
      methods: { readCallsWrite: { arguments: [], kind: 'read' as const } },
    }));

    register('test.kind.wNoSide', 'schema', () => ({
      $id: 'test.kind.wNoSide',
      type: 'object',
      properties: {},
      methods: { writeOp: { arguments: [], kind: 'write' as const } },
    }));

    register('test.kind.rNoSide', 'action:readCallsWrite', async (ctx: ActionCtx) => {
      await executeAction(ctx.tree, '/wn', undefined, undefined, 'writeOp');
    });

    register('test.kind.wNoSide', 'action:writeOp', async (ctx: ActionCtx) => {
      writeHandlerRan = true;
      (ctx.node as any).touched = true;
    });

    const tree = createMemoryTree();
    await tree.set({ $path: '/rn', $type: 'test.kind.rNoSide' });
    await tree.set({ $path: '/wn', $type: 'test.kind.wNoSide' });

    await assert.rejects(
      () => executeAction(tree, '/rn', undefined, undefined, 'readCallsWrite'),
      (err: any) => err?.code === 'KIND_VIOLATION' && /write target/.test(err.message),
    );

    assert.equal(writeHandlerRan, false, 'write handler must not run when caller is @read');
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

  it('registry meta {kind:"read"} enforces read even without schema kind', async () => {
    // Action registered programmatically with kind in meta, NO schema.kind.
    register('test.kind.metareg', 'schema', () => ({
      $id: 'test.kind.metareg',
      type: 'object',
      properties: {},
      methods: { readish: { arguments: [] } }, // no kind in schema
    }));

    register(
      'test.kind.metareg',
      'action:readish',
      async (ctx: ActionCtx) => {
        await ctx.tree.set({ $path: '/blocked', $type: 'foo' });
      },
      { kind: 'read' }, // meta declares kind
    );

    const tree = createMemoryTree();
    await tree.set({ $path: '/r', $type: 'test.kind.metareg' });

    await assert.rejects(
      () => executeAction(tree, '/r', undefined, undefined, 'readish'),
      (err: any) => err?.code === 'KIND_VIOLATION',
    );
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

  it('generator action: ctx.node mutation throws KIND_VIOLATION (no draft — write would vanish)', async () => {
    register('test.kind.gen', 'schema', () => ({
      $id: 'test.kind.gen',
      type: 'object',
      properties: {},
      methods: { run: { arguments: [], streaming: true } },
    }));

    register('test.kind.gen', 'action:run', async function* (ctx: ActionCtx) {
      ctx.node.touched = true;
      yield 1;
    });

    const tree = createMemoryTree();
    await tree.set({ $path: '/g', $type: 'test.kind.gen' });

    await assert.rejects(
      (async () => {
        for await (const _ of executeStream(tree, '/g', undefined, undefined, 'run')) { /* drain */ }
      })(),
      (err: any) => err?.code === 'KIND_VIOLATION',
    );
  });

  it('@read action: dep mutation throws KIND_VIOLATION', async () => {
    class ReadPeek {
      peek(_d: unknown, deps: { status: ComponentData }) {
        deps.status.value = 'mutated';
      }
    }

    registerType('test.kind.readdep', ReadPeek, { needs: { peek: ['status'] } });
    register('test.kind.readdep', 'schema', () => ({
      $id: 'test.kind.readdep',
      type: 'object',
      properties: {},
      methods: { peek: { arguments: [], kind: 'read' as const } },
    }));

    const tree = createMemoryTree();
    await tree.set(createNode('/rd', 'page', {}, {
      readdep: { $type: 'test.kind.readdep' },
      status: { $type: 'status', value: 'draft' },
    }));

    await assert.rejects(
      () => executeAction(tree, '/rd', 'test.kind.readdep', undefined, 'peek'),
      (err: any) => err?.code === 'KIND_VIOLATION',
    );
  });

  it('@write action: cross-node dep mutation throws KIND_VIOLATION (was silently dropped)', async () => {
    class CrossPoke {
      poke(_d: unknown, deps: { target: NodeData }) {
        deps.target.value = 'mutated';
      }
    }

    registerType('test.kind.crossdep', CrossPoke, { needs: { poke: ['/cfg/target'] } });
    register('test.kind.crossdep', 'schema', () => ({
      $id: 'test.kind.crossdep',
      type: 'object',
      properties: {},
      methods: { poke: { arguments: [], kind: 'write' as const } },
    }));

    const tree = createMemoryTree();
    await tree.set(createNode('/cfg/target', 'cfg', { value: 'original' }));
    await tree.set(createNode('/w', 'page', {}, { crossdep: { $type: 'test.kind.crossdep' } }));

    await assert.rejects(
      () => executeAction(tree, '/w', 'test.kind.crossdep', undefined, 'poke'),
      (err: any) => err?.code === 'KIND_VIOLATION',
    );

    assert.equal((await tree.get('/cfg/target'))!.value, 'original', 'dep target untouched');
  });

  it('@write action: sibling dep mutation still persists via draft (no regression)', async () => {
    class Publisher {
      publish(_d: unknown, deps: { status: ComponentData }) {
        deps.status.value = 'published';
      }
    }

    registerType('test.kind.sibdep', Publisher, { needs: { publish: ['status'] } });
    register('test.kind.sibdep', 'schema', () => ({
      $id: 'test.kind.sibdep',
      type: 'object',
      properties: {},
      methods: { publish: { arguments: [], kind: 'write' as const } },
    }));

    const tree = createMemoryTree();
    await tree.set(createNode('/pub', 'page', {}, {
      sibdep: { $type: 'test.kind.sibdep' },
      status: { $type: 'status', value: 'draft' },
    }));

    await executeAction(tree, '/pub', 'test.kind.sibdep', undefined, 'publish');

    const after = (await tree.get('/pub'))!;
    assert.equal((after['#status'] as ComponentData).value, 'published');
  });
});

// ── executeStream kind envelope (core-gk8.15) ──

describe('executeStream — kind envelope', () => {
  beforeEach(() => {
    clearRegistry();
  });

  it('read frame cannot start a write-kind stream (entry gate)', async () => {
    register('test.skind.w', 'schema', () => ({
      $id: 'test.skind.w',
      type: 'object',
      properties: {},
      methods: { gen: { arguments: [], kind: 'write' as const } },
    }));
    register('test.skind.w', 'action:gen', async function* () { yield 1; });

    const tree = createMemoryTree();
    await tree.set({ $path: '/n', $type: 'test.skind.w' });

    await assert.rejects(
      () => runWithFrame({ kind: 'read', io: false, path: '/r', action: 'reader' }, async () => {
        // The generator body (and its entry gate) runs on first next().
        await executeStream(tree, '/n', undefined, undefined, 'gen')[Symbol.asyncIterator]().next();
      }),
      (e: unknown) => e instanceof OpError && e.code === 'KIND_VIOLATION',
    );
  });

  it('read-kind stream: ctx.tree.set denied even AFTER the first yield (frame per resumption)', async () => {
    register('test.skind.r', 'schema', () => ({
      $id: 'test.skind.r',
      type: 'object',
      properties: {},
      methods: { gen: { arguments: [], kind: 'read' as const } },
    }));
    register('test.skind.r', 'action:gen', async function* (ctx: ActionCtx) {
      yield 'first';
      await ctx.tree.set({ $path: '/should-not-write', $type: 'foo' });
      yield 'never';
    });

    const tree = createMemoryTree();
    await tree.set({ $path: '/n', $type: 'test.skind.r' });

    const it = executeStream(tree, '/n', undefined, undefined, 'gen')[Symbol.asyncIterator]();
    assert.equal((await it.next()).value, 'first');
    await assert.rejects(
      () => it.next(),
      (e: unknown) => e instanceof OpError && e.code === 'KIND_VIOLATION',
    );
    assert.equal(await tree.get('/should-not-write'), undefined, 'nothing written');
  });

  it('nested write ACTION inside a read-kind stream body is denied mid-stream', async () => {
    register('test.skind.rn', 'schema', () => ({
      $id: 'test.skind.rn',
      type: 'object',
      properties: {},
      methods: { gen: { arguments: [], kind: 'read' as const } },
    }));
    register('test.skind.wn', 'schema', () => ({
      $id: 'test.skind.wn',
      type: 'object',
      properties: {},
      methods: { mut: { arguments: [], kind: 'write' as const } },
    }));
    let ran = false;
    register('test.skind.wn', 'action:mut', async () => { ran = true; });
    register('test.skind.rn', 'action:gen', async function* (ctx: ActionCtx) {
      yield 'first';
      await executeAction(ctx.tree, '/wn', undefined, undefined, 'mut');
    });

    const tree = createMemoryTree();
    await tree.set({ $path: '/n', $type: 'test.skind.rn' });
    await tree.set({ $path: '/wn', $type: 'test.skind.wn' });

    const it = executeStream(tree, '/n', undefined, undefined, 'gen')[Symbol.asyncIterator]();
    await it.next();
    await assert.rejects(
      () => it.next(),
      (e: unknown) => e instanceof OpError && e.code === 'KIND_VIOLATION',
    );
    assert.equal(ran, false, 'nested write handler never invoked');
  });

  // core-anz4.20: manual pump must forward return() so handler cleanup runs.
  it('consumer break closes the handler iterator (try/finally runs)', async () => {
    register('test.skind.fin', 'schema', () => ({
      $id: 'test.skind.fin',
      type: 'object',
      properties: {},
      methods: { gen: { arguments: [], kind: 'read' as const } },
    }));
    let cleaned = false;
    register('test.skind.fin', 'action:gen', async function* () {
      try {
        yield 'a';
        yield 'b';
      } finally {
        cleaned = true;
      }
    });

    const tree = createMemoryTree();
    await tree.set({ $path: '/n', $type: 'test.skind.fin' });

    for await (const v of executeStream(tree, '/n', undefined, undefined, 'gen')) {
      assert.equal(v, 'a');
      break;
    }
    assert.equal(cleaned, true, 'handler finally ran on consumer break');
  });

  // core-anz4.20: a custom async iterable's return() is IteratorClose — only for
  // ABRUPT completion. Natural end (r.done) must NOT call return() again (double-close).
  function customIterable(counter: { returns: number }) {
    let i = 0;
    const values = ['a', 'b'];
    const iterator = {
      next() {
        return Promise.resolve(i < values.length ? { value: values[i++], done: false } : { value: undefined, done: true });
      },
      return() {
        counter.returns++;
        return Promise.resolve({ value: undefined, done: true });
      },
    };
    return { [Symbol.asyncIterator]: () => iterator };
  }

  it('consumer break => custom iterable return() called exactly once', async () => {
    const counter = { returns: 0 };
    register('test.skind.custombreak', 'schema', () => ({
      $id: 'test.skind.custombreak', type: 'object', properties: {},
      methods: { gen: { arguments: [], kind: 'read' as const } },
    }));
    register('test.skind.custombreak', 'action:gen', () => customIterable(counter));

    const tree = createMemoryTree();
    await tree.set({ $path: '/n', $type: 'test.skind.custombreak' });

    for await (const _ of executeStream(tree, '/n', undefined, undefined, 'gen')) break;
    assert.equal(counter.returns, 1);
  });

  it('natural completion => custom iterable return() NOT called (no double-close)', async () => {
    const counter = { returns: 0 };
    register('test.skind.customdrain', 'schema', () => ({
      $id: 'test.skind.customdrain', type: 'object', properties: {},
      methods: { gen: { arguments: [], kind: 'read' as const } },
    }));
    register('test.skind.customdrain', 'action:gen', () => customIterable(counter));

    const tree = createMemoryTree();
    await tree.set({ $path: '/n', $type: 'test.skind.customdrain' });

    const seen: unknown[] = [];
    for await (const v of executeStream(tree, '/n', undefined, undefined, 'gen')) seen.push(v);
    assert.deepEqual(seen, ['a', 'b']);
    assert.equal(counter.returns, 0);
  });
});
