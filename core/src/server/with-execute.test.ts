// withExecute — Tree.execute capability wrapper (core-pxlu).
// Local parity, delegation, visibility masking, opId replay, kind gate.

import { createNode, register, type NodeData } from '#core';
import { clearRegistry } from '#testing';
import { createMemoryTree, type ExecOpts, type Tree } from '#tree';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { type ActionCtx, withExecute } from './actions';
import { wrapReadOnlyTree } from './readonly-tree';

// Counter type with a mutating action + a read action calling out.
function setupCounter() {
  register('test.exec.counter', 'schema', () => ({
    $id: 'test.exec.counter', title: 'Counter', type: 'object' as const,
    properties: { n: { type: 'number' } },
    methods: {
      bump: { arguments: [] },
      peek: { arguments: [], kind: 'read' as const },
    },
  }));
  let runs = 0;
  register('test.exec.counter', 'action:bump', async (ctx: ActionCtx) => {
    runs++;
    (ctx.node as NodeData & { n: number }).n += 1;
    return (ctx.node as NodeData & { n: number }).n;
  });
  return { bumpRuns: () => runs };
}

async function counterTree(): Promise<Tree> {
  const tree = createMemoryTree();
  await tree.set(createNode('/w', 'test.exec.counter', { n: 0 }));
  return tree;
}

// Recorder stub — a "remote authority" tree.
function execRecorder(result: unknown = 'remote-result') {
  const calls: { path: string; action: string; data: unknown; opts: ExecOpts | undefined }[] = [];
  const tree: Tree = {
    ...createMemoryTree(),
    execute: async (path, action, data, opts) => {
      calls.push({ path, action, data, opts });
      return result;
    },
  };
  return { tree, calls };
}

