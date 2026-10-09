import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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
import { createMemoryStore } from '#kernel/store/memory';
import {
  R,
  W,
  A,
  type Credential,
  type OpId,
  type Position,
  type PositionCounter,
  type Node,
  type Pending,
  type ReadActionContext,
  type TypeDef,
} from '#kernel/types';

const workerType = 'history-contract.worker';
const workerPath = '/work/worker';
const historyPath = '/work/items';
const formType = 'history-contract.form';
const formPath = '/forms/form';
const recordType = 'history-contract.record';
const code = (expected: KernelError['code']) => (error: unknown) =>
  error instanceof KernelError && error.code === expected;

/** Holds a real handler boundary until the test changes accepted state. */
function event() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Propagates a genuine early refusal instead of waiting forever for the handler. */
async function reached(pending: Pending, boundary: ReturnType<typeof event>): Promise<void> {
  await Promise.race([
    boundary.promise,
    pending.outcome.then(() => {
      throw new Error('The action completed before its observed boundary');
    }),
  ]);
}

/** Collects a native module and opens credential Sessions through the canonical factory. */
async function fixture(
  t: TestContext,
  actions: TypeDef['actions'],
  forms: TypeDef['actions'] = {},
) {
  const module = await collectModule(`history-contract:${randomUUID()}`, () => {
    register(workerType, 'schema', () => ({
      $id: workerType,
      type: 'object',
      properties: { count: { type: 'number' } },
    }));
    for (const [name, action] of Object.entries(actions))
      registerKernelAction(workerType, name, action);
    register(recordType, 'schema', () => ({ $id: recordType, type: 'object', properties: {} }));
    class HistoryForm {
      count = 0;
    }
    registerType(formType, HistoryForm, { security: 'user-capability' });
    register(formType, 'schema', () => ({ $id: formType, type: 'object', properties: {} }));
    for (const [name, action] of Object.entries(forms))
      registerKernelAction(formType, name, action);
  });
  const id = `history-contract:${randomUUID()}`;
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
    unregister(workerType, 'schema');
    unregister(recordType, 'schema');
    unregister(formType, 'schema');
    unregister(formType, 'class');
  });

  /** Captures the real welcome intake before pumping ordinary frames and completion. */
  async function open(credential?: Credential) {
    const session = await instance.openSession(credential);
    const welcome = await session.lane[Symbol.asyncIterator]().next();
    assert.ok(!welcome.done && welcome.value.t === 'welcome');
    const intake = welcome.value.intake;
    deliveries.push(drainSession(session));
    return {
      session,
      key(): OpId {
        return { epoch: intake, time: Date.now(), nonce: randomUUID() };
      },
    };
  }
  assert.ok(instance.setupCredential);
  const { session: admin, key } = await open(instance.setupCredential);
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
      { op: 'put', node: { $path: historyPath, $type: 't.dir' } },
      { op: 'put', node: { $path: `${historyPath}/first`, $type: recordType, value: 1 } },
      { op: 'put', node: { $path: '/other', $type: 't.dir' } },
      {
        op: 'put',
        node: {
          $path: '/effects',
          $type: 't.dir',
          $acl: [{ subject: { group: 'public' }, grant: R | W }],
        },
      },
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

  /** Reads an asserted visible image through the actual administrator Session. */
  async function node(path: string): Promise<Node> {
    const copy = (await admin.read({ node: path })).copies[0];
    assert.ok('node' in copy);
    return copy.node;
  }

  /** Grants the form's strongly identified principal under its exact recipient revision. */
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
  return { instance, root, module, admin, key, open, node, grant };
}

