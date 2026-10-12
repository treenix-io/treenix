import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { it } from 'node:test';
import { KernelError } from '@treenx/core/errors';
import { createInstance } from '../../core/src/kernel/instance';
import { createMemoryStore } from '@treenx/core/kernel/store/memory';
import { createMemoryBlobStore } from '@treenx/core/kernel/blob-store-memory';
import { R, W, A, type ModuleManifest, type Position } from '@treenx/core/kernel/types';
import { createNativeAgent } from '#agent/kernel';
import createNativeBranch from '#branch/kernel';
import type { AgentProvider } from '#agent/native-io';
import { z } from 'zod/v3';

it(
  'runs a real native worker in a branch and retains scope across nested node executors',
  { timeout: 10000 },
  async () => {
    let workspace = '';
    const provider: AgentProvider = async function* (_request, ports, signal) {
      signal.throwIfAborted();
      const copy = (await ports.read.read({ node: `${workspace}/record` })).copies[0];
      if ('error' in copy) throw copy.error;
      assert.equal(copy.node.value, 'original');
      ports.change.patch(`${workspace}/record`, { $set: { value: 'worker result' } });
      yield { type: 'chunk', text: 'updated future' };
      await ports.act({ path: workspace.slice(0, -5), action: 'requestMerge', args: {} });
      yield {
        type: 'result',
        result: {
          output: 'ready for review',
          sessionId: 'worker-session',
          inputTokens: 10,
          outputTokens: 5,
          costUsd: 0.01,
        },
      };
    };
    const agent = createNativeAgent(provider),
      branch = createNativeBranch();
    const fixtureOwner: ModuleManifest = {
      id: 'worker-fixture',
      security: [],
      open: [],
      types: [
        {
          name: 'worker-fixture.pool',
          module: 'worker-fixture',
          security: 'user-capability',
          version: 0,
          schema: {},
          actions: {
            run: {
              kind: 'setuid',
              args: {},
              async handler(ctx) {
                const worker = (await ctx.read.read({ node: '/worker' })).copies[0];
                if ('error' in worker) throw worker.error;
                const created = z
                  .object({ path: z.string() })
                  .parse(
                    await ctx.act({
                      path: '/branches',
                      action: 'create',
                      args: { base: '/work', ownerPath: '/worker', title: 'worker task' },
                      key: 'create',
                    }),
                  );
                workspace = `${created.path}/tree`;
                const result = await ctx.act({
                  path: '/worker',
                  action: 'invoke',
                  args: {
                    prompt: 'Update the record in your branch and request review.',
                    mode: 'work',
                    workspace,
                  },
                  scope: ['/worker', '/pool', '/agents/qa', '/work', created.path],
                  writeScope: [created.path],
                  key: 'work',
                });
                await ctx.act({
                  path: '/helper',
                  action: 'inside',
                  args: { workspace },
                  scope: ['/helper', '/helper2', '/work', created.path],
                  writeScope: [created.path],
                  key: 'helper',
                });
                ctx.change.patch('/task', {
                  $set: { status: 'review', branchRef: created.path, result },
                });
                return { branch: created.path, result };
              },
            },
          },
        },
        {
          name: 'worker-fixture.helper',
          module: 'worker-fixture',
          security: 'user-capability',
          version: 0,
          schema: {},
          actions: {
            inside: {
              kind: 'setuid',
              args: {
                type: 'object',
                properties: { workspace: { type: 'string' } },
                required: ['workspace'],
              },
              async handler(ctx, args) {
                const { workspace } = z.object({ workspace: z.string() }).parse(args);
                const live = (await ctx.read.read({ node: '/work/record' })).copies[0];
                if ('error' in live) throw live.error;
                assert.equal(live.node.value, 'original');
                await assert.rejects(
                  ctx.act({
                    path: '/helper2',
                    action: 'escape',
                    args: {},
                    key: 'escape',
                    scope: ['/'],
                    writeScope: ['/'],
                  }),
                  (error) => error instanceof KernelError && error.code === 'FORBIDDEN',
                );
                ctx.change.patch(`${workspace}/record`, { $set: { checked: true } });
              },
            },
            escape: {
              kind: 'setuid',
              args: {},
              async handler(ctx) {
                ctx.change.patch('/work/record', { $set: { value: 'escaped' } });
              },
            },
          },
        },
      ],
    };
    const id = randomUUID(),
      store = createMemoryStore({ domain: id });
    let saved: Position | undefined;
    const instance = await createInstance({
      id,
      root: { kind: 'store', store },
      blobs: createMemoryBlobStore(),
      modules: [agent.manifest, branch.manifest, fixtureOwner],
      io: agent.io,
      provisioning: {
        writerEpoch: 1,
        domains: [{ store, epoch: randomUUID(), persistent: false }],
        credentialTtlMs: 60000,
        counter: {
          async load() {
            return saved;
          },
          async save(value) {
            saved = value;
          },
          async freshEpoch(floor) {
            return floor + 1;
          },
        },
        bootstrap: {
          kind: 'fresh',
          admin: { path: '/admin', name: 'admin', password: 'worker-password' },
        },
      },
    });
    const admin = await instance.openSession(instance.setupCredential);
    const delivery = (async () => {
      for await (const frame of admin.lane) if (frame.t === 'end') throw frame.error;
    })();
    const key = () => ({
      epoch: instance.writer.intake.epoch,
      time: Date.now(),
      nonce: randomUUID(),
    });

    /** Inspects committed state through the genuine administrator's native Reader. */
    async function read(path: string) {
      const copy = (await admin.read({ node: path })).copies[0];
      if ('error' in copy) throw copy.error;
      return copy.node;
    }

    try {
      await admin.commit({
        changes: [
          { op: 'put', node: { $path: '/pool', $type: 'worker-fixture.pool' } },
          {
            op: 'put',
            node: {
              $path: '/worker',
              $type: 'ai.worker',
              poolPath: '/pool',
              agentPath: '/agents/qa',
            },
          },
          { op: 'put', node: { $path: '/helper', $type: 'worker-fixture.helper' } },
          { op: 'put', node: { $path: '/helper2', $type: 'worker-fixture.helper' } },
          { op: 'put', node: { $path: '/branches', $type: 't.branches' } },
          { op: 'put', node: { $path: '/work', $type: 't.dir' } },
          { op: 'put', node: { $path: '/work/record', $type: 't.dir', value: 'original' } },
          { op: 'put', node: { $path: '/task', $type: 't.dir', status: 'todo' } },
          { op: 'put', node: { $path: '/agents', $type: 't.dir' } },
          {
            op: 'put',
            node: {
              $path: '/agents/qa',
              $type: 'ai.agent',
              role: 'qa',
              status: 'idle',
              model: 'fixture',
              systemPrompt: 'Use your isolated workspace.',
              currentTask: '',
              currentRun: '',
              lastRunAt: 0,
              totalTokens: 0,
            },
          },
        ],
        opId: key(),
      }).outcome;
      const pool = await read('/pool'),
        worker = await read('/worker');
      const helper = await read('/helper'),
        helper2 = await read('/helper2');
      await admin.commit({
        expect: {
          nodes: [pool, worker, helper, helper2].map((node) => ({
            path: node.$path,
            rev: node.$rev,
          })),
        },
        changes: [
          {
            op: 'patch',
            path: '/',
            ops: {
              $set: {
                $acl: [
                  { subject: { group: 'admins' }, grant: R | W | A },
                  { subject: { group: `n:${pool.$id}` }, grant: R | W | A },
                  { subject: { group: `n:${worker.$id}` }, grant: R },
                  { subject: { group: `n:${helper.$id}` }, grant: R | W | A },
                  { subject: { group: `n:${helper2.$id}` }, grant: R | W | A },
                ],
              },
            },
          },
        ],
        opId: key(),
      }).outcome;
      const pending = admin.act({ path: '/pool', action: 'run', args: {}, opId: key() });
      let pieces = 0;
      for await (const _piece of pending.chunks) pieces++;
      const outcome = await pending.outcome;
      const value = z
        .object({
          branch: z.string(),
          result: z.object({ output: z.string(), sessionId: z.string() }),
        })
        .parse(outcome.value);
      assert.equal(pieces, 1);
      assert.equal(value.result.output, 'ready for review');
      assert.equal((await read(value.branch)).owner, `n:${worker.$id}`);
      assert.equal((await read(value.branch)).status, 'review');
      assert.equal((await read('/work/record')).value, 'original');
      assert.equal((await read('/task')).status, 'review');
      const future = await read(`${value.branch}/tree/record`);
      assert.equal(future.value, 'worker result');
      assert.equal(future.checked, true);
      const merged = admin.act({ path: value.branch, action: 'merge', args: {}, opId: key() });
      await merged.outcome;
      assert.equal((await read('/work/record')).value, 'worker result');
      assert.equal((await read('/work/record')).checked, true);
    } finally {
      admin.close();
      await instance.close();
      await delivery;
    }
  },
);
