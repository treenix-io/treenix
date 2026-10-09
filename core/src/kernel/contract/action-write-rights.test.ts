import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it, type TestContext } from 'node:test';
import { KernelError } from '#errors';
import { createMemoryBlobStore } from '#kernel/blob-store-memory';
import { createInstance } from '#kernel/instance';
import { drainSession } from '#kernel/session-delivery';
import { scanBudget } from '#kernel/store/contract';
import { createMemoryStore } from '#kernel/store/memory';
import {
  R,
  W,
  type AclEntry,
  type ModuleManifest,
  type Node,
  type OpId,
  type Position,
  type PositionCounter,
  type TypeDef,
  type WriteActionContext,
} from '#kernel/types';

const code = (expected: KernelError['code']) => (error: unknown) =>
  error instanceof KernelError && error.code === expected;

/** Holds a genuine action at an observed event boundary. */
function event() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Installs actual native actions and obtains their caller and node executor through real Sessions. */
async function fixture(
  t: TestContext,
  actions: TypeDef['actions'],
  ordinary: TypeDef['actions'] = {},
) {
  const id = `write-rights:${randomUUID()}`;
  const root = createMemoryStore({ domain: id });
  let saved: Position | undefined;
  let epoch = 0;
  const counter: PositionCounter = {
    /** Restores the latest accepted writer position in this fixture. */
    async load() {
      return saved;
    },
    /** Retains a committed position for the next writer operation. */
    async save(position) {
      saved = position;
    },
    /** Issues a fresh test epoch above the persisted floor. */
    async freshEpoch(floor) {
      epoch = Math.max(epoch, floor) + 1;
      return epoch;
    },
  };
  const module: ModuleManifest = {
    id: 'write-rights',
    security: [],
    open: [],
    types: [
      {
        name: 'write-rights.form',
        module: 'write-rights',
        security: 'user-capability',
        version: 0,
        schema: {},
        actions,
      },
      {
        name: 'write-rights.worker',
        module: 'write-rights',
        security: 'ordinary',
        version: 0,
        schema: {},
        actions: ordinary,
      },
    ],
  };
  const instance = await createInstance({
    id,
    root: { kind: 'store', store: root },
    modules: [module],
    blobs: createMemoryBlobStore(),
    provisioning: {
      counter,
      writerEpoch: 1,
      domains: [{ store: root, epoch: randomUUID(), persistent: false }],
      credentialTtlMs: 60_000,
      bootstrap: {
        kind: 'fresh',
        admin: { path: '/admin', name: 'admin', password: randomUUID() },
      },
    },
  });
  const deliveries: Promise<void>[] = [];
  t.after(async () => {
    await instance.close();
    await Promise.all(deliveries);
  });
  assert.ok(instance.setupCredential);
  const admin = await instance.openSession(instance.setupCredential);
  deliveries.push(drainSession(admin));

  /** Allocates a mutation identifier from this actual Writer's intake. */
  function key(): OpId {
    return { epoch: instance.writer.intake.epoch, time: Date.now(), nonce: randomUUID() };
  }

  /** Reads a node through the genuine administrator's projection. */
  async function node(path: string): Promise<Node> {
    const copy = (await admin.read({ node: path })).copies[0];
    assert.ok('node' in copy);
    return copy.node;
  }

  await admin.commit({
    opId: key(),
    changes: [
      {
        op: 'put',
        node: {
          $path: '/form',
          $type: 'write-rights.form',
          $acl: [{ subject: { group: 'public' }, grant: R }],
        },
      },
      {
        op: 'put',
        node: {
          $path: '/worker',
          $type: 'write-rights.worker',
          $acl: [{ subject: { group: 'public' }, grant: R | W }],
        },
      },
      { op: 'put', node: { $path: '/box', $type: 't.dir' } },
      { op: 'put', node: { $path: '/box/existing', $type: 't.dir', value: 'accepted' } },
    ],
  }).outcome;
  const form = await node('/form');
  const principal = `n:${form.$id}`;
  const caller = await instance.openSession();
  deliveries.push(drainSession(caller));

  /** Pins the real recipient configuration when authorizing a destination. */
  async function grant(path: string, bits: number, publicBits = 0) {
    const acl: AclEntry[] = [];
    if (bits !== 0) acl.push({ subject: { group: principal }, grant: bits });
    if (publicBits !== 0) acl.push({ subject: { group: 'public' }, grant: publicBits });
    await admin.commit({
      opId: key(),
      expect: { nodes: [{ path: '/form', rev: (await node('/form')).$rev }] },
      changes: [{ op: 'patch', path, ops: { $set: { $acl: acl } } }],
    }).outcome;
  }

  /** Captures accepted images and decisions, excluding abandoned reservation gaps. */
  async function accepted() {
    return {
      nodes: (await root.scan({ range: { subtree: '/' }, budget: scanBudget() })).items,
      journal: (await root.scan({ range: { journal: '/' }, budget: scanBudget() })).items,
    };
  }

  /** Invokes the configured action with the actual R-only caller. */
  function act(action = 'submit', path = '/form') {
    return caller.act({ path, action, args: {}, opId: key() });
  }
  return { instance, root, admin, caller, principal, key, node, grant, accepted, act, deliveries };
}