describe('history reads through native actions', { timeout: 10_000 }, () => {
  it('returns the same authorized history as the executor Session Reader', async (t) => {
    const f = await fixture(t, {
      inspect: {
        kind: 'read',
        args: {},
        handler: async (ctx) => ctx.read.read({ history: historyPath }),
      },
    });
    const expected = await f.admin.read({ history: historyPath });
    assert.ok(expected.history && expected.history.length >= 2);
    const result = await f.admin.act({ path: workerPath, action: 'inspect', args: {} }).outcome;
    assert.deepEqual(result.value, expected);
  });

  it('injects a relative history need without turning its recorded images into post targets', async (t) => {
    let injected: unknown;
    const f = await fixture(t, {
      inspect: {
        kind: 'read',
        args: {},
        needs: { audit: { history: '../items' } },
        handler: async (ctx) => {
          injected = ctx.needs.audit;
          return ctx.needs.audit;
        },
      },
      increment: {
        kind: 'write',
        args: {},
        needs: { audit: { history: '../items' } },
        post: { '': { $inc: { count: 1 } } },
      },
      rewrite: {
        kind: 'write',
        args: {},
        needs: { audit: { history: '../items' } },
        post: { audit: { $set: { value: 9 } } },
      },
    });
    const expected = await f.admin.read({ history: historyPath });
    const read = await f.admin.act({ path: workerPath, action: 'inspect', args: {} }).outcome;
    assert.deepEqual(read.value, expected);
    assert.deepEqual(injected, expected);
    await f.admin.act({ path: workerPath, action: 'increment', args: {}, opId: f.key() }).outcome;
    await assert.rejects(
      f.admin.act({ path: workerPath, action: 'rewrite', args: {}, opId: f.key() }).outcome,
      code('INVALID'),
    );
    assert.equal((await f.node(workerPath)).count, 1);
    assert.equal((await f.node(`${historyPath}/first`)).value, 1);
  });

  for (const [mutation, writing] of [
    ['insert', false],
    ['insert', true],
    ['move', true],
    ['remove', true],
  ] as const) {
    it(`rejects a ${writing ? 'write' : 'read'} history range after an accepted ${mutation}`, async (t) => {
      const entered = event();
      const release = event();
      const capture = async (ctx: ReadActionContext) => {
        await ctx.read.read({ history: historyPath });
        entered.resolve();
        await release.promise;
        return 'complete';
      };
      const f = await fixture(t, {
        inspect: writing
          ? {
              kind: 'write',
              args: {},
              handler: async (ctx) => {
                const value = await capture(ctx);
                ctx.change.put({ $path: '/effects/accepted', $type: 't.dir' });
                return value;
              },
            }
          : { kind: 'read', args: {}, handler: capture },
      });
      const pending = f.admin.act({
        path: workerPath,
        action: 'inspect',
        args: {},
        ...(writing ? { opId: f.key() } : {}),
      });
      const refused = assert.rejects(pending.outcome, code('CONFLICT'));
      await reached(pending, entered);
      await f.admin.commit({
        opId: f.key(),
        changes:
          mutation === 'insert'
            ? [{ op: 'put', node: { $path: `${historyPath}/second`, $type: recordType } }]
            : mutation === 'move'
              ? [{ op: 'move', from: `${historyPath}/first`, to: '/other/moved' }]
              : [{ op: 'remove', path: `${historyPath}/first` }],
      }).outcome;
      release.resolve();
      await refused;
      await assert.rejects(f.admin.read({ node: '/effects/accepted' }), code('NOT_FOUND'));
    });
  }

  it('permits an unrelated change while a history-dependent write is paused', async (t) => {
    const entered = event();
    const release = event();
    const f = await fixture(t, {
      inspect: {
        kind: 'write',
        args: {},
        handler: async (ctx) => {
          const result = await ctx.read.read({ history: historyPath });
          entered.resolve();
          await release.promise;
          ctx.change.put({ $path: '/effects/accepted', $type: 't.dir' });
          return result.history;
        },
      },
    });
    const expected = await f.admin.read({ history: historyPath });
    const pending = f.admin.act({ path: workerPath, action: 'inspect', args: {}, opId: f.key() });
    await reached(pending, entered);
    await f.admin.commit({
      opId: f.key(),
      changes: [{ op: 'put', node: { $path: '/other/unrelated', $type: 't.dir' } }],
    }).outcome;
    release.resolve();
    assert.deepEqual((await pending.outcome).value, expected.history);
    assert.equal((await f.node('/effects/accepted')).$type, 't.dir');
  });

  it('conceals history from a caller with R and W but no current A', async (t) => {
    const f = await fixture(t, {
      inspect: {
        kind: 'read',
        args: {},
        needs: { audit: { history: '../items' } },
        handler: async (ctx) => ({
          direct: await ctx.read.read({ history: historyPath }),
          need: ctx.needs.audit,
        }),
      },
    });
    const { session } = await f.open();
    const expected = await session.read({ history: historyPath });
    assert.deepEqual(expected.history, []);
    const result = await session.act({ path: workerPath, action: 'inspect', args: {} }).outcome;
    assert.deepEqual(result.value, { direct: expected, need: expected });
    assert.ok((await f.admin.read({ history: historyPath })).history?.length);
  });

  it('retains current administrative rights even for a history-dependent no-op', async (t) => {
    const entered = event();
    const release = event();
    const f = await fixture(t, {
      inspect: {
        kind: 'write',
        args: {},
        handler: async (ctx) => {
          await ctx.read.read({ history: historyPath });
          entered.resolve();
          await release.promise;
          return 'complete';
        },
      },
    });
    await f.admin.commit({
      opId: f.key(),
      changes: [
        {
          op: 'patch',
          path: historyPath,
          ops: { $set: { $acl: [{ subject: { group: 'public' }, grant: R | W | A }] } },
        },
      ],
    }).outcome;
    const { session, key } = await f.open();
    const pending = session.act({ path: workerPath, action: 'inspect', args: {}, opId: key() });
    const refused = assert.rejects(pending.outcome, code('CONFLICT'));
    await reached(pending, entered);
    await f.admin.commit({
      opId: f.key(),
      changes: [
        {
          op: 'patch',
          path: historyPath,
          ops: { $set: { $acl: [{ subject: { group: 'public' }, grant: R | W }] } },
        },
      ],
    }).outcome;
    release.resolve();
    await refused;
    assert.deepEqual((await session.read({ history: historyPath })).history, []);
  });

  it('ignores accepted records which remain outside the executor administrative projection', async (t) => {
    const entered = event();
    const release = event();
    const f = await fixture(t, {
      inspect: {
        kind: 'read',
        args: {},
        handler: async (ctx) => {
          const result = await ctx.read.read({ history: '/work' });
          entered.resolve();
          await release.promise;
          return result.history;
        },
      },
    });
    await f.admin.commit({
      opId: f.key(),
      changes: [
        {
          op: 'patch',
          path: historyPath,
          ops: { $set: { $acl: [{ subject: { group: 'public' }, grant: R | W | A }] } },
        },
      ],
    }).outcome;
    const { session } = await f.open();
    const expected = await session.read({ history: '/work' });
    assert.ok(expected.history?.length);
    const pending = session.act({ path: workerPath, action: 'inspect', args: {} });
    await reached(pending, entered);
    await f.admin.commit({
      opId: f.key(),
      changes: [{ op: 'put', node: { $path: '/work/hidden', $type: recordType, secret: true } }],
    }).outcome;
    release.resolve();
    assert.deepEqual((await pending.outcome).value, expected.history);
    assert.ok(
      (await f.admin.read({ history: '/work' })).history?.some(
        (entry) => entry.path === '/work/hidden',
      ),
    );
  });

  it('uses the node executor for setuid history and a nested history read', async (t) => {
    const f = await fixture(
      t,
      {
        inspect: {
          kind: 'read',
          args: {},
          handler: async (ctx) => ({
            principal: ctx.executor.principal,
            history: (await ctx.read.read({ history: '/work' })).history,
          }),
        },
      },
      {
        inspect: {
          kind: 'setuid',
          args: {},
          handler: async (ctx) => ({
            caller: ctx.caller.principal,
            executor: ctx.executor.principal,
            history: (await ctx.read.read({ history: '/work' })).history,
            inner: await ctx.act({ path: workerPath, action: 'inspect', args: {} }),
          }),
        },
      },
    );
    await f.grant(historyPath, R | A);
    await f.grant(workerPath, R);
    await f.admin.commit({
      opId: f.key(),
      changes: [{ op: 'put', node: { $path: '/work/hidden', $type: recordType, secret: true } }],
    }).outcome;
    const nodeSession = await f.instance.openNodeSession(formPath);
    const expected = await nodeSession.read({ history: '/work' });
    assert.ok(expected.history?.length);
    nodeSession.close();
    const principal = `n:${(await f.node(formPath)).$id}`;
    const result = await f.admin.act({ path: formPath, action: 'inspect', args: {}, opId: f.key() })
      .outcome;
    assert.deepEqual(result.value, {
      caller: f.admin.actor.principal,
      executor: principal,
      history: expected.history,
      inner: { principal, history: expected.history },
    });
    assert.ok(expected.history?.every((entry) => entry.path.startsWith(historyPath)));
    assert.ok(
      (await f.admin.read({ history: '/work' })).history?.some(
        (entry) => entry.path === '/work/hidden',
      ),
    );
  });

  it('refuses stale history after a published type rule removes A from its recorded images', async (t) => {
    const entered = event();
    const release = event();
    const f = await fixture(t, {
      inspect: {
        kind: 'read',
        args: {},
        handler: async (ctx) => {
          const result = await ctx.read.read({ history: historyPath });
          entered.resolve();
          await release.promise;
          return result.history;
        },
      },
    });
    assert.ok(
      (await f.admin.read({ history: historyPath })).history?.some((entry) =>
        entry.path.endsWith('/first'),
      ),
    );
    const pending = f.admin.act({ path: workerPath, action: 'inspect', args: {} });
    const refused = assert.rejects(pending.outcome, code('CONFLICT'));
    await reached(pending, entered);
    f.instance.registry.publish({
      ...f.module,
      security: [{ type: recordType, context: 'acl', handler: () => R | W }],
    });
    release.resolve();
    await refused;
    const after = await f.admin.read({ history: historyPath });
    assert.ok(after.history?.length);
    assert.equal(
      after.history?.some((entry) => entry.path.endsWith('/first')),
      false,
    );
  });

  for (const writes of [false, true]) {
    it(`latches caught history request exhaustion before ${writes ? 'effects' : 'a no-op result'}`, async (t) => {
      let caught = false;
      const f = await fixture(t, {
        inspect: {
          kind: 'write',
          args: {},
          handler: async (ctx) => {
            for (let count = 0; count < 100; count++) {
              try {
                await ctx.read.read({ history: historyPath });
              } catch (error) {
                assert.ok(code('BUDGET')(error));
                caught = true;
                break;
              }
            }
            if (writes) ctx.change.put({ $path: '/effects/accepted', $type: 't.dir' });
            return 'complete';
          },
        },
      });
      await f.admin.commit({
        opId: f.key(),
        changes: [
          {
            op: 'patch',
            path: '/sys/limits',
            ops: { $set: { requestBytes: 1024, readNodes: 10_000 } },
          },
        ],
      }).outcome;
      await assert.rejects(
        f.admin.act({ path: workerPath, action: 'inspect', args: {}, opId: f.key() }).outcome,
        code('BUDGET'),
      );
      assert.equal(caught, true);
      await assert.rejects(f.admin.read({ node: '/effects/accepted' }), code('NOT_FOUND'));
    });
  }

  it('cancels a paused history-dependent write before any accepted effect', async (t) => {
    const entered = event();
    const release = event();
    const f = await fixture(t, {
      inspect: {
        kind: 'write',
        args: {},
        handler: async (ctx) => {
          await ctx.read.read({ history: historyPath });
          entered.resolve();
          await release.promise;
          ctx.change.put({ $path: '/effects/accepted', $type: 't.dir' });
        },
      },
    });
    const pending = f.admin.act({ path: workerPath, action: 'inspect', args: {}, opId: f.key() });
    const refused = assert.rejects(pending.outcome, code('CANCELLED'));
    await reached(pending, entered);
    f.admin.cancel(pending.id);
    await refused;
    release.resolve();
    await assert.rejects(f.admin.read({ node: '/effects/accepted' }), code('NOT_FOUND'));
  });

  it('starts a fresh history read set when a read stream resumes', async (t) => {
    const release = event();
    const f = await fixture(t, {
      inspect: {
        kind: 'read',
        args: {},
        handler: async function* (ctx) {
          const read = ctx.read;
          yield (await read.read({ history: historyPath })).history?.length;
          await release.promise;
          return read.read({ history: historyPath });
        },
      },
    });
    const before = await f.admin.read({ history: historyPath });
    const pending = f.admin.act({ path: workerPath, action: 'inspect', args: {} });
    const pieces = pending.chunks[Symbol.asyncIterator]();
    assert.deepEqual(await pieces.next(), { done: false, value: before.history?.length });
    await f.admin.commit({
      opId: f.key(),
      changes: [{ op: 'put', node: { $path: `${historyPath}/second`, $type: recordType } }],
    }).outcome;
    const after = await f.admin.read({ history: historyPath });
    release.resolve();
    assert.equal((await pieces.next()).done, true);
    assert.deepEqual((await pending.outcome).value, after);
  });

  it('uses genuine mounted filesystem history and opaque cursors through a relative need', async (t) => {
    const type = 'history-contract.fs-worker';
    const module = await collectModule(`history-fs:${randomUUID()}`, () => {
      register(type, 'schema', () => ({ $id: type, type: 'object', properties: {} }));
      registerKernelAction(type, 'inspect', {
        kind: 'read',
        args: {},
        needs: { audit: { history: '../data', window: { limit: 1 } } },
        handler: async (ctx) => {
          assert.ok(ctx.needs.audit.next);
          return {
            first: await ctx.read.read({ history: '/data', window: { limit: 1 } }),
            need: ctx.needs.audit,
            second: await ctx.read.read({
              history: '/data',
              window: { limit: 1, after: ctx.needs.audit.next },
            }),
          };
        },
      });
    });
    const parent = fileURLToPath(
      new URL('../../../../../temp/k32-action-history-fs/', import.meta.url),
    );
    await mkdir(parent, { recursive: true });
    const directory = await mkdtemp(join(parent, 'instance-'));
    const data = join(directory, 'data');
    await mkdir(data);
    await writeFile(join(data, 'doc.json'), JSON.stringify({ $type: 't.dir', value: 1 }));
    const config = {
      id: `history-fs:${randomUUID()}`,
      directory: join(directory, 'root'),
      modules: [module],
      mountDirectories: { data },
      credentialTtlMs: 60_000,
      firstAdmin: { path: '/admin', name: 'admin', password: randomUUID() },
    };
    let runtime = await openNativeRuntime(config);
    const pumps: Promise<void>[] = [];
    t.after(async () => {
      await runtime.close();
      await Promise.all(pumps);
      unregister(type, 'schema');
    });

    /** Reads the actual durable welcome and owns its completion pump. */
    async function open(credential: Credential) {
      const session = await runtime.instance.openSession(credential);
      const welcome = await session.lane[Symbol.asyncIterator]().next();
      assert.ok(!welcome.done && welcome.value.t === 'welcome');
      const intake = welcome.value.intake;
      pumps.push(drainSession(session));
      return {
        session,
        key(): OpId {
          return { epoch: intake, time: Date.now(), nonce: randomUUID() };
        },
      };
    }
    assert.ok(runtime.instance.setupCredential);
    const credential = runtime.instance.setupCredential;
    const first = await open(credential);
    await first.session.commit({
      opId: first.key(),
      changes: [
        { op: 'put', node: { $path: '/worker', $type: type } },
        {
          op: 'put',
          node: {
            $path: '/data',
            $type: 't.dir',
            '#mount': { $type: 't.mount.fs', pattern: '', directory: 'data', external: 'none' },
            '#groups': { $type: 't.groups', list: ['admins'] },
          },
        },
      ],
    }).outcome;
    await runtime.close();
    runtime = await openNativeRuntime({ ...config, firstAdmin: undefined });
    const current = await open(credential);
    const before = (await current.session.read({ node: '/data/doc' })).copies[0];
    assert.ok('node' in before);
    assert.equal(before.node.$id, 'p:/data/doc');
    for (let count = 0; count < 2; count++)
      await current.session.commit({
        opId: current.key(),
        changes: [{ op: 'patch', path: '/data/doc', ops: { $inc: { value: 1 } } }],
      }).outcome;
    const firstPage = await current.session.read({ history: '/data', window: { limit: 1 } });
    assert.ok(firstPage.next);
    assert.equal(firstPage.history?.length, 1);
    const secondPage = await current.session.read({
      history: '/data',
      window: { limit: 1, after: firstPage.next },
    });
    assert.equal(secondPage.history?.length, 1);
    assert.notDeepEqual(secondPage.history?.[0].address.pos, firstPage.history?.[0].address.pos);
    assert.equal(firstPage.history?.[0].address.id, 'p:/data/doc');
    const result = await current.session.act({ path: '/worker', action: 'inspect', args: {} })
      .outcome;
    assert.deepEqual(result.value, { first: firstPage, need: firstPage, second: secondPage });
    const complete = await current.session.read({ history: '/data' });
    assert.ok(complete.history?.some((entry) => entry.after !== null && entry.after.value === 3));
    await runtime.close();
    runtime = await openNativeRuntime({ ...config, firstAdmin: undefined });
    const reopened = await open(credential);
    const persisted = await reopened.session.read({ history: '/data' });
    assert.deepEqual(persisted.history, complete.history);
  });
});

