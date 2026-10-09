import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { KernelError } from '#errors';
import { openNativeRuntime } from '#kernel/runtime';
import { drainSession } from '#kernel/session-delivery';
import { scanBudget } from '#kernel/store/contract';
import { R, W, type Credential, type ModuleManifest, type Node, type OpId } from '#kernel/types';

const code = (expected: KernelError['code']) => (error: unknown) =>
  error instanceof KernelError && error.code === expected;

/** Opens a genuine durable runtime and keeps its borrowed resources in ownership order. */
async function storage() {
  const base = fileURLToPath(new URL('../../../../../temp/k34-stream-fs/', import.meta.url));
  await mkdir(base, { recursive: true });
  return mkdtemp(join(base, 'instance-'));
}

describe('durable native streaming actions', { timeout: 30_000 }, () => {
  it('persists one terminal commit for both keys and replays both after an actual filesystem reopen', async (t) => {
    let charged = 0;
    let invoked = 0;
    const module: ModuleManifest = {
      id: 'durable-streams',
      security: [],
      open: [],
      types: [
        {
          name: 'durable-streams.worker',
          module: 'durable-streams',
          security: 'ordinary',
          version: 0,
          schema: {},
          actions: {
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
        },
        {
          name: 'durable-streams.form',
          module: 'durable-streams',
          security: 'user-capability',
          version: 0,
          schema: {},
          actions: {
            run: {
              kind: 'setuid',
              args: {},
              handler: async function* (ctx, args) {
                invoked++;
                const value = await ctx.act({
                  path: '/work/worker',
                  action: 'charge',
                  args,
                  key: 'charge',
                });
                ctx.change.put({ $path: '/box/result', $type: 't.dir', value });
                yield value;
                return value;
              },
            },
          },
        },
      ],
    };
    const config = {
      id: `durable-stream:${randomUUID()}`,
      directory: await storage(),
      credentialTtlMs: 60_000,
      modules: [module],
      firstAdmin: { path: '/admin', name: 'admin', password: randomUUID() },
    };
    let runtime = await openNativeRuntime(config);
    const pumps: Promise<void>[] = [];
    t.after(async () => {
      await runtime.close();
      await Promise.all(pumps);
    });

    /** Uses the real issued credential and pumps only the session's ordinary channel. */
    async function open(credential?: Credential) {
      const session = await runtime.instance.openSession(credential);
      const welcome = await session.lane[Symbol.asyncIterator]().next();
      assert.ok(!welcome.done && welcome.value.t === 'welcome');
      pumps.push(drainSession(session));
      return { session, credential: welcome.value.credential };
    }
    assert.ok(runtime.instance.setupCredential);
    const admin = (await open(runtime.instance.setupCredential)).session;

    /** Allocates a request in the actual durable intake rather than inventing an epoch. */
    function key(): OpId {
      return { epoch: runtime.instance.writer.intake.epoch, time: Date.now(), nonce: randomUUID() };
    }

    /** Reads a typed accepted image through the administrator's public Reader. */
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
            $path: '/forms',
            $type: 't.dir',
            $acl: [{ subject: { group: 'public' }, grant: R }],
          },
        },
        { op: 'put', node: { $path: '/forms/form', $type: 'durable-streams.form' } },
        { op: 'put', node: { $path: '/work', $type: 't.dir' } },
        { op: 'put', node: { $path: '/work/worker', $type: 'durable-streams.worker', count: 0 } },
        { op: 'put', node: { $path: '/box', $type: 't.dir' } },
      ],
    }).outcome;
    const form = await node('/forms/form');
    const principal = `n:${form.$id}`;
    await admin.commit({
      opId: key(),
      expect: { nodes: [{ path: form.$path, rev: form.$rev }] },
      changes: [
        {
          op: 'patch',
          path: '/work',
          ops: { $set: { $acl: [{ subject: { group: principal }, grant: R | W }] } },
        },
        {
          op: 'patch',
          path: '/box',
          ops: { $set: { $acl: [{ subject: { group: principal }, grant: R | W }] } },
        },
      ],
    }).outcome;
    const caller = await open();
    assert.ok(caller.credential);
    const original = { path: form.$path, action: 'run', args: { amount: 1 }, opId: key() };
    const absent = key();
    let firstAccepted: () => void = () => {};
    const accepted = new Promise<void>((resolve) => {
      firstAccepted = resolve;
    });
    const persist = runtime.store.commit.bind(runtime.store);
    t.mock.method(runtime.store, 'commit', async (commit: Parameters<typeof persist>[0]) => {
      await persist(commit);
      if (commit.record.decision?.opId.nonce === original.opId.nonce) firstAccepted();
    });
    const interrupted = caller.session.act(original);
    await Promise.race([
      accepted,
      interrupted.outcome.then(() => {
        throw new Error('The stream completed before its first accepted step');
      }),
    ]);
    caller.session.cancel(interrupted.id);
    await assert.rejects(interrupted.outcome, code('CANCELLED'));
    const continuation = { ...original, opId: key(), anchor: original.opId };
    const pending = caller.session.act(continuation);
    const pieces: unknown[] = [];
    for await (const piece of pending.chunks) pieces.push(piece);
    const outcome = await pending.outcome;
    assert.deepEqual(pieces, [1]);
    assert.equal(outcome.value, 1);
    assert.equal(charged, 1);
    assert.equal(invoked, 2);

    const records = (await runtime.store.scan({ range: { journal: '/' }, budget: scanBudget() }))
      .items;
    const terminal = records.filter(
      (record) => record.anchorDecision?.opId.nonce === original.opId.nonce,
    );
    assert.equal(terminal.length, 1);
    assert.equal(terminal[0].decision?.opId.nonce, continuation.opId.nonce);
    assert.deepEqual(terminal[0].decision?.outcome, outcome);
    assert.deepEqual(terminal[0].anchorDecision?.outcome, outcome);
    const first = records.find((record) => record.decision?.opId.nonce === original.opId.nonce);
    assert.ok(first?.decision);
    assert.equal(terminal[0].anchorDecision?.requestHash, first.decision.requestHash);
    assert.notEqual(terminal[0].decision?.requestHash, first.decision.requestHash);
    for (const opId of [original.opId, continuation.opId]) {
      const indexed = (
        await runtime.store.scan({
          range: { decision: { caller: caller.session.actor.principal, opId } },
          budget: scanBudget(),
        })
      ).items;
      assert.equal(indexed.length, 1);
      assert.deepEqual(indexed[0].pos, terminal[0].pos);
    }

    await runtime.close();
    await Promise.all(pumps);
    runtime = await openNativeRuntime(config);
    assert.notEqual(runtime.instance.writer.intake.epoch, original.opId.epoch);
    const reopened = await open(caller.credential);
    assert.equal(reopened.session.actor.principal, caller.session.actor.principal);
    assert.deepEqual(await reopened.session.act(original).outcome, outcome);
    assert.deepEqual(await reopened.session.act(continuation).outcome, outcome);
    await assert.rejects(
      reopened.session.act({ ...original, opId: absent }).outcome,
      code('UNKNOWN_OUTCOME'),
    );
    await assert.rejects(
      reopened.session.act({ ...original, opId: key(), anchor: absent }).outcome,
      code('UNKNOWN_OUTCOME'),
    );
    assert.equal(charged, 1);
    assert.equal(invoked, 2);
    const reopenedJournal = (
      await runtime.store.scan({ range: { journal: '/' }, budget: scanBudget() })
    ).items;
    assert.equal(
      reopenedJournal.filter((record) => record.anchorDecision?.opId.nonce === original.opId.nonce)
        .length,
      1,
    );
  });
});
