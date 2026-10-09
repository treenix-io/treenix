import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it, type TestContext } from 'node:test';
import { KernelError } from '#errors';
import { createMemoryBlobStore } from '#kernel/blob-store-memory';
import { getActionContext } from '#kernel/current-action';
import { createInstance } from '#kernel/instance';
import { scanBudget } from '#kernel/store/contract';
import { createMemoryStore } from '#kernel/store/memory';
import {
  R,
  W,
  type AclEntry,
  type Credential,
  type Frame,
  type ModuleManifest,
  type Node,
  type ChangeMember,
  type OpId,
  type Outcome,
  type Position,
  type Pending,
  type PositionCounter,
  type Store,
  type TypeDef,
} from '#kernel/types';

const workerPath = '/work/worker';
const formPath = '/forms/form';
const code = (expected: KernelError['code']) => (error: unknown) =>
  error instanceof KernelError && error.code === expected;

/** Holds execution at an observed operation boundary without sleeping. */
function event() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Observes the actual first started step without replacing its persistence. */
function started(t: TestContext, root: Store, key: OpId) {
  const accepted = event();
  const persist = root.commit.bind(root);
  t.mock.method(root, 'commit', async (commit: Parameters<typeof persist>[0]) => {
    await persist(commit);
    if (
      commit.record.decision?.opId.nonce === key.nonce &&
      commit.record.decision.outcome === undefined
    )
      accepted.resolve();
  });
  return accepted;
}

/** Propagates a real refusal rather than leaving an event wait pending. */
async function reached(pending: Pending, observed: ReturnType<typeof event>): Promise<void> {
  await Promise.race([
    observed.promise,
    pending.outcome.then(() => {
      throw new Error('The action completed before its expected boundary');
    }),
  ]);
}

/** Consumes the direct request's single piece slot through its actual final decision. */
async function completed(pending: Pending): Promise<{ pieces: unknown[]; outcome: Outcome }> {
  const pieces: unknown[] = [];
  for await (const piece of pending.chunks) pieces.push(piece);
  return { pieces, outcome: await pending.outcome };
}

/** Installs real native stream handlers and opens actual credential Sessions. */
async function fixture(
  t: TestContext,
  actions: TypeDef['actions'],
  forms: TypeDef['actions'] = {},
) {
  const id = `stream:${randomUUID()}`;
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
  const module: ModuleManifest = {
    id: 'streams',
    security: [],
    open: [],
    types: [
      {
        name: 'streams.worker',
        module: 'streams',
        security: 'ordinary',
        version: 0,
        schema: {},
        actions,
      },
      {
        name: 'streams.form',
        module: 'streams',
        security: 'user-capability',
        version: 0,
        schema: {},
        actions: forms,
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

  /** Pumps ordinary frames and completion while direct Pending.chunks owns its pieces. */
  async function open(credential?: Credential, expectedTermination?: KernelError['code']) {
    const session = await instance.openSession(credential);
    const frames: Frame[] = [];
    const welcome = await session.lane[Symbol.asyncIterator]().next();
    assert.ok(!welcome.done && welcome.value.t === 'welcome');
    const issued = welcome.value.credential;
    const delivery = (async () => {
      for await (const frame of session.lane) frames.push(frame);
    })();
    deliveries.push(
      delivery.catch((error) => {
        if (expectedTermination === undefined) throw error;
        assert.ok(code(expectedTermination)(error));
      }),
    );
    return { session, frames, credential: issued };
  }
  assert.ok(instance.setupCredential);
  const admin = (await open(instance.setupCredential)).session;

  /** Uses this actual Writer's current intake for each client mutation. */
  function key(): OpId {
    return { epoch: instance.writer.intake.epoch, time: Date.now(), nonce: randomUUID() };
  }

  /** Reads an expected visible node through the administrator's genuine Reader. */
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
          $path: '/work',
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
      {
        op: 'put',
        node: { $path: workerPath, $type: 'streams.worker', count: 0, settings: { count: 0 } },
      },
      { op: 'put', node: { $path: formPath, $type: 'streams.form' } },
      { op: 'put', node: { $path: '/box', $type: 't.dir' } },
      {
        op: 'put',
        node: {
          $path: '/old',
          $type: 't.dir',
          value: 1,
          $acl: [{ subject: { group: 'public' }, grant: R }],
        },
      },
      {
        op: 'put',
        node: {
          $path: '/fresh',
          $type: 't.dir',
          value: 1,
          $acl: [{ subject: { group: 'public' }, grant: R }],
        },
      },
      {
        op: 'put',
        node: {
          $path: '/reads',
          $type: 't.dir',
          $acl: [{ subject: { group: 'public' }, grant: R }],
        },
      },
      { op: 'put', node: { $path: '/reads/first', $type: 't.dir' } },
      { op: 'put', node: { $path: '/reads/second', $type: 't.dir' } },
    ],
  }).outcome;
  const form = await node(formPath);
  const principal = `n:${form.$id}`;

  /** Grants the issued form principal with its exact configuration precondition. */
  async function grant(path: string, bits: number, publicBits = 0) {
    const acl: AclEntry[] = [];
    if (bits !== 0) acl.push({ subject: { group: principal }, grant: bits });
    if (publicBits !== 0) acl.push({ subject: { group: 'public' }, grant: publicBits });
    await admin.commit({
      opId: key(),
      expect: { nodes: [{ path: formPath, rev: (await node(formPath)).$rev }] },
      changes: [{ op: 'patch', path, ops: { $set: { $acl: acl } } }],
    }).outcome;
  }

  /** Captures only accepted state and journal decisions. */
  async function accepted() {
    return {
      nodes: (await root.scan({ range: { subtree: '/' }, budget: scanBudget() })).items,
      journal: (await root.scan({ range: { journal: '/' }, budget: scanBudget() })).items,
    };
  }
  return { instance, root, admin, module, key, node, grant, principal, accepted, open };
}