it('keeps a move hidden from history when the executor lacks A at its old address', async (t) => {
  const entered = event(),
    release = event();
  const f = await fixture(t, {
    inspect: {
      kind: 'read',
      args: {},
      handler: async (ctx) => {
        const result = await ctx.read.read({ history: historyPath });
        entered.resolve();
        await release.promise;
        return result.history;
      },
    },
  });
  await f.admin.commit({
    opId: f.key(),
    changes: [
      {
        op: 'patch',
        path: historyPath,
        ops: { $set: { $acl: [{ subject: { group: 'public' }, grant: R | W | A }] } },
      },
      { op: 'put', node: { $path: '/other/secret', $type: recordType, value: 42 } },
    ],
  }).outcome;
  const { session } = await f.open();
  const expected = await session.read({ history: historyPath });
  assert.ok(expected.history && expected.history.length > 0);
  const pending = session.act({ path: workerPath, action: 'inspect', args: {} });
  const final = pending.outcome;
  void final.catch(() => {});
  await reached(pending, entered);
  await f.admin.commit({
    opId: f.key(),
    changes: [{ op: 'move', from: '/other/secret', to: `${historyPath}/moved` }],
  }).outcome;
  const after = await session.read({ history: historyPath });
  assert.deepEqual(after.history, expected.history);
  assert.ok(
    (await f.admin.read({ history: historyPath })).history?.some((entry) =>
      entry.path.endsWith('/moved'),
    ),
  );
  release.resolve();
  assert.deepEqual((await final).value, expected.history);
});