describe('writing action destination authorization', { timeout: 30_000 }, () => {
  it('keeps the authorization method off real read action contexts', async (t) => {
    const f = await fixture(t, {
      submit: { kind: 'setuid', args: {}, handler: async () => undefined },
      inspect: {
        kind: 'read',
        args: {},
        handler: async (ctx) => Object.hasOwn(ctx, 'requireReadWrite'),
      },
    });
    assert.equal((await f.act('inspect').outcome).value, false);
  });

  it('authorizes an absent R+W destination without requiring the executor to read its own form', async (t) => {
    const f = await fixture(t, {
      submit: {
        kind: 'setuid',
        args: {},
        handler: async (ctx) => {
          assert.equal(await ctx.requireReadWrite('/box/new'), undefined);
          ctx.change.put({ $path: '/box/new', $type: 't.dir' });
          return { caller: ctx.caller.principal, executor: ctx.executor.principal };
        },
      },
    });
    await f.grant('/box', R | W);
    const executor = await f.instance.openNodeSession('/form');
    f.deliveries.push(drainSession(executor));
    await assert.rejects(executor.read({ node: '/form' }), code('NOT_FOUND'));
    executor.close();
    const result = await f.act().outcome;
    assert.deepEqual(result.value, { caller: f.caller.actor.principal, executor: f.principal });
    assert.equal((await f.node('/box/new')).$type, 't.dir');
    const decision = (await f.accepted()).journal.find(
      (record) => record.pos.seq === result.pos?.seq,
    );
    assert.ok(decision);
    assert.equal(decision.caller, f.caller.actor.principal);
    assert.equal(decision.executor, f.principal);
    await assert.rejects(
      f.caller.commit({
        opId: f.key(),
        changes: [{ op: 'put', node: { $path: '/box/direct', $type: 't.dir' } }],
      }).outcome,
      code('FORBIDDEN'),
    );
  });

  it('authorizes an existing destination by its own R+W grant even when its parent is unreadable', async (t) => {
    const f = await fixture(t, {
      submit: {
        kind: 'setuid',
        args: {},
        handler: async (ctx) => {
          await ctx.requireReadWrite('/box/existing');
        },
      },
    });
    await f.grant('/box/existing', R | W);
    const before = await f.node('/box/existing');
    assert.equal((await f.act().outcome).value, undefined);
    assert.deepEqual(await f.node('/box/existing'), before);
  });

  it('refuses missing R or W uniformly on absent and existing destinations without changing read concealment', async (t) => {
    for (const bits of [R, W]) {
      for (const path of ['/box/new', '/box/existing']) {
        const f = await fixture(t, {
          submit: {
            kind: 'setuid',
            args: {},
            handler: async (ctx) => {
              await ctx.requireReadWrite(path);
              ctx.change.put({ $path: '/box/effect', $type: 't.dir' });
            },
          },
        });
        await f.grant('/box', bits);
        const executor = await f.instance.openNodeSession('/form');
        f.deliveries.push(drainSession(executor));
        if (bits === W || path.endsWith('/new'))
          await assert.rejects(executor.read({ node: path }), code('NOT_FOUND'));
        else assert.ok('node' in (await executor.read({ node: path })).copies[0]);
        executor.close();
        const before = await f.accepted();
        await assert.rejects(f.act().outcome, code('FORBIDDEN'));
        assert.deepEqual(await f.accepted(), before);
      }
    }
  });

  it('binds ordinary writing authorization to its genuine caller rather than to a node principal', async (t) => {
    const f = await fixture(
      t,
      { submit: { kind: 'setuid', args: {}, handler: async () => undefined } },
      {
        submit: {
          kind: 'write',
          args: {},
          handler: async (ctx) => {
            await ctx.requireReadWrite('/box/new');
            ctx.change.put({ $path: '/box/new', $type: 't.dir' });
            return ctx.executor.principal;
          },
        },
      },
    );
    await f.grant('/box', R | W, R);
    const before = await f.accepted();
    await assert.rejects(f.act('submit', '/worker').outcome, code('FORBIDDEN'));
    assert.deepEqual(await f.accepted(), before);
    await f.grant('/box', 0, R | W);
    assert.equal((await f.act('submit', '/worker').outcome).value, f.caller.actor.principal);
    assert.equal((await f.node('/box/new')).$type, 't.dir');
  });

  it('rejects a no-op after destination rights change while its handler is held', async (t) => {
    const entered = event();
    const release = event();
    t.after(release.resolve);
    const f = await fixture(t, {
      submit: {
        kind: 'setuid',
        args: {},
        handler: async (ctx) => {
          await ctx.requireReadWrite('/box/existing');
          entered.resolve();
          await release.promise;
        },
      },
    });
    await f.grant('/box', R | W);
    const pending = f.act();
    await entered.promise;
    await f.grant('/box', W);
    const afterRevocation = await f.accepted();
    release.resolve();
    await assert.rejects(pending.outcome, code('CONFLICT'));
    assert.deepEqual(await f.accepted(), afterRevocation);
  });

  it('revokes escaped authorization after completion and after caller cancellation', async (t) => {
    for (const cancelled of [false, true]) {
      const entered = event();
      const release = event();
      t.after(release.resolve);
      let escaped: WriteActionContext['requireReadWrite'] | undefined;
      const f = await fixture(t, {
        submit: {
          kind: 'setuid',
          args: {},
          handler: async (ctx) => {
            escaped = ctx.requireReadWrite;
            await ctx.requireReadWrite('/box/existing');
            entered.resolve();
            await release.promise;
          },
        },
      });
      await f.grant('/box', R | W);
      const before = await f.accepted();
      const pending = f.act();
      await entered.promise;
      if (cancelled) {
        f.caller.cancel(pending.id);
        await assert.rejects(pending.outcome, code('CANCELLED'));
        assert.deepEqual(await f.accepted(), before);
      } else {
        release.resolve();
        assert.equal((await pending.outcome).value, undefined);
      }
      assert.ok(escaped);
      await assert.rejects(escaped('/box/existing'), code('INVALID'));
      release.resolve();
    }
  });

  it('uses one bounded authorization work allowance across repeated metadata assertions', async (t) => {
    let completed = 0;
    const f = await fixture(t, {
      submit: {
        kind: 'setuid',
        args: {},
        handler: async (ctx) => {
          for (let index = 0; index < 100; index++) {
            await ctx.requireReadWrite('/box/existing');
            completed++;
          }
          ctx.change.put({ $path: '/box/effect', $type: 't.dir' });
        },
      },
    });
    await f.grant('/box', R | W);
    await f.admin.commit({
      opId: f.key(),
      changes: [{ op: 'patch', path: '/sys/limits', ops: { $set: { exprWork: 1024 } } }],
    }).outcome;
    const before = await f.accepted();
    await assert.rejects(f.act().outcome, code('BUDGET'));
    assert.ok(completed > 1 && completed < 100);
    assert.deepEqual(await f.accepted(), before);
  });

  it('refuses an executor-hidden destination before charging its large payload', async (t) => {
    const f = await fixture(t, {
      submit: {
        kind: 'setuid',
        args: {},
        handler: async (ctx) => {
          await ctx.requireReadWrite('/box/existing');
        },
      },
    });
    await f.grant('/box', W);
    await f.admin.commit({
      opId: f.key(),
      changes: [
        { op: 'patch', path: '/box/existing', ops: { $set: { payload: 'secret'.repeat(4096) } } },
        { op: 'patch', path: '/sys/limits', ops: { $set: { readBytes: 1024 } } },
      ],
    }).outcome;
    const before = await f.accepted();
    await assert.rejects(f.act().outcome, code('FORBIDDEN'));
    assert.deepEqual(await f.accepted(), before);
  });

  it('keeps an exhausted operation budget fatal when its handler catches the assertion error', async (t) => {
    for (const writes of [false, true]) {
      let caught = false;
      const f = await fixture(t, {
        submit: {
          kind: 'setuid',
          args: {},
          handler: async (ctx) => {
            try {
              for (let index = 0; index < 100; index++) await ctx.requireReadWrite('/box/existing');
            } catch (error) {
              if (!(error instanceof KernelError) || error.code !== 'BUDGET') throw error;
              caught = true;
            }
            if (writes) ctx.change.put({ $path: '/box/effect', $type: 't.dir' });
          },
        },
      });
      await f.grant('/box', R | W);
      await f.admin.commit({
        opId: f.key(),
        changes: [{ op: 'patch', path: '/sys/limits', ops: { $set: { exprWork: 1024 } } }],
      }).outcome;
      const before = await f.accepted();
      await assert.rejects(f.act().outcome, code('BUDGET'));
      assert.equal(caught, true);
      assert.deepEqual(await f.accepted(), before);
    }
  });

  it('cancels authorization queued behind a real accepted Writer operation without releasing effects', async (t) => {
    const entered = event();
    const beginAssertion = event();
    const asserting = event();
    const durable = event();
    const publish = event();
    t.after(() => {
      beginAssertion.resolve();
      publish.resolve();
    });
    const f = await fixture(t, {
      submit: {
        kind: 'setuid',
        args: {},
        handler: async (ctx) => {
          entered.resolve();
          await beginAssertion.promise;
          const assertion = ctx.requireReadWrite('/box/new');
          asserting.resolve();
          await assertion;
          ctx.change.put({ $path: '/box/new', $type: 't.dir' });
        },
      },
    });
    await f.grant('/box', R | W);
    const action = f.act();
    await entered.promise;
    const persist = f.root.commit.bind(f.root);
    const blockingKey = f.key();
    t.mock.method(f.root, 'commit', async (commit: Parameters<typeof persist>[0]) => {
      await persist(commit);
      if (commit.record.decision?.opId.nonce === blockingKey.nonce) {
        durable.resolve();
        await publish.promise;
      }
    });
    const blocking = f.admin.commit({
      opId: blockingKey,
      changes: [{ op: 'put', node: { $path: '/unrelated', $type: 't.dir' } }],
    });
    await durable.promise;
    beginAssertion.resolve();
    await asserting.promise;
    f.caller.cancel(action.id);
    await assert.rejects(action.outcome, code('CANCELLED'));
    publish.resolve();
    assert.ok((await blocking.outcome).pos);
    await assert.rejects(f.admin.read({ node: '/box/new' }), code('NOT_FOUND'));
    assert.equal(
      (await f.accepted()).journal.some(
        (record) => record.decision?.opId.nonce === blockingKey.nonce,
      ),
      true,
    );
  });

  it('rejects invalid logical destination addresses before any accepted effect', async (t) => {
    const f = await fixture(t, {
      submit: {
        kind: 'setuid',
        args: {},
        handler: async (ctx) => {
          await ctx.requireReadWrite('/../outside');
          ctx.change.put({ $path: '/box/effect', $type: 't.dir' });
        },
      },
    });
    await f.grant('/box', R | W);
    const before = await f.accepted();
    await assert.rejects(f.act().outcome, code('INVALID'));
    assert.deepEqual(await f.accepted(), before);
  });
});
