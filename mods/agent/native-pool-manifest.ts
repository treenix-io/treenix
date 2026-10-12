import { createHash } from 'node:crypto';
import { getComponent } from '@treenx/core';
import { KernelError } from '@treenx/core/errors';
import {
  A,
  R,
  W,
  type TypeDef,
  type ReadActionContext,
  type WriteActionContext,
} from '@treenx/core/kernel/types';
import { z } from 'zod/v3';
import type { AiAgent, AiPool } from '#agent/types';
import { patchAgentComponent } from '#agent/native-chat';
import { optionalPoolNode, poolNode, selectPoolJobs, type PoolConfig } from '#agent/native-pool';
import { recoverPool, requirePoolController, runPoolJob } from '#agent/native-pool-run';
import { projectNativeReviews } from '#agent/native-reviews';

/** Keeps one stable, safe capability address for each administrator-selected agent path. */
export function nativeWorkerPath(root: string, agentPath: string): string {
  return `${root}/w-${createHash('sha256').update(agentPath).digest('hex').slice(0, 20)}`;
}

/** Creates and pins a real worker before an administrator grants its read and logging authority. */
async function* provisionWorker(this: PoolConfig, ctx: WriteActionContext, args: unknown) {
  await ctx.requireAdmin();
  const { agentPath } = z.object({ agentPath: z.string() }).strict().parse(args);
  const agent = await poolNode(ctx.read, agentPath);
  if (getComponent<AiAgent>(agent, 'ai.agent') === undefined)
    throw new KernelError('INVALID', 'Worker requires an agent component');
  const path = nativeWorkerPath(this.workersPath, agentPath);
  const previous = await optionalPoolNode(ctx.read, path);
  if (previous === undefined) {
    ctx.change.put({ $path: path, $type: 'ai.worker', poolPath: ctx.node.$path, agentPath });
    yield { type: 'provisioned', path };
  } else if (
    previous.$type !== 'ai.worker' ||
    previous.poolPath !== ctx.node.$path ||
    previous.agentPath !== agentPath
  )
    throw new KernelError('CONFLICT', 'Worker configuration differs from this office');
  const worker = await poolNode(ctx.read, path);
  const controller = await poolNode(ctx.read, ctx.node.$path);
  const currentAgent = await poolNode(ctx.read, agentPath);
  const agentAcl = currentAgent.$acl ?? [];
  ctx.change.patch(agentPath, {
    $set: { $acl: [...agentAcl, { subject: { group: `n:${controller.$id}` }, grant: R | W | A }] },
  });
  const root = await poolNode(ctx.read, '/');
  const principal = `n:${worker.$id}`;
  const acl = root.$acl ?? [];
  if (
    !acl.some(
      (entry) =>
        'group' in entry.subject &&
        entry.subject.group === principal &&
        'grant' in entry &&
        (entry.grant & R) !== 0,
    )
  )
    ctx.change.patch('/', {
      $set: { $acl: [...acl, { subject: { group: principal }, grant: R }] },
    });
  return { path };
}

/** Publishes immutable service configuration separately from the pool's mutable UI state. */
export function nativePoolType(owner: string): TypeDef {
  const paths = { type: 'string', minLength: 1 };
  const empty = { type: 'object', additionalProperties: false };
  const job = {
    type: 'object',
    additionalProperties: false,
    required: ['agentPath', 'taskPath', 'workerPath', 'mode'],
    properties: {
      agentPath: paths,
      taskPath: paths,
      workerPath: paths,
      mode: { enum: ['plan', 'work', 'discuss'] },
      resume: { type: 'boolean' },
    },
  };
  const actions = {
    select: {
      kind: 'read' as const,
      args: empty,
      async handler(this: PoolConfig, ctx: ReadActionContext) {
        return selectPoolJobs(this, ctx);
      },
    },
    run: { kind: 'setuid' as const, args: job, handler: runPoolJob },
    recover: { kind: 'setuid' as const, args: empty, handler: recoverPool },
    reviews: { kind: 'setuid' as const, args: empty, handler: projectNativeReviews },
    queue: {
      kind: 'setuid' as const,
      args: {
        type: 'object',
        required: ['agents'],
        additionalProperties: false,
        properties: { agents: { type: 'array', items: paths } },
      },
      async handler(this: PoolConfig, ctx: WriteActionContext, args: unknown) {
        await requirePoolController(ctx);
        const { agents } = z
          .object({ agents: z.array(z.string()) })
          .strict()
          .parse(args);
        const node = await poolNode(ctx.read, this.poolPath);
        const pool = getComponent<AiPool>(node, 'ai.pool');
        if (pool === undefined) throw new KernelError('INVALID', 'Agent service has no pool');
        if (pool.queue.length !== agents.length || pool.queue.some((path, i) => path !== agents[i]))
          patchAgentComponent(ctx, node, 'ai.pool', { queue: agents });
      },
    },
    provisionWorker: {
      kind: 'write' as const,
      args: {
        type: 'object',
        required: ['agentPath'],
        additionalProperties: false,
        properties: { agentPath: paths },
      },
      handler: provisionWorker,
    },
  } satisfies TypeDef['actions'];
  return {
    name: 'ai.pool-service',
    module: owner,
    security: 'user-capability',
    version: 0,
    actionsOnly: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: [
        'poolPath',
        'tasksPath',
        'orgPath',
        'workersPath',
        'branchesPath',
        'approvalsPath',
        'workspaceBase',
        'readScope',
      ],
      properties: {
        poolPath: paths,
        tasksPath: paths,
        orgPath: paths,
        workersPath: paths,
        branchesPath: paths,
        approvalsPath: paths,
        workspaceBase: paths,
        readScope: { type: 'array', items: paths },
      },
      methods: Object.fromEntries(
        Object.entries(actions).map(([name, action]) => [
          name,
          {
            kind: action.kind,
            ...(name === 'run' || name === 'provisionWorker' ? { streaming: true } : {}),
            arguments: [{ name: 'data', ...action.args }],
          },
        ]),
      ),
    },
    actions,
  };
}