describe('native streaming action contracts', { timeout: 30_000 }, () => {
  it('commits each yielded step with fresh captured context and an ordered direct chunk', async (t) => {
    const acceptedFirst = event();
    let segments = 0;
    const f = await fixture(t, {
      run: {
        kind: 'write',
        args: {},
        handler: async function* (this: { count: number; settings: { count: number } }, ctx) {
          const read = ctx.read;
          const change = ctx.change;
          const authorize = ctx.requireReadWrite;
          const held = this.settings;
          segments++;
          await read.read({ node: '/old' });
          await authorize('/box/first');
          this.count++;
          change.put({ $path: '/box/first', $type: 't.dir' });
          change.patch(workerPath, { $set: { 'settings.count': 7 } });
          yield 'first';

          segments++;
          assert.equal(this.count, 1);
          assert.equal(ctx.node.count, 1);
          assert.equal(held.count, 7);
          assert.deepEqual(ctx.node.settings, { count: 7 });
          assert.equal(getActionContext('write').node.count, 1);
          await read.read({ node: '/fresh' });
          await authorize('/box/second');
          this.count++;
          held.count++;
          change.put({ $path: '/box/second', $type: 't.dir' });
          yield 'second';
          assert.equal(this.count, 2);
          assert.equal(ctx.node.count, 2);
          assert.deepEqual(ctx.node.settings, { count: 8 });
          return 'complete';
        },
      },
    });
    await f.grant('/box', 0, R | W);
    const caller = await f.open();
    const request = { path: workerPath, action: 'run', args: {}, opId: f.key() };
    const persist = f.root.commit.bind(f.root);
    t.mock.method(f.root, 'commit', async (commit: Parameters<typeof persist>[0]) => {
      await persist(commit);
      if (
        commit.record.decision?.opId.nonce === request.opId.nonce &&
        commit.record.decision.outcome === undefined
      )
        acceptedFirst.resolve();
    });
    const pending = caller.session.act(request);
    const chunks = pending.chunks[Symbol.asyncIterator]();
    const ready = await Promise.race([
      acceptedFirst.promise.then(() => 'accepted'),
      pending.outcome.then(() => 'completed'),
    ]);
    assert.equal(ready, 'accepted');
    assert.equal((await f.node(workerPath)).count, 1);
    assert.equal(segments, 1);
    await f.admin.commit({
      opId: f.key(),
      changes: [{ op: 'patch', path: '/old', ops: { $set: { value: 2 } } }],
    }).outcome;
    const first = await chunks.next();
    assert.equal(first.done, false);
    assert.equal(first.value, 'first');
    const second = await chunks.next();
    assert.equal(second.done, false);
    assert.equal(second.value, 'second');
    assert.equal((await pending.outcome).value, 'complete');
    assert.equal((await chunks.next()).done, true);
    assert.equal((await f.node(workerPath)).count, 2);
    assert.equal(segments, 2);
    const records = (await f.accepted()).journal.filter(
      (record) => record.caller === caller.session.actor.principal,
    );
    assert.equal(records.length, 3);
    assert.equal(records[0].decision?.outcome, undefined);
    assert.equal(records[2].decision?.outcome?.value, 'complete');
    for (const record of records)
      assert.ok(
        caller.frames.some(
          (frame) =>
            frame.t === 'pos' &&
            frame.pos.epoch === record.pos.epoch &&
            frame.pos.seq >= record.pos.seq,
        ),
      );
  });

  it('checks only the current frame reads and preserves an earlier accepted step on conflict', async (t) => {
    const entered = event();
    const release = event();
    t.after(() => release.resolve());
    const f = await fixture(t, {
      run: {
        kind: 'write',
        args: {},
        handler: async function* (ctx) {
          ctx.change.put({ $path: '/box/first', $type: 't.dir' });
          yield 'first';
          await ctx.read.read({ node: '/fresh' });
          entered.resolve();
          await release.promise;
          ctx.change.put({ $path: '/box/second', $type: 't.dir' });
          yield 'second';
          return 'complete';
        },
      },
    });
    await f.grant('/box', 0, R | W);
    const caller = await f.open();
    const request = { path: workerPath, action: 'run', args: {}, opId: f.key() };
    const firstAccepted = started(t, f.root, request.opId);
    const pending = caller.session.act(request);
    await reached(pending, firstAccepted);
    const chunks = pending.chunks[Symbol.asyncIterator]();
    assert.equal((await chunks.next()).value, 'first');
    await reached(pending, entered);
    await f.admin.commit({
      opId: f.key(),
      changes: [{ op: 'patch', path: '/fresh', ops: { $set: { value: 2 } } }],
    }).outcome;
    release.resolve();
    await assert.rejects(pending.outcome, code('CONFLICT'));
    assert.ok((await f.accepted()).nodes.some((node) => node.$path === '/box/first'));
    assert.ok(!(await f.accepted()).nodes.some((node) => node.$path === '/box/second'));
    await assert.rejects(caller.session.act(request).outcome, code('UNKNOWN_OUTCOME'));
  });

  it('refuses foreign own settings between accepted steps instead of rebasing them', async (t) => {
    const f = await fixture(t, {
      run: {
        kind: 'write',
        args: {},
        handler: async function* (this: { count: number }, ctx) {
          this.count++;
          yield 'first';
          this.count++;
          ctx.change.put({ $path: '/box/second', $type: 't.dir' });
          yield 'second';
        },
      },
    });
    await f.grant('/box', 0, R | W);
    const caller = await f.open();
    const request = { path: workerPath, action: 'run', args: {}, opId: f.key() };
    const firstAccepted = started(t, f.root, request.opId);
    const pending = caller.session.act(request);
    await reached(pending, firstAccepted);
    await f.admin.commit({
      opId: f.key(),
      changes: [{ op: 'patch', path: workerPath, ops: { $set: { count: 20 } } }],
    }).outcome;
    assert.equal((await pending.chunks[Symbol.asyncIterator]().next()).value, 'first');
    await assert.rejects(pending.outcome, code('CONFLICT'));
    assert.equal((await f.node(workerPath)).count, 20);
    assert.ok(!(await f.accepted()).nodes.some((node) => node.$path === '/box/second'));
  });

  for (const revoked of ['settings', 'destination', 'caller'] as const) {
    it(`rechecks setuid ${revoked} before the next writing frame`, async (t) => {
      const f = await fixture(
        t,
        {},
        {
          run: {
            kind: 'setuid',
            args: {},
            handler: async function* (ctx) {
              await ctx.requireReadWrite('/box/first');
              ctx.change.put({ $path: '/box/first', $type: 't.dir' });
              yield 'first';
              await ctx.requireReadWrite('/box/second');
              ctx.change.put({ $path: '/box/second', $type: 't.dir' });
              yield 'second';
              return 'complete';
            },
          },
        },
      );
      await f.grant('/box', R | W);
      const form = await f.node(formPath);
      const caller = await f.open();
      const request = { path: formPath, action: 'run', args: {}, opId: f.key() };
      const firstAccepted = started(t, f.root, request.opId);
      const pending = caller.session.act(request);
      await reached(pending, firstAccepted);
      if (revoked === 'destination') await f.grant('/box', W);
      if (revoked === 'settings')
        await f.admin.commit({
          opId: f.key(),
          changes: [{ op: 'patch', path: formPath, ops: { $set: { destination: '/elsewhere' } } }],
        }).outcome;
      if (revoked === 'caller') {
        await f.admin.commit({
          opId: f.key(),
          changes: [{ op: 'patch', path: '/forms', ops: { $set: { $acl: [] } } }],
        }).outcome;
        assert.equal((await f.node(formPath)).$rev, form.$rev);
      }
      assert.equal((await pending.chunks[Symbol.asyncIterator]().next()).value, 'first');
      await assert.rejects(
        pending.outcome,
        code(revoked === 'destination' ? 'FORBIDDEN' : 'CONFLICT'),
      );
      const state = await f.accepted();
      assert.ok(state.nodes.some((node) => node.$path === '/box/first'));
      assert.ok(!state.nodes.some((node) => node.$path === '/box/second'));
      const records = state.journal.filter(
        (record) => record.decision?.opId.nonce === request.opId.nonce,
      );
      assert.equal(records.length, 1);
      assert.equal(records[0].decision?.outcome, undefined);
    });
  }

  it('keeps a caught exact node-cap refusal terminal even when the stream returns without changes', async (t) => {
    let successfulReads = 0;
    let caught = false;
    const f = await fixture(t, {
      run: {
        kind: 'write',
        args: {},
        handler: async function* (ctx) {
          successfulReads += (await ctx.read.read({ children: '/reads' })).list.length;
          try {
            await ctx.read.read({ node: '/fresh' });
          } catch (error) {
            assert.ok(code('BUDGET')(error));
            caught = true;
          }
          return 'must not complete';
        },
      },
    });
    await f.admin.commit({
      opId: f.key(),
      changes: [{ op: 'patch', path: '/sys/limits', ops: { $set: { readNodes: 5 } } }],
    }).outcome;
    const caller = await f.open(undefined, 'BUDGET');
    const before = await f.accepted();
    await assert.rejects(
      caller.session.act({ path: workerPath, action: 'run', args: {}, opId: f.key() }).outcome,
      code('BUDGET'),
    );
    assert.equal(successfulReads, 2);
    assert.equal(caught, true);
    assert.deepEqual(await f.accepted(), before);
  });

  it('retains caught expression-work exhaustion before a yielded effect', async (t) => {
    let caught = false;
    const f = await fixture(t, {
      run: {
        kind: 'write',
        args: {},
        handler: async function* (ctx) {
          try {
            for (let attempt = 0; attempt < 64; attempt++)
              await ctx.requireReadWrite('/box/effect');
          } catch (error) {
            assert.ok(code('BUDGET')(error));
            caught = true;
          }
          ctx.change.put({ $path: '/box/effect', $type: 't.dir' });
          yield 'must not publish';
        },
      },
    });
    await f.grant('/box', 0, R | W);
    await f.admin.commit({
      opId: f.key(),
      changes: [{ op: 'patch', path: '/sys/limits', ops: { $set: { exprWork: 1024 } } }],
    }).outcome;
    const caller = await f.open();
    const before = await f.accepted();
    await assert.rejects(
      caller.session.act({ path: workerPath, action: 'run', args: {}, opId: f.key() }).outcome,
      code('BUDGET'),
    );
    assert.equal(caught, true);
    assert.deepEqual(await f.accepted(), before);
  });

  it('carries the actual read allowance across accepted frames', async (t) => {
    let read = 0;
    const f = await fixture(t, {
      run: {
        kind: 'write',
        args: {},
        handler: async function* (ctx) {
          for (let frame = 0; frame < 32; frame++) {
            await ctx.read.read({ node: '/old' });
            read++;
            yield frame;
          }
          return 'must not complete';
        },
      },
    });
    await f.admin.commit({
      opId: f.key(),
      changes: [{ op: 'patch', path: '/sys/limits', ops: { $set: { readNodes: 20 } } }],
    }).outcome;
    const caller = await f.open(undefined, 'BUDGET');
    const request = { path: workerPath, action: 'run', args: {}, opId: f.key() };
    const firstAccepted = started(t, f.root, request.opId);
    const pending = caller.session.act(request);
    await reached(pending, firstAccepted);
    let pieces = 0;
    await assert.rejects(async () => {
      for await (const _piece of pending.chunks) pieces++;
    }, code('BUDGET'));
    await assert.rejects(pending.outcome, code('BUDGET'));
    assert.ok(pieces > 0 && pieces < 32);
    assert.ok(read > 0 && read < 32);
    const records = (await f.accepted()).journal.filter(
      (record) => record.decision?.opId.nonce === request.opId.nonce,
    );
    assert.equal(records.length, 1);
    assert.equal(records[0].decision?.outcome, undefined);
  });

  it('returns an interrupted real generator once and leaves its accepted step intact', async (t) => {
    let returned = 0;
    let cleaned = 0;
    const cleanup = event();
    const f = await fixture(t, {
      run: {
        kind: 'write',
        args: {},
        handler(ctx) {
          const iterator: AsyncGenerator<unknown, unknown, undefined> = (async function* () {
            try {
              ctx.change.put({ $path: '/box/first', $type: 't.dir' });
              yield 'first';
              ctx.change.put({ $path: '/box/second', $type: 't.dir' });
              yield 'second';
            } finally {
              cleaned++;
              cleanup.resolve();
            }
          })();
          const close = iterator.return.bind(iterator);
          iterator.return = (value) => {
            returned++;
            return close(value);
          };
          return iterator;
        },
      },
    });
    await f.grant('/box', 0, R | W);
    const caller = await f.open();
    const request = { path: workerPath, action: 'run', args: {}, opId: f.key() };
    const firstAccepted = started(t, f.root, request.opId);
    const pending = caller.session.act(request);
    await reached(pending, firstAccepted);
    caller.session.cancel(pending.id);
    await assert.rejects(pending.outcome, code('CANCELLED'));
    await cleanup.promise;
    assert.equal(returned, 1);
    assert.equal(cleaned, 1);
    assert.ok((await f.accepted()).nodes.some((node) => node.$path === '/box/first'));
    assert.ok(!(await f.accepted()).nodes.some((node) => node.$path === '/box/second'));
    await assert.rejects(caller.session.act(request).outcome, code('UNKNOWN_OUTCOME'));
    assert.ok('node' in (await caller.session.read({ node: '/old' })).copies[0]);
  });

  it('finishes a continued stream and its original key atomically while deduplicating its inner charge', async (t) => {
    let charged = 0;
    let invoked = 0;
    const f = await fixture(
      t,
      {
        charge: {
          kind: 'write',
          args: {},
          handler: async function (this: { count: number }) {
            charged++;
            this.count++;
            return this.count;
          },
        },
      },
      {
        run: {
          kind: 'setuid',
          args: {},
          handler: async function* (ctx, args) {
            invoked++;
            const value = await ctx.act({
              path: workerPath,
              action: 'charge',
              args,
              key: 'charge',
            });
            ctx.change.put({ $path: '/box/' + ctx.caller.principal, $type: 't.dir', value });
            yield value;
            return value;
          },
        },
      },
    );
    await f.grant('/box', R | W);
    await f.grant(workerPath, R | W);
    const caller = await f.open();
    const original = { path: formPath, action: 'run', args: { amount: 1 }, opId: f.key() };
    const firstAccepted = started(t, f.root, original.opId);
    const interrupted = caller.session.act(original);
    await reached(interrupted, firstAccepted);
    caller.session.cancel(interrupted.id);
    await assert.rejects(interrupted.outcome, code('CANCELLED'));
    assert.equal(charged, 1);
    await assert.rejects(caller.session.act(original).outcome, code('UNKNOWN_OUTCOME'));

    const continuation = { ...original, opId: f.key(), anchor: original.opId };
    const final = await completed(caller.session.act(continuation));
    assert.deepEqual(final.pieces, [1]);
    assert.equal(final.outcome.value, 1);
    assert.equal(charged, 1);
    assert.equal(invoked, 2);
    assert.deepEqual(await caller.session.act(original).outcome, final.outcome);
    assert.deepEqual(await caller.session.act(continuation).outcome, final.outcome);
    assert.equal(charged, 1);
    assert.equal(invoked, 2);
    const records = (await f.accepted()).journal;
    const terminal = records.filter(
      (record) =>
        record.decision?.opId.nonce === continuation.opId.nonce &&
        record.decision.outcome !== undefined,
    );
    assert.equal(terminal.length, 1);
    assert.equal(terminal[0].anchorDecision?.opId.nonce, original.opId.nonce);
    assert.deepEqual(terminal[0].decision?.outcome, terminal[0].anchorDecision?.outcome);
    const first = records.find((record) => record.decision?.opId.nonce === original.opId.nonce);
    assert.ok(first?.decision);
    assert.equal(terminal[0].anchorDecision?.requestHash, first.decision.requestHash);
    assert.notEqual(terminal[0].decision?.requestHash, first.decision.requestHash);
    await assert.rejects(
      caller.session.act({ ...continuation, anchor: f.key() }).outcome,
      code('KEY_REUSED'),
    );
    assert.equal(invoked, 2);
  });

  it('keeps changed nested request data bound to the original anchor key', async (t) => {
    let charged = 0;
    const f = await fixture(
      t,
      { charge: { kind: 'write', args: {}, handler: async () => ++charged } },
      {
        run: {
          kind: 'setuid',
          args: {},
          handler: async function* (ctx, args) {
            const value = await ctx.act({
              path: workerPath,
              action: 'charge',
              args,
              key: 'charge',
            });
            yield value;
            return value;
          },
        },
      },
    );
    await f.grant(workerPath, R | W);
    const caller = await f.open();
    const original = { path: formPath, action: 'run', args: { amount: 1 }, opId: f.key() };
    const firstAccepted = started(t, f.root, original.opId);
    const interrupted = caller.session.act(original);
    await reached(interrupted, firstAccepted);
    caller.session.cancel(interrupted.id);
    await assert.rejects(interrupted.outcome, code('CANCELLED'));
    const before = await f.accepted();
    await assert.rejects(
      caller.session.act({ ...original, args: { amount: 2 }, opId: f.key(), anchor: original.opId })
        .outcome,
      code('KEY_REUSED'),
    );
    assert.equal(charged, 1);
    assert.deepEqual(await f.accepted(), before);
  });

  it('separates original nested keys for two anonymous callers with the same outer operation key', async (t) => {
    let charged = 0;
    const f = await fixture(
      t,
      { charge: { kind: 'write', args: {}, handler: async () => ++charged } },
      {
        run: {
          kind: 'setuid',
          args: {},
          handler: async function* (ctx) {
            const value = await ctx.act({
              path: workerPath,
              action: 'charge',
              args: {},
              key: 'charge',
            });
            yield value;
            return value;
          },
        },
      },
    );
    await f.grant(workerPath, R | W);
    const first = await f.open();
    const second = await f.open();
    assert.notEqual(first.session.actor.principal, second.session.actor.principal);
    const request = { path: formPath, action: 'run', args: {}, opId: f.key() };
    const a = await completed(first.session.act(request));
    const b = await completed(second.session.act(request));
    assert.deepEqual(a.pieces, [1]);
    assert.deepEqual(b.pieces, [2]);
    assert.equal(charged, 2);
    assert.deepEqual(await first.session.act(request).outcome, a.outcome);
    assert.deepEqual(await second.session.act(request).outcome, b.outcome);
    assert.equal(charged, 2);
    const inner = (await f.accepted()).journal.filter((record) =>
      record.decision?.opId.nonce.startsWith('nested:'),
    );
    assert.equal(inner.length, 2);
    assert.notEqual(inner[0].decision?.opId.nonce, inner[1].decision?.opId.nonce);
    assert.ok(
      inner.every((record) => record.caller === f.principal && record.executor === f.principal),
    );
  });

  for (const withHandler of [false, true]) {
    it(`refuses an unfinished stream anchor on a post action${withHandler ? ' with a handler' : ''}`, async (t) => {
      let body = 0;
      const f = await fixture(t, {
        run: {
          kind: 'write',
          args: {},
          handler: async function* () {
            yield 'first';
          },
        },
        post: {
          kind: 'write',
          args: {},
          post: { '': { $inc: { count: 1 } } },
          ...(withHandler
            ? {
                handler: async () => {
                  body++;
                },
              }
            : {}),
        },
      });
      const caller = await f.open();
      const original = { path: workerPath, action: 'run', args: {}, opId: f.key() };
      const firstAccepted = started(t, f.root, original.opId);
      const interrupted = caller.session.act(original);
      await reached(interrupted, firstAccepted);
      caller.session.cancel(interrupted.id);
      await assert.rejects(interrupted.outcome, code('CANCELLED'));
      const before = await f.accepted();
      await assert.rejects(
        caller.session.act({
          path: workerPath,
          action: 'post',
          args: {},
          opId: f.key(),
          anchor: original.opId,
        }).outcome,
        code('INVALID'),
      );
      assert.equal(body, 0);
      assert.deepEqual(await f.accepted(), before);
      await assert.rejects(caller.session.act(original).outcome, code('UNKNOWN_OUTCOME'));
    });
  }

  it('preserves a final accepted outcome when the caller cancels before its publication', async (t) => {
    const acceptedFinal = event();
    const publish = event();
    t.after(() => publish.resolve());
    let calls = 0;
    const f = await fixture(t, {
      run: {
        kind: 'write',
        args: {},
        handler: async function* (ctx) {
          calls++;
          ctx.change.put({ $path: '/box/first', $type: 't.dir' });
          yield 'first';
          ctx.change.put({ $path: '/box/final', $type: 't.dir' });
          return 'complete';
        },
      },
    });
    await f.grant('/box', 0, R | W);
    const caller = await f.open();
    const request = { path: workerPath, action: 'run', args: {}, opId: f.key() };
    const persist = f.root.commit.bind(f.root);
    t.mock.method(f.root, 'commit', async (commit: Parameters<typeof persist>[0]) => {
      await persist(commit);
      if (
        commit.record.decision?.opId.nonce === request.opId.nonce &&
        commit.record.decision.outcome !== undefined
      ) {
        acceptedFinal.resolve();
        await publish.promise;
      }
    });
    const pending = caller.session.act(request);
    assert.equal((await pending.chunks[Symbol.asyncIterator]().next()).value, 'first');
    await reached(pending, acceptedFinal);
    caller.session.cancel(pending.id);
    publish.resolve();
    const outcome = await pending.outcome;
    assert.equal(outcome.value, 'complete');
    assert.deepEqual(await caller.session.act(request).outcome, outcome);
    assert.equal(calls, 1);
    assert.ok((await f.accepted()).nodes.some((node) => node.$path === '/box/final'));
  });

  it('keeps a read stream free of writing surfaces and durable mutation decisions', async (t) => {
    let resumed = 0;
    const first = event();
    const f = await fixture(t, {
      run: {
        kind: 'read',
        args: {},
        handler: async function* (ctx) {
          assert.equal(Object.hasOwn(ctx, 'change'), false);
          assert.equal(Object.hasOwn(ctx, 'requireReadWrite'), false);
          assert.equal(getActionContext('read').executor.principal, ctx.caller.principal);
          first.resolve();
          yield ctx.node.count;
          resumed++;
          const copy = (await ctx.read.read({ node: '/old' })).copies[0];
          assert.ok('node' in copy);
          yield copy.node.value;
          return 'complete';
        },
      },
    });
    const caller = await f.open();
    const before = await f.accepted();
    const pending = caller.session.act({ path: workerPath, action: 'run', args: {} });
    await reached(pending, first);
    assert.equal(resumed, 0);
    const final = await completed(pending);
    assert.deepEqual(final.pieces, [0, 1]);
    assert.deepEqual(final.outcome, { value: 'complete' });
    assert.equal(resumed, 1);
    assert.deepEqual(await f.accepted(), before);
  });

  it('includes the wait for an unread piece in the original whole-stream deadline', async (t) => {
    const f = await fixture(t, {
      run: {
        kind: 'write',
        args: {},
        handler: async function* (ctx) {
          ctx.change.put({ $path: '/box/first', $type: 't.dir' });
          yield 'first';
          ctx.change.put({ $path: '/box/second', $type: 't.dir' });
          yield 'second';
        },
      },
    });
    await f.grant('/box', 0, R | W);
    await f.admin.commit({
      opId: f.key(),
      changes: [{ op: 'patch', path: '/sys/limits', ops: { $set: { actionMs: 10 } } }],
    }).outcome;
    const caller = await f.open();
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
    const request = { path: workerPath, action: 'run', args: {}, opId: f.key() };
    const firstAccepted = started(t, f.root, request.opId);
    const pending = caller.session.act(request);
    await reached(pending, firstAccepted);
    t.mock.timers.tick(11);
    await assert.rejects(pending.outcome, code('BUDGET'));
    const state = await f.accepted();
    assert.ok(state.nodes.some((node) => node.$path === '/box/first'));
    assert.ok(!state.nodes.some((node) => node.$path === '/box/second'));
    await assert.rejects(caller.session.act(request).outcome, code('UNKNOWN_OUTCOME'));
  });

  it('refuses missing, expired and completed anchors before executing a new stream body', async (t) => {
    let invoked = 0;
    const f = await fixture(t, {
      run: {
        kind: 'write',
        args: {},
        handler: async function* () {
          invoked++;
          yield 'first';
          return 'complete';
        },
      },
    });
    const caller = await f.open();
    const original = { path: workerPath, action: 'run', args: {}, opId: f.key() };
    const final = await completed(caller.session.act(original));
    assert.equal(final.outcome.value, 'complete');
    const before = await f.accepted();
    for (const [anchor, expected] of [
      [original.opId, 'INVALID'],
      [f.key(), 'INVALID'],
      [{ ...f.key(), epoch: randomUUID() }, 'UNKNOWN_OUTCOME'],
      [{ ...f.key(), time: 0 }, 'EXPIRED'],
    ] as const) {
      await assert.rejects(
        caller.session.act({ ...original, opId: f.key(), anchor }).outcome,
        code(expected),
      );
    }
    assert.equal(invoked, 1);
    assert.deepEqual(await f.accepted(), before);
  });

  it('rejects reused logical nested keys across frames without repeating an accepted inner effect', async (t) => {
    let charged = 0;
    const f = await fixture(
      t,
      { charge: { kind: 'write', args: {}, handler: async () => ++charged } },
      {
        run: {
          kind: 'setuid',
          args: {},
          handler: async function* (ctx) {
            yield await ctx.act({ path: workerPath, action: 'charge', args: {}, key: 'charge' });
            yield await ctx.act({ path: workerPath, action: 'charge', args: {}, key: 'charge' });
          },
        },
      },
    );
    await f.grant(workerPath, R | W);
    const caller = await f.open();
    const pending = caller.session.act({ path: formPath, action: 'run', args: {}, opId: f.key() });
    assert.equal((await pending.chunks[Symbol.asyncIterator]().next()).value, 1);
    await assert.rejects(pending.outcome, code('INVALID'));
    assert.equal(charged, 1);
    const inner = (await f.accepted()).journal.filter((record) =>
      record.decision?.opId.nonce.startsWith('nested:'),
    );
    assert.equal(inner.length, 1);
  });

  it('retains the original nesting limit after yielding an accepted frame', async (t) => {
    const f = await fixture(t, {
      descend: {
        kind: 'read',
        args: {},
        handler: async (ctx) => ctx.act({ path: workerPath, action: 'descend', args: {} }),
      },
      run: {
        kind: 'write',
        args: {},
        handler: async function* (ctx) {
          yield 'first';
          yield await ctx.act({ path: workerPath, action: 'descend', args: {} });
        },
      },
    });
    await f.admin.commit({
      opId: f.key(),
      changes: [{ op: 'patch', path: '/sys/limits', ops: { $set: { actionDepth: 1 } } }],
    }).outcome;
    const caller = await f.open();
    const request = { path: workerPath, action: 'run', args: {}, opId: f.key() };
    const pending = caller.session.act(request);
    assert.equal((await pending.chunks[Symbol.asyncIterator]().next()).value, 'first');
    await assert.rejects(pending.outcome, code('BUDGET'));
    const records = (await f.accepted()).journal.filter(
      (record) => record.caller === caller.session.actor.principal,
    );
    assert.equal(records.length, 1);
    assert.equal(records[0].decision?.outcome, undefined);
    await assert.rejects(caller.session.act(request).outcome, code('UNKNOWN_OUTCOME'));
  });

  it('checks a read stream input again before publishing its first piece after rights revocation', async (t) => {
    const entered = event();
    const release = event();
    t.after(() => release.resolve());
    const f = await fixture(t, {
      run: {
        kind: 'read',
        args: {},
        handler: async function* (ctx) {
          const copy = (await ctx.read.read({ node: '/old' })).copies[0];
          assert.ok('node' in copy);
          entered.resolve();
          await release.promise;
          yield copy.node.value;
        },
      },
    });
    const caller = await f.open();
    const pending = caller.session.act({ path: workerPath, action: 'run', args: {} });
    await reached(pending, entered);
    const refusedPiece = assert.rejects(
      pending.chunks[Symbol.asyncIterator]().next(),
      code('CONFLICT'),
    );
    await f.admin.commit({
      opId: f.key(),
      changes: [{ op: 'patch', path: '/old', ops: { $set: { $acl: [] } } }],
    }).outcome;
    const before = await f.accepted();
    release.resolve();
    await assert.rejects(pending.outcome, code('CONFLICT'));
    await refusedPiece;
    assert.deepEqual(await f.accepted(), before);
  });

  it('releases the real owned node lane when its executor admission is revoked between steps', async (t) => {
    const f = await fixture(
      t,
      {},
      {
        run: {
          kind: 'setuid',
          args: {},
          handler: async function* (ctx) {
            ctx.change.put({ $path: '/box/first', $type: 't.dir' });
            yield 'first';
            ctx.change.put({ $path: '/box/second', $type: 't.dir' });
            yield 'second';
          },
        },
      },
    );
    await f.grant('/box', R | W);
    await f.admin.commit({
      opId: f.key(),
      changes: [
        { op: 'patch', path: '/sys/limits', ops: { $set: { maxLanes: 3, lanesPerOrigin: 1 } } },
      ],
    }).outcome;
    const caller = await f.open();
    const request = { path: formPath, action: 'run', args: {}, opId: f.key() };
    const firstAccepted = started(t, f.root, request.opId);
    const pending = caller.session.act(request);
    await reached(pending, firstAccepted);
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
    await assert.rejects(pending.outcome, code('UNAUTHENTICATED'));
    await f.admin.commit({
      opId: f.key(),
      changes: [{ op: 'patch', path: formPath, ops: { $unset: { '#membership': true } } }],
    }).outcome;
    const executor = await f.instance.openNodeSession(formPath);
    assert.equal(executor.actor.principal, f.principal);
    executor.close();
    assert.ok('node' in (await caller.session.read({ node: '/old' })).copies[0]);
    const state = await f.accepted();
    assert.ok(state.nodes.some((node) => node.$path === '/box/first'));
    assert.ok(!state.nodes.some((node) => node.$path === '/box/second'));
  });

  it('finishes a naturally exhausted generator without invoking return and cleans it up once', async (t) => {
    let returned = 0;
    let cleaned = 0;
    const f = await fixture(t, {
      run: {
        kind: 'write',
        args: {},
        handler() {
          const iterator: AsyncGenerator<unknown, unknown, undefined> = (async function* () {
            try {
              yield 'first';
              return 'complete';
            } finally {
              cleaned++;
            }
          })();
          const close = iterator.return.bind(iterator);
          iterator.return = (value) => {
            returned++;
            return close(value);
          };
          return iterator;
        },
      },
    });
    const caller = await f.open();
    const final = await completed(
      caller.session.act({ path: workerPath, action: 'run', args: {}, opId: f.key() }),
    );
    assert.deepEqual(final.pieces, ['first']);
    assert.equal(final.outcome.value, 'complete');
    assert.equal(returned, 0);
    assert.equal(cleaned, 1);
  });

  it('allows one continuation to finish the anchor and refuses another final effect at its actual position', async (t) => {
    const a = { entered: event(), release: event() };
    const b = { entered: event(), release: event() };
    t.after(() => {
      a.release.resolve();
      b.release.resolve();
    });
    let attempts = 0;
    const f = await fixture(t, {
      run: {
        kind: 'write',
        args: {},
        handler: async function* (ctx) {
          const attempt = attempts++;
          yield attempt;
          assert.ok(attempt === 1 || attempt === 2);
          const wait = attempt === 1 ? a : b;
          wait.entered.resolve();
          await wait.release.promise;
          ctx.change.put({ $path: '/box/final-' + attempt, $type: 't.dir' });
          return attempt;
        },
      },
    });
    await f.grant('/box', 0, R | W);
    const caller = await f.open();
    const original = { path: workerPath, action: 'run', args: {}, opId: f.key() };
    const firstAccepted = started(t, f.root, original.opId);
    const interrupted = caller.session.act(original);
    await reached(interrupted, firstAccepted);
    caller.session.cancel(interrupted.id);
    await assert.rejects(interrupted.outcome, code('CANCELLED'));

    const firstRequest = { ...original, opId: f.key(), anchor: original.opId };
    const secondRequest = { ...original, opId: f.key(), anchor: original.opId };
    const first = caller.session.act(firstRequest);
    assert.equal((await first.chunks[Symbol.asyncIterator]().next()).value, 1);
    await reached(first, a.entered);
    const second = caller.session.act(secondRequest);
    assert.equal((await second.chunks[Symbol.asyncIterator]().next()).value, 2);
    await reached(second, b.entered);
    a.release.resolve();
    const outcome = await first.outcome;
    assert.equal(outcome.value, 1);
    b.release.resolve();
    await assert.rejects(second.outcome, code('INVALID'));
    assert.deepEqual(await caller.session.act(original).outcome, outcome);
    const state = await f.accepted();
    assert.ok(state.nodes.some((node) => node.$path === '/box/final-1'));
    assert.ok(!state.nodes.some((node) => node.$path === '/box/final-2'));
    assert.equal(
      state.journal.filter((record) => record.anchorDecision?.opId.nonce === original.opId.nonce)
        .length,
      1,
    );
    await assert.rejects(caller.session.act(secondRequest).outcome, code('UNKNOWN_OUTCOME'));
  });

  it('carries preparation-only node reads across frames and retains earlier accepted batches on exhaustion', async (t) => {
    const f = await fixture(t, {
      run: {
        kind: 'write',
        args: {},
        handler: async function* (ctx) {
          for (let frame = 0; frame < 4; frame++) {
            for (let child = frame * 24; child < (frame + 1) * 24; child++)
              ctx.change.patch('/box/' + child, { $inc: { value: 1 } });
            yield frame;
          }
          return 'must not complete';
        },
      },
    });
    await f.grant('/box', 0, R | W);
    const seed: ChangeMember[] = Array.from({ length: 96 }, (_value, child) => ({
      op: 'put',
      node: { $path: '/box/' + child, $type: 't.dir', value: 0 },
    }));
    await f.admin.commit({ opId: f.key(), changes: seed }).outcome;
    await f.admin.commit({
      opId: f.key(),
      changes: [{ op: 'patch', path: '/sys/limits', ops: { $set: { readNodes: 850 } } }],
    }).outcome;
    const caller = await f.open(undefined, 'BUDGET');
    const request = { path: workerPath, action: 'run', args: {}, opId: f.key() };
    const pending = caller.session.act(request);
    let pieces = 0;
    await assert.rejects(async () => {
      for await (const _piece of pending.chunks) pieces++;
    }, code('BUDGET'));
    await assert.rejects(pending.outcome, code('BUDGET'));
    assert.ok(pieces > 0 && pieces < 4);
    const state = await f.accepted();
    const targets = state.nodes.filter((node) => node.$path.startsWith('/box/'));
    assert.equal(targets.length, 96);
    assert.equal(targets.filter((node) => node.value === 1).length, pieces * 24);
    assert.ok(targets.every((node) => node.value === 0 || node.value === 1));
    assert.equal(
      state.journal.filter(
        (record) =>
          record.decision?.opId.nonce === request.opId.nonce &&
          record.decision.outcome !== undefined,
      ).length,
      0,
    );
  });
});