describe('withExecute', () => {
  beforeEach(() => clearRegistry());

  describe('local branch', () => {
    it('mutation persists through the wrapper (full executor semantics)', async () => {
      setupCounter();
      const tree = withExecute(await counterTree());

      const result = await tree.execute('/w', 'bump');

      assert.equal(result, 1);
      const node = await tree.get('/w') as NodeData & { n: number };
      assert.equal(node.n, 1);
      assert.ok(node.$rev && node.$rev >= 2, 'persist bumped $rev');
    });

    it('nested same-path execute inside an action does not deadlock (core-0fa)', async () => {
      register('test.exec.nested', 'schema', () => ({
        $id: 'test.exec.nested', title: 'Nested', type: 'object' as const,
        properties: { n: { type: 'number' } },
        methods: {
          peek: { arguments: [], kind: 'read' as const },
          bumpAfterPeek: { arguments: [] },
        },
      }));
      register('test.exec.nested', 'action:peek', async (ctx: ActionCtx) => (ctx.node as NodeData & { n: number }).n);
      register('test.exec.nested', 'action:bumpAfterPeek', async (ctx: ActionCtx) => {
        // Nested execute on OUR OWN node — reentrant lock, or the peek waits on
        // the bumpAfterPeek gate that only releases when we return: deadlock.
        const before = await ctx.tree.execute!((ctx.node as NodeData).$path, 'peek');
        (ctx.node as NodeData & { n: number }).n += 1;
        return before;
      });

      const inner = createMemoryTree();
      await inner.set(createNode('/w', 'test.exec.nested', { n: 5 }));
      const tree = withExecute(inner);

      const guarded = await Promise.race([
        tree.execute('/w', 'bumpAfterPeek'),
        new Promise(r => setTimeout(() => r('TIMEOUT'), 2000)),
      ]);
      assert.equal(guarded, 5, 'nested peek returned n (=5) before bump — no deadlock');
      const node = await tree.get('/w') as NodeData & { n: number };
      assert.equal(node.n, 6, 'outer bump persisted after the reentrant read');
    });

    it('opId replay returns first outcome without re-running', async () => {
      const { bumpRuns } = setupCounter();
      const tree = withExecute(await counterTree());

      const a = await tree.execute('/w', 'bump', undefined, { opId: 'local-op' });
      const b = await tree.execute('/w', 'bump', undefined, { opId: 'local-op' });

      assert.equal(a, 1);
      assert.equal(b, 1);
      assert.equal(bumpRuns(), 1);
    });

    it('delegate returning undefined falls through to the local executor', async () => {
      setupCounter();
      let probed: string | undefined;
      const tree = withExecute(await counterTree(), {
        delegate: async (path) => { probed = path; return undefined; },
      });

      assert.equal(await tree.execute('/w', 'bump'), 1);
      assert.equal(probed, '/w');
    });

    it('identity binds at wrap time — reaches the handler ctx', async () => {
      register('test.exec.who', 'schema', () => ({
        $id: 'test.exec.who', title: 'Who', type: 'object' as const,
        properties: {}, methods: { who: { arguments: [] } },
      }));
      register('test.exec.who', 'action:who', async (ctx: ActionCtx) => ctx.userId);
      const inner = createMemoryTree();
      await inner.set(createNode('/u', 'test.exec.who'));
      const tree = withExecute(inner, { identity: { userId: 'alice', claims: ['users'] } });

      assert.equal(await tree.execute('/u', 'who'), 'alice');
    });
  });

  describe('delegation', () => {
    it('forwards path/data/opts to the foreign authority, onDelegated fires', async () => {
      const { tree: remote, calls } = execRecorder();
      const inner = createMemoryTree();
      await inner.set(createNode('/fed/w', 'anything'));
      const events: string[] = [];
      const tree = withExecute(inner, {
        delegate: async (path) => path.startsWith('/fed') ? remote : undefined,
        onDelegating: (info) => { events.push(`intent:${info.path}:${info.action}`); },
        onDelegated: (path, action) => { events.push(`done:${path}:${action}`); },
        onDelegatedSettled: (info) => { events.push(`settled:${info.ok}`); },
      });

      const result = await tree.execute('/fed/w', 'bump', { by: 2 }, { key: 'c', opId: 'd-1' });

      assert.equal(result, 'remote-result');
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0], { path: '/fed/w', action: 'bump', data: { by: 2 }, opts: { key: 'c', opId: 'd-1' } });
      assert.deepEqual(events, ['intent:/fed/w:bump', 'done:/fed/w:bump', 'settled:true']);
    });

    it('delegated opId replay: remote called once, onDelegated once', async () => {
      const { tree: remote, calls } = execRecorder();
      const inner = createMemoryTree();
      await inner.set(createNode('/fed/w', 'anything'));
      let delegatedCount = 0;
      const tree = withExecute(inner, {
        delegate: async () => remote,
        onDelegated: () => { delegatedCount++; },
      });

      const a = await tree.execute('/fed/w', 'bump', undefined, { opId: 'replay-1' });
      const b = await tree.execute('/fed/w', 'bump', undefined, { opId: 'replay-1' });

      assert.equal(a, 'remote-result');
      assert.equal(b, 'remote-result');
      assert.equal(calls.length, 1);
      assert.equal(delegatedCount, 1);
    });

    it('opId replay stays deduplicated when authority changes from local to remote', async () => {
      const { bumpRuns } = setupCounter();
      const { tree: remote, calls } = execRecorder();
      let delegated = false;
      const tree = withExecute(await counterTree(), {
        delegate: async () => delegated ? remote : undefined,
      });

      const first = await tree.execute('/w', 'bump', undefined, { opId: 'route-switch-op' });
      delegated = true;
      const replay = await tree.execute('/w', 'bump', undefined, { opId: 'route-switch-op' });

      assert.equal(first, 1);
      assert.equal(replay, 1);
      assert.equal(bumpRuns(), 1);
      assert.equal(calls.length, 0);
    });

    it('idempotency key keeps userId and opId as an unambiguous tuple', async () => {
      let remoteRuns = 0;
      const remote: Tree = {
        ...createMemoryTree(),
        execute: async () => ++remoteRuns,
      };
      const inner = createMemoryTree();
      await inner.set(createNode('/fed/w', 'anything'));
      const firstUser = withExecute(inner, {
        identity: { userId: 'a' },
        delegate: async () => remote,
      });
      const secondUser = withExecute(inner, {
        identity: { userId: 'a b' },
        delegate: async () => remote,
      });

      const first = await firstUser.execute('/fed/w', 'bump', undefined, { opId: 'b c' });
      const second = await secondUser.execute('/fed/w', 'bump', undefined, { opId: 'c' });

      assert.equal(first, 1);
      assert.equal(second, 2);
      assert.equal(remoteRuns, 2);
    });

    it('no R visibility → NOT_FOUND, target never called', async () => {
      const { tree: remote, calls } = execRecorder();
      const forbidden: Tree = {
        ...createMemoryTree(),
        get: async () => { throw Object.assign(new Error('Access denied'), { code: 'FORBIDDEN' }); },
      };
      const tree = withExecute(forbidden, { delegate: async () => remote });

      await assert.rejects(
        () => tree.execute('/fed/secret', 'bump'),
        (e: { code?: string }) => e.code === 'NOT_FOUND',
      );
      assert.equal(calls.length, 0);
    });

    it('missing node → NOT_FOUND, target never called', async () => {
      const { tree: remote, calls } = execRecorder();
      const tree = withExecute(createMemoryTree(), { delegate: async () => remote });

      await assert.rejects(
        () => tree.execute('/fed/nope', 'bump'),
        (e: { code?: string }) => e.code === 'NOT_FOUND',
      );
      assert.equal(calls.length, 0);
    });

    it('onDelegating failure ABORTS the delegation (fail closed)', async () => {
      const { tree: remote, calls } = execRecorder();
      const inner = createMemoryTree();
      await inner.set(createNode('/fed/w', 'anything'));
      const tree = withExecute(inner, {
        delegate: async () => remote,
        onDelegating: () => { throw new Error('audit intent append failed'); },
      });

      await assert.rejects(() => tree.execute('/fed/w', 'bump'), /audit intent append failed/);
      assert.equal(calls.length, 0);
    });

    it('onDelegatedSettled failure does not eat the result', async () => {
      const { tree: remote } = execRecorder('committed');
      const inner = createMemoryTree();
      await inner.set(createNode('/fed/w', 'anything'));
      const tree = withExecute(inner, {
        delegate: async () => remote,
        onDelegatedSettled: () => { throw new Error('post-audit down'); },
      });

      assert.equal(await tree.execute('/fed/w', 'bump'), 'committed');
    });

    it('remote failure surfaces and settled hook sees ok:false', async () => {
      const inner = createMemoryTree();
      await inner.set(createNode('/fed/w', 'anything'));
      const failing: Tree = {
        ...createMemoryTree(),
        execute: async () => { throw Object.assign(new Error('remote denied'), { code: 'FORBIDDEN' }); },
      };
      let settled: { ok: boolean } | undefined;
      const tree = withExecute(inner, {
        delegate: async () => failing,
        onDelegatedSettled: (info) => { settled = info; },
      });

      await assert.rejects(
        () => tree.execute('/fed/w', 'bump'),
        (e: { code?: string }) => e.code === 'FORBIDDEN',
      );
      assert.equal(settled?.ok, false);
    });

    it('settled hook failure on the ERROR path never masks the remote error (core-pa3m)', async () => {
      const inner = createMemoryTree();
      await inner.set(createNode('/fed/w', 'anything'));
      const failing: Tree = {
        ...createMemoryTree(),
        execute: async () => { throw Object.assign(new Error('remote denied'), { code: 'CONFLICT' }); },
      };
      const tree = withExecute(inner, {
        delegate: async () => failing,
        // Async hook that rejects — must be awaited (no floating rejection)
        // and must not replace the remote error the caller needs to see.
        onDelegatedSettled: async () => { throw new Error('journal down'); },
      });

      await assert.rejects(
        () => tree.execute('/fed/w', 'bump'),
        (e: { code?: string }) => e.code === 'CONFLICT',
      );
    });

    it('async settled hook is awaited before the result returns (core-pa3m)', async () => {
      const { tree: remote } = execRecorder('committed');
      const inner = createMemoryTree();
      await inner.set(createNode('/fed/w', 'anything'));
      const order: string[] = [];
      const tree = withExecute(inner, {
        delegate: async () => remote,
        onDelegatedSettled: async (info) => {
          await Promise.resolve();
          order.push(`settled:${info.ok}:${info.opId}`);
        },
      });

      const result = await tree.execute('/fed/w', 'bump', undefined, { opId: 'op-9' });
      order.push('returned');

      assert.equal(result, 'committed');
      assert.deepEqual(order, ['settled:true:op-9', 'returned'], 'hook (with opId in info) completed before return');
    });

    it('read-kind frame cannot delegate (FORBIDDEN, conservative write+io)', async () => {
      setupCounter();
      const { tree: remote, calls } = execRecorder();
      const inner = createMemoryTree();
      await inner.set(createNode('/w', 'test.exec.counter', { n: 0 }));
      await inner.set(createNode('/fed/w', 'anything'));
      const tree = withExecute(inner, {
        delegate: async (path) => path.startsWith('/fed') ? remote : undefined,
      });
      // A service holding the exec-capable tree calls a delegated execute from
      // inside a read action frame — must be rejected, kind does not cross the wire.
      register('test.exec.counter', 'action:peek', async () =>
        tree.execute('/fed/w', 'bump'));

      await assert.rejects(
        () => tree.execute('/w', 'peek'),
        (e: { code?: string }) => e.code === 'FORBIDDEN',
      );
      assert.equal(calls.length, 0);
    });
  });

  describe('composition', () => {
    it('wrapReadOnlyTree strips execute — capability marker stays honest', async () => {
      const tree = withExecute(await counterTree());
      const ro = wrapReadOnlyTree(tree);
      assert.equal('execute' in ro, false);
    });
  });
});
