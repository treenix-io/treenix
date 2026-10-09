import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { describe, it, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { registerType } from '#comp';
import { register, unregister } from '#core/registry';
import { KernelError } from '#errors';
import { createMemoryBlobStore } from '#kernel/blob-store-memory';
import { createInstance } from '#kernel/instance';
import { collectModule, registerKernelAction } from '#kernel/manifest';
import { openNativeRuntime } from '#kernel/runtime';
import { drainSession } from '#kernel/session-delivery';
import { scanBudget } from '#kernel/store/contract';
import { createMemoryStore } from '#kernel/store/memory';
import {
  R,
  W,
  type ActionIoScope,
  type Credential,
  type Gate,
  type Io,
  type Node,
  type OpId,
  type Pending,
  type Position,
  type PositionCounter,
  type TypeDef,
  type WriteActionContext,
} from '#kernel/types';

interface ExternalCapability {
  exchange(input: string): Promise<string>;
}
declare module '#kernel/types' {
  interface Io {
    readonly ioContract?: ExternalCapability;
  }
}
const workerType = 'io-contract.worker';
const formType = 'io-contract.form';
const workerPath = '/work/worker';
const formPath = '/forms/form';
const code = (expected: KernelError['code']) => (error: unknown) =>
  error instanceof KernelError && error.code === expected;

/** Holds a genuine external operation at an observed event boundary. */
function event() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Surfaces early kernel refusal instead of waiting indefinitely for a provider. */
async function reached(pending: Pending, observed: ReturnType<typeof event>): Promise<void> {
  await Promise.race([
    observed.promise,
    pending.outcome.then(() => {
      throw new Error('Action completed before its observed boundary');
    }),
  ]);
}

/** Requires this deployment's explicitly typed external capability. */
function external(ctx: WriteActionContext): ExternalCapability {
  assert.ok(ctx.io?.ioContract);
  return ctx.io.ioContract;
}

/** Binds a cooperative external adapter to the actual request authority. */
function provider(
  run: (input: string, scope: ActionIoScope) => Promise<string> = async (input) => input,
) {
  const calls: string[] = [];
  const scopes: ActionIoScope[] = [];
  function bind(scope: ActionIoScope): Io {
    scopes.push(scope);
    return {
      ioContract: {
        async exchange(input) {
          scope.assertActive();
          calls.push(input);
          const result = await run(input, scope);
          scope.assertActive();
          return result;
        },
      },
    };
  }
  return { bind, calls, scopes };
}

/** Uses the supplied real signal to detach an outstanding external exchange. */
function held(entered: ReturnType<typeof event>, release: ReturnType<typeof event>) {
  return async (input: string, scope: ActionIoScope): Promise<string> => {
    entered.resolve();
    let abort: () => void = () => {};
    const ended = new Promise<never>((_resolve, reject) => {
      abort = () => {
        reject(scope.signal.reason);
      };
      scope.signal.addEventListener('abort', abort, { once: true });
      if (scope.signal.aborted) abort();
    });
    try {
      await Promise.race([release.promise, ended]);
      return input;
    } finally {
      scope.signal.removeEventListener('abort', abort);
    }
  };
}

/** Collects real definitions without attaching handlers to an ambient actor. */
async function moduleFor(
  t: TestContext,
  actions: TypeDef['actions'],
  forms: TypeDef['actions'] = {},
) {
  const module = await collectModule(`io-contract:${randomUUID()}`, () => {
    register(workerType, 'schema', () => ({ $id: workerType, type: 'object', properties: {} }));
    for (const [name, action] of Object.entries(actions))
      registerKernelAction(workerType, name, action);
    class IoForm {
      count = 0;
    }
    registerType(formType, IoForm, { security: 'user-capability' });
    register(formType, 'schema', () => ({ $id: formType, type: 'object', properties: {} }));
    for (const [name, action] of Object.entries(forms))
      registerKernelAction(formType, name, action);
  });
  t.after(() => {
    unregister(workerType, 'schema');
    unregister(formType, 'schema');
    unregister(formType, 'class');
  });
  return module;
}

/** Creates genuine caller and admin Sessions through the configured canonical factory. */
async function fixture(
  t: TestContext,
  actions: TypeDef['actions'],
  options: {
    forms?: TypeDef['actions'];
    adapter?: ReturnType<typeof provider>;
    gates?: readonly Gate[];
    unconfigured?: boolean;
  } = {},
) {
  const module = await moduleFor(t, actions, options.forms);
  const id = `io-contract:${randomUUID()}`;
  const root = createMemoryStore({ domain: id });
  let saved: Position | undefined;
  let epoch = 0;
  const counter: PositionCounter = {
    async load() {
      return saved;
    },
    async save(position) {
      saved = position;
    },
    async freshEpoch(floor) {
      epoch = Math.max(epoch, floor) + 1;
      return epoch;
    },
  };
  const adapter = options.adapter ?? provider();
  const instance = await createInstance({
    id,
    root: { kind: 'store', store: root },
    modules: [module],
    blobs: createMemoryBlobStore(),
    io: options.unconfigured ? undefined : adapter.bind,
    gates: options.gates,
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
  async function open(credential?: Credential) {
    const session = await instance.openSession(credential);
    const welcome = await session.lane[Symbol.asyncIterator]().next();
    assert.ok(!welcome.done && welcome.value.t === 'welcome');
    const intake = welcome.value.intake;
    deliveries.push(drainSession(session));
    return {
      session,
      credential: welcome.value.credential,
      key(): OpId {
        return { epoch: intake, time: Date.now(), nonce: randomUUID() };
      },
    };
  }
  assert.ok(instance.setupCredential);
  const administrator = await open(instance.setupCredential);
  const admin = administrator.session;
  const key = administrator.key;
  async function node(path: string): Promise<Node> {
    const copy = (await admin.read({ node: path })).copies[0];
    assert.ok('node' in copy);
    return copy.node;
  }
  async function grant(path: string, bits: number) {
    const recipient = await node(formPath);
    const before = await node(path);
    await admin.commit({
      opId: key(),
      expect: { nodes: [{ path: formPath, rev: recipient.$rev }] },
      changes: [
        {
          op: 'patch',
          path,
          ops: {
            $set: {
              $acl: [
                ...(before.$acl ?? []),
                { subject: { group: `n:${recipient.$id}` }, grant: bits },
              ],
            },
          },
        },
      ],
    }).outcome;
  }
  await admin.commit({
    opId: key(),
    changes: [
      {
        op: 'put',
        node: {
          $path: '/work',
          $type: 't.dir',
          $acl: [{ subject: { group: 'public' }, grant: R | W }],
        },
      },
      { op: 'put', node: { $path: workerPath, $type: workerType, count: 0 } },
      { op: 'put', node: { $path: '/work/stock', $type: 't.dir', count: 0 } },
      {
        op: 'put',
        node: {
          $path: '/forms',
          $type: 't.dir',
          $acl: [{ subject: { group: 'public' }, grant: R }],
        },
      },
      { op: 'put', node: { $path: formPath, $type: formType, count: 0 } },
    ],
  }).outcome;
  return { instance, root, admin, key, open, node, grant, adapter };
}

describe('native action I/O', { timeout: 10_000 }, () => {
  it('binds one capability and replays an accepted result without another external invocation', async (t) => {
    let captured: ExternalCapability | undefined;
    const f = await fixture(t, {
      inspect: {
        kind: 'write',
        io: true,
        args: {},
        handler: async (ctx) => {
          captured = external(ctx);
          assert.equal(external(ctx), captured);
          return captured.exchange('configured');
        },
      },
    });
    const caller = await f.open();
    const request = { path: workerPath, action: 'inspect', args: {}, opId: caller.key() };
    const outcome = await caller.session.act(request).outcome;
    assert.equal(outcome.value, 'configured');
    assert.deepEqual(await caller.session.act(request).outcome, outcome);
    await assert.rejects(
      caller.session.act({ ...request, args: { changed: true } }).outcome,
      code('KEY_REUSED'),
    );
    assert.equal(f.adapter.scopes.length, 1);
    assert.deepEqual(f.adapter.calls, ['configured']);
    assert.ok(captured);
    await assert.rejects(captured.exchange('escaped'), code('INVALID'));
    assert.deepEqual(f.adapter.calls, ['configured']);
  });

  it('keeps read and undeclared writing actions free of I/O and refuses an absent provider', async (t) => {
    const actions: TypeDef['actions'] = {
      read: {
        kind: 'read',
        args: {},
        handler: async (ctx) => {
          assert.equal(Object.hasOwn(ctx, 'io'), false);
          return 'read';
        },
      },
      ordinary: {
        kind: 'write',
        args: {},
        handler: async (ctx) => {
          assert.equal(Object.hasOwn(ctx, 'io'), false);
          return 'ordinary';
        },
      },
      external: {
        kind: 'write',
        io: true,
        args: {},
        handler: async (ctx) => external(ctx).exchange('external'),
      },
    };
    const f = await fixture(t, actions);
    const caller = await f.open();
    assert.equal(
      (await caller.session.act({ path: workerPath, action: 'read', args: {} }).outcome).value,
      'read',
    );
    assert.equal(
      (
        await caller.session.act({
          path: workerPath,
          action: 'ordinary',
          args: {},
          opId: caller.key(),
        }).outcome
      ).value,
      'ordinary',
    );
    assert.equal(f.adapter.scopes.length, 0);
    const missing = await fixture(t, actions, { unconfigured: true });
    const visitor = await missing.open();
    await assert.rejects(
      visitor.session.act({ path: workerPath, action: 'external', args: {}, opId: visitor.key() })
        .outcome,
      code('UNAVAILABLE'),
    );
    assert.equal(missing.adapter.calls.length, 0);
  });

  it('does not acquire an external capability for gate, schema, key, precondition or call-rights refusal', async (t) => {
    let refuse = false;
    let bodies = 0;
    const gate: Gate = async (operation) =>
      operation.kind === 'act' && refuse ? { refuse: 'REFUSED' } : 'pass';
    const f = await fixture(
      t,
      {
        run: {
          kind: 'write',
          io: true,
          args: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
          handler: async (ctx) => {
            bodies++;
            return external(ctx).exchange('run');
          },
        },
        pre: {
          kind: 'write',
          io: true,
          args: {},
          pre: { 'node.count': 9 },
          handler: async (ctx) => {
            bodies++;
            return external(ctx).exchange('pre');
          },
        },
      },
      { gates: [gate] },
    );
    const caller = await f.open();
    const request = { path: workerPath, action: 'run', args: { text: 'run' }, opId: caller.key() };
    refuse = true;
    await assert.rejects(caller.session.act(request).outcome, code('REFUSED'));
    refuse = false;
    await assert.rejects(
      caller.session.act({ ...request, opId: caller.key(), args: {} }).outcome,
      code('INVALID'),
    );
    await assert.rejects(
      caller.session.act({ ...request, opId: undefined }).outcome,
      code('INVALID'),
    );
    await assert.rejects(
      caller.session.act({ ...request, action: 'pre', args: {}, opId: caller.key() }).outcome,
      code('CONFLICT'),
    );
    await f.admin.commit({
      opId: f.key(),
      changes: [
        {
          op: 'patch',
          path: '/work',
          ops: { $set: { $acl: [{ subject: { group: 'public' }, grant: R }] } },
        },
      ],
    }).outcome;
    await assert.rejects(
      caller.session.act({ ...request, opId: caller.key() }).outcome,
      code('FORBIDDEN'),
    );
    assert.equal(bodies, 0);
    assert.equal(f.adapter.scopes.length, 0);
    assert.equal(f.adapter.calls.length, 0);
  });

  for (const termination of ['cancel', 'close', 'instance close', 'deadline'] as const) {
    it(`ends the actual external wait on request ${termination} with no late tree effect`, async (t) => {
      const entered = event();
      const release = event();
      t.after(() => release.resolve());
      const adapter = provider(held(entered, release));
      const f = await fixture(
        t,
        {
          run: {
            kind: 'write',
            io: true,
            args: {},
            handler: async (ctx) => {
              await external(ctx).exchange('held');
              ctx.change.put({ $path: '/work/effect', $type: 't.dir' });
            },
          },
        },
        { adapter },
      );
      if (termination === 'deadline') {
        await f.admin.commit({
          opId: f.key(),
          changes: [{ op: 'patch', path: '/sys/limits', ops: { $set: { actionMs: 10 } } }],
        }).outcome;
        t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
      }
      const caller = await f.open();
      const pending = caller.session.act({
        path: workerPath,
        action: 'run',
        args: {},
        opId: caller.key(),
      });
      const refused = assert.rejects(
        pending.outcome,
        code(termination === 'deadline' ? 'BUDGET' : 'CANCELLED'),
      );
      await reached(pending, entered);
      if (termination === 'cancel') caller.session.cancel(pending.id);
      else if (termination === 'close') caller.session.close();
      else if (termination === 'instance close') await f.instance.close();
      else t.mock.timers.tick(11);
      await refused;
      assert.equal(adapter.scopes[0].signal.aborted, true);
      release.resolve();
      assert.deepEqual(
        (await f.root.scan({ range: { node: '/work/effect' }, budget: scanBudget() })).items,
        [],
      );
      assert.deepEqual(adapter.calls, ['held']);
    });
  }

  it('aborts a real HTTP exchange through the provider signal and releases its held response', async (t) => {
    const entered = event();
    const release = event();
    const disconnected = event();
    const server = createServer((_request, response) => {
      response.once('close', disconnected.resolve);
      entered.resolve();
      void release.promise.then(() => response.end('late'));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
      release.resolve();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    });
    const address = server.address();
    assert.ok(address !== null && typeof address !== 'string');
    const adapter = provider(async (input, scope) => {
      const response = await fetch(`http://127.0.0.1:${address.port}`, {
        method: 'POST',
        body: input,
        signal: scope.signal,
      });
      return response.text();
    });
    const f = await fixture(
      t,
      {
        run: {
          kind: 'write',
          io: true,
          args: {},
          handler: async (ctx) => {
            await external(ctx).exchange('held');
            ctx.change.put({ $path: '/work/effect', $type: 't.dir' });
          },
        },
      },
      { adapter },
    );
    const caller = await f.open();
    const pending = caller.session.act({
      path: workerPath,
      action: 'run',
      args: {},
      opId: caller.key(),
    });
    const refused = assert.rejects(pending.outcome, code('CANCELLED'));
    await reached(pending, entered);
    caller.session.cancel(pending.id);
    await refused;
    await disconnected.promise;
    assert.equal(adapter.scopes[0].signal.aborted, true);
    assert.deepEqual(adapter.calls, ['held']);
    await assert.rejects(f.admin.read({ node: '/work/effect' }), code('NOT_FOUND'));
  });

  it('keeps an accepted external outcome when cancellation precedes its publication', async (t) => {
    const accepted = event();
    const publish = event();
    t.after(() => publish.resolve());
    const f = await fixture(t, {
      run: {
        kind: 'write',
        io: true,
        args: {},
        handler: async (ctx) => {
          const value = await external(ctx).exchange('accepted');
          ctx.change.put({ $path: '/work/effect', $type: 't.dir', value });
          return value;
        },
      },
    });
    const caller = await f.open();
    const request = { path: workerPath, action: 'run', args: {}, opId: caller.key() };
    const persist = f.root.commit.bind(f.root);
    t.mock.method(f.root, 'commit', async (commit: Parameters<typeof persist>[0]) => {
      await persist(commit);
      if (
        commit.record.decision?.opId.nonce === request.opId.nonce &&
        commit.record.decision.outcome !== undefined
      ) {
        accepted.resolve();
        await publish.promise;
      }
    });
    const pending = caller.session.act(request);
    await reached(pending, accepted);
    caller.session.cancel(pending.id);
    publish.resolve();
    const outcome = await pending.outcome;
    assert.equal(outcome.value, 'accepted');
    assert.deepEqual(await caller.session.act(request).outcome, outcome);
    assert.equal((await f.node('/work/effect')).value, 'accepted');
    assert.deepEqual(f.adapter.calls, ['accepted']);
  });

  it('does not publish tree effects when external work returns after a captured read changed', async (t) => {
    const entered = event();
    const release = event();
    t.after(() => release.resolve());
    const f = await fixture(
      t,
      {
        run: {
          kind: 'write',
          io: true,
          args: {},
          handler: async (ctx) => {
            await ctx.read.read({ node: '/work/stock' });
            const result = await external(ctx).exchange('held');
            ctx.change.put({ $path: '/work/effect', $type: 't.dir', result });
          },
        },
      },
      { adapter: provider(held(entered, release)) },
    );
    const caller = await f.open();
    const pending = caller.session.act({
      path: workerPath,
      action: 'run',
      args: {},
      opId: caller.key(),
    });
    const refused = assert.rejects(pending.outcome, code('CONFLICT'));
    await reached(pending, entered);
    await f.admin.commit({
      opId: f.key(),
      changes: [{ op: 'patch', path: '/work/stock', ops: { $inc: { count: 1 } } }],
    }).outcome;
    release.resolve();
    await refused;
    await assert.rejects(f.admin.read({ node: '/work/effect' }), code('NOT_FOUND'));
    assert.deepEqual(f.adapter.calls, ['held']);
  });

  it('blocks a captured capability after caught shared budget exhaustion before calling its provider', async (t) => {
    const f = await fixture(t, {
      run: {
        kind: 'write',
        io: true,
        args: {},
        handler: async (ctx) => {
          const capability = external(ctx);
          await assert.rejects(async () => {
            for (;;) await ctx.requireReadWrite('/work/stock');
          }, code('BUDGET'));
          await assert.rejects(capability.exchange('after-budget'), code('BUDGET'));
          return 'caught';
        },
      },
    });
    await f.admin.commit({
      opId: f.key(),
      changes: [{ op: 'patch', path: '/sys/limits', ops: { $set: { exprWork: 1024 } } }],
    }).outcome;
    const caller = await f.open();
    await assert.rejects(
      caller.session.act({ path: workerPath, action: 'run', args: {}, opId: caller.key() }).outcome,
      code('BUDGET'),
    );
    assert.equal(f.adapter.scopes.length, 1);
    assert.deepEqual(f.adapter.calls, []);
    assert.equal((await f.node(workerPath)).count, 0);
  });

  it('keeps one captured capability current across fresh stream frames and denies access while yielded', async (t) => {
    let capability: ExternalCapability | undefined;
    const f = await fixture(t, {
      run: {
        kind: 'write',
        io: true,
        args: {},
        handler: async function* (ctx) {
          capability = external(ctx);
          ctx.change.put({ $path: '/work/first', $type: 't.dir' });
          yield await capability.exchange('first');
          assert.equal(external(ctx), capability);
          ctx.change.put({ $path: '/work/second', $type: 't.dir' });
          return capability.exchange('second');
        },
      },
    });
    const caller = await f.open();
    const pending = caller.session.act({
      path: workerPath,
      action: 'run',
      args: {},
      opId: caller.key(),
    });
    const pieces = pending.chunks[Symbol.asyncIterator]();
    assert.deepEqual(await pieces.next(), { done: false, value: 'first' });
    assert.ok(capability);
    await assert.rejects(capability.exchange('between-frames'), code('INVALID'));
    assert.equal((await pieces.next()).done, true);
    assert.equal((await pending.outcome).value, 'second');
    assert.equal(f.adapter.scopes.length, 1);
    assert.deepEqual(f.adapter.calls, ['first', 'second']);
    assert.ok((await f.node('/work/second')).$id);
  });

  it('retains shared budget refusal in a later stream frame before another external call', async (t) => {
    const f = await fixture(t, {
      run: {
        kind: 'write',
        io: true,
        args: {},
        handler: async function* (ctx) {
          const capability = external(ctx);
          yield await capability.exchange('first');
          await assert.rejects(async () => {
            for (;;) await ctx.requireReadWrite('/work/stock');
          }, code('BUDGET'));
          await assert.rejects(capability.exchange('after-budget'), code('BUDGET'));
          return 'caught';
        },
      },
    });
    await f.admin.commit({
      opId: f.key(),
      changes: [{ op: 'patch', path: '/sys/limits', ops: { $set: { exprWork: 1024 } } }],
    }).outcome;
    const caller = await f.open();
    const pending = caller.session.act({
      path: workerPath,
      action: 'run',
      args: {},
      opId: caller.key(),
    });
    const refused = assert.rejects(pending.outcome, code('BUDGET'));
    const pieces = pending.chunks[Symbol.asyncIterator]();
    assert.deepEqual(await pieces.next(), { done: false, value: 'first' });
    await assert.rejects(pieces.next(), code('BUDGET'));
    await refused;
    assert.deepEqual(f.adapter.calls, ['first']);
  });

  it('uses genuine caller and node executor scopes for nested I/O without sharing capabilities', async (t) => {
    const roles: string[] = [];
    const f = await fixture(
      t,
      {
        inner: {
          kind: 'write',
          io: true,
          args: {},
          handler: async (ctx) => {
            roles.push(ctx.executor.principal);
            return external(ctx).exchange('inner');
          },
        },
        outer: {
          kind: 'write',
          io: true,
          args: {},
          handler: async (ctx) => {
            await external(ctx).exchange('outer');
            return {
              inner: await ctx.act({ path: workerPath, action: 'inner', args: {}, key: 'inner' }),
              form: await ctx.act({ path: formPath, action: 'submit', args: {}, key: 'form' }),
            };
          },
        },
      },
      {
        forms: {
          submit: {
            kind: 'setuid',
            io: true,
            args: {},
            handler: async (ctx) => {
              roles.push(ctx.executor.principal);
              ctx.change.put({ $path: formPath + '/submission', $type: 't.dir' });
              return external(ctx).exchange('form');
            },
          },
        },
      },
    );
    await f.grant(formPath, W);
    const caller = await f.open();
    const request = { path: workerPath, action: 'outer', args: {}, opId: caller.key() };
    const outcome = await caller.session.act(request).outcome;
    assert.deepEqual(outcome.value, { inner: 'inner', form: 'form' });
    assert.deepEqual(await caller.session.act(request).outcome, outcome);
    assert.deepEqual(roles, [caller.session.actor.principal, `n:${(await f.node(formPath)).$id}`]);
    assert.equal(new Set(f.adapter.scopes.map((scope) => scope.signal)).size, 3);
    assert.deepEqual(f.adapter.calls, ['outer', 'inner', 'form']);
  });

  it('aborts actual node executor I/O on capability group revocation without a submission', async (t) => {
    const entered = event();
    const release = event();
    t.after(() => release.resolve());
    const f = await fixture(
      t,
      {},
      {
        adapter: provider(held(entered, release)),
        forms: {
          submit: {
            kind: 'setuid',
            io: true,
            args: {},
            handler: async (ctx) => {
              await external(ctx).exchange('held');
              ctx.change.put({ $path: formPath + '/submission', $type: 't.dir' });
            },
          },
        },
      },
    );
    await f.grant(formPath, W);
    const caller = await f.open();
    const pending = caller.session.act({
      path: formPath,
      action: 'submit',
      args: {},
      opId: caller.key(),
    });
    const refused = assert.rejects(pending.outcome, code('UNAUTHENTICATED'));
    await reached(pending, entered);
    await f.admin.commit({
      opId: f.key(),
      changes: [
        {
          op: 'patch',
          path: formPath,
          ops: { $set: { '#membership': { $type: 't.groups', list: ['agents'] } } },
        },
      ],
    }).outcome;
    await refused;
    assert.equal(f.adapter.scopes[0].signal.aborted, true);
    await assert.rejects(f.admin.read({ node: formPath + '/submission' }), code('NOT_FOUND'));
    assert.deepEqual(f.adapter.calls, ['held']);
  });

  it('inherits cancellation into an actual nested external wait while keeping the caller lane usable', async (t) => {
    const entered = event();
    const release = event();
    t.after(() => release.resolve());
    const f = await fixture(
      t,
      {
        inner: {
          kind: 'write',
          io: true,
          args: {},
          handler: async (ctx) => {
            await external(ctx).exchange('held');
            ctx.change.put({ $path: '/work/effect', $type: 't.dir' });
          },
        },
        outer: {
          kind: 'write',
          io: true,
          args: {},
          handler: async (ctx) => {
            await external(ctx).exchange('outer');
            return ctx.act({ path: workerPath, action: 'inner', args: {}, key: 'inner' });
          },
        },
      },
      {
        adapter: provider(async (input, scope) =>
          input === 'held' ? held(entered, release)(input, scope) : input,
        ),
      },
    );
    const caller = await f.open();
    const pending = caller.session.act({
      path: workerPath,
      action: 'outer',
      args: {},
      opId: caller.key(),
    });
    const refused = assert.rejects(pending.outcome, code('CANCELLED'));
    await reached(pending, entered);
    caller.session.cancel(pending.id);
    await refused;
    assert.ok(f.adapter.scopes.every((scope) => scope.signal.aborted));
    assert.ok((await caller.session.read({ node: workerPath })).copies.length);
    await assert.rejects(f.admin.read({ node: '/work/effect' }), code('NOT_FOUND'));
  });

  it('keeps deployment providers isolated between two canonical instances', async (t) => {
    const first = provider(async (input) => 'first:' + input);
    const second = provider(async (input) => 'second:' + input);
    const actions: TypeDef['actions'] = {
      run: {
        kind: 'write',
        io: true,
        args: {},
        handler: async (ctx) => external(ctx).exchange('value'),
      },
    };
    const a = await fixture(t, actions, { adapter: first });
    const b = await fixture(t, actions, { adapter: second });
    const one = await a.open();
    const two = await b.open();
    assert.equal(
      (
        await one.session.act({ path: workerPath, action: 'run', args: {}, opId: one.key() })
          .outcome
      ).value,
      'first:value',
    );
    assert.equal(
      (
        await two.session.act({ path: workerPath, action: 'run', args: {}, opId: two.key() })
          .outcome
      ).value,
      'second:value',
    );
    assert.deepEqual(first.calls, ['value']);
    assert.deepEqual(second.calls, ['value']);
  });

  it('replays the accepted external outcome after a real filesystem restart without invoking a fresh provider', async (t) => {
    const module = await moduleFor(t, {
      run: {
        kind: 'write',
        io: true,
        args: {},
        handler: async (ctx) => {
          const value = await external(ctx).exchange('persisted');
          ctx.change.put({ $path: '/work/effect', $type: 't.dir', value });
          return value;
        },
      },
    });
    const parent = fileURLToPath(new URL('../../../../../temp/k32-io-fs/', import.meta.url));
    await mkdir(parent, { recursive: true });
    const directory = await mkdtemp(join(parent, 'instance-'));
    const adapter = provider();
    const config = {
      id: `io-fs:${randomUUID()}`,
      directory,
      credentialTtlMs: 60_000,
      modules: [module],
      io: adapter.bind,
      firstAdmin: { path: '/admin', name: 'admin', password: randomUUID() },
    };
    let runtime = await openNativeRuntime(config);
    const deliveries: Promise<void>[] = [];
    t.after(async () => {
      await runtime.close();
      await Promise.all(deliveries);
    });
    assert.ok(runtime.instance.setupCredential);
    const admin = await runtime.instance.openSession(runtime.instance.setupCredential);
    const welcome = await admin.lane[Symbol.asyncIterator]().next();
    assert.ok(!welcome.done && welcome.value.t === 'welcome');
    const intake = welcome.value.intake;
    deliveries.push(drainSession(admin));
    const key = (): OpId => ({ epoch: intake, time: Date.now(), nonce: randomUUID() });
    await admin.commit({
      opId: key(),
      changes: [
        {
          op: 'put',
          node: {
            $path: '/work',
            $type: 't.dir',
            $acl: [{ subject: { group: 'public' }, grant: R | W }],
          },
        },
        { op: 'put', node: { $path: workerPath, $type: workerType } },
      ],
    }).outcome;
    const caller = await runtime.instance.openSession();
    const issued = await caller.lane[Symbol.asyncIterator]().next();
    assert.ok(!issued.done && issued.value.t === 'welcome');
    assert.ok(issued.value.credential);
    const credential = issued.value.credential;
    deliveries.push(drainSession(caller));
    const request = { path: workerPath, action: 'run', args: {}, opId: key() };
    const outcome = await caller.act(request).outcome;
    const decision = await runtime.store.scan({
      range: { decision: { caller: caller.actor.principal, opId: request.opId } },
      budget: scanBudget(),
    });
    assert.deepEqual(decision.items[0].decision?.outcome, outcome);
    assert.deepEqual(adapter.calls, ['persisted']);
    await runtime.close();
    await Promise.all(deliveries);
    const fresh = provider(async () => {
      throw new Error('Accepted replay reached the external provider');
    });
    runtime = await openNativeRuntime({ ...config, firstAdmin: undefined, io: fresh.bind });
    const reopened = await runtime.instance.openSession(credential);
    deliveries.push(drainSession(reopened));
    assert.deepEqual(await reopened.act(request).outcome, outcome);
    await assert.rejects(
      reopened.act({ ...request, args: { changed: true } }).outcome,
      code('KEY_REUSED'),
    );
    const copy = (await reopened.read({ node: '/work/effect' })).copies[0];
    assert.ok('node' in copy);
    assert.equal(copy.node.value, 'persisted');
    assert.equal(fresh.scopes.length, 0);
    assert.equal(fresh.calls.length, 0);
  });
});