it('keeps a move hidden from history when the executor lacks A at its new address', async (t) => {
  const entered = event(),
    release = event();
  const f = await fixture(t, {
    inspect: {
      kind: 'read',
      args: {},
      handler: async (ctx) => {
        const result = await ctx.read.read({ history: historyPath });
        entered.resolve();
        await release.promise;
        return result.history;
      },
    },
  });
  await f.admin.commit({
    opId: f.key(),
    changes: [
      {
        op: 'patch',
        path: historyPath,
        ops: { $set: { $acl: [{ subject: { group: 'public' }, grant: R | W | A }] } },
      },
      { op: 'put', node: { $path: `${historyPath}/secret`, $type: recordType, value: 42 } },
    ],
  }).outcome;
  const { session } = await f.open();
  const expected = await session.read({ history: historyPath });
  assert.ok(expected.history && expected.history.length > 0);
  const pending = session.act({ path: workerPath, action: 'inspect', args: {} });
  const final = pending.outcome;
  void final.catch(() => {});
  await reached(pending, entered);
  await f.admin.commit({
    opId: f.key(),
    changes: [{ op: 'move', from: `${historyPath}/secret`, to: '/other/moved' }],
  }).outcome;
  const after = await session.read({ history: historyPath });
  assert.deepEqual(after.history, expected.history);
  assert.ok(
    (await f.admin.read({ history: '/' })).history?.some((entry) => entry.path === '/other/moved'),
  );
  release.resolve();
  assert.deepEqual((await final).value, expected.history);
});
