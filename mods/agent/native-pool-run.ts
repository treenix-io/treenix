import { randomUUID } from 'node:crypto';
import { getComponent } from '@treenx/core';
import { KernelError } from '@treenx/core/errors';
import { R, W, type Node, type WriteActionContext } from '@treenx/core/kernel/types';
import { componentEntries } from '@treenx/core/kernel/migrate';
import { z } from 'zod/v3';
import type {
  AiAgent,
  AiAssignment,
  AiChat,
  AiPool,
  AiRun,
  AiRunStatus,
  AiThread,
} from '#agent/types';
import { patchAgentComponent } from '#agent/native-chat';
import {
  poolAgents,
  optionalPoolNode,
  poolNode,
  poolPrompt,
  taskAgent,
  taskMode,
  type PoolConfig,
} from '#agent/native-pool';
import { stageNativeBranchControl } from '#branch/native-actions';

export const jobInput = z
  .object({
    agentPath: z.string(),
    taskPath: z.string(),
    workerPath: z.string(),
    mode: z.enum(['plan', 'work', 'discuss']),
    resume: z.boolean().optional(),
  })
  .strict();
const resultInput = z.object({
  output: z.string(),
  sessionId: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  costUsd: z.number(),
  branchRequest: z
    .object({ action: z.enum(['requestMerge', 'abandon']), args: z.unknown() })
    .optional(),
});

/** Restricts coordinator mutations to its genuine service; administrator provisioning uses a caller action. */
export async function requirePoolController(ctx: WriteActionContext): Promise<void> {
  if (ctx.caller.principal !== `n:${ctx.node.$id}`)
    throw new KernelError('FORBIDDEN', 'Only the owning service can coordinate its pool');
}

/** Preserves the existing component address, adding only an explicitly absent workflow component. */
function saveComponent(
  ctx: WriteActionContext,
  node: Node,
  type: string,
  fields: Record<string, unknown>,
): void {
  if (componentEntries(node).some(([, value]) => value.$type === type))
    patchAgentComponent(ctx, node, type, fields);
  else
    ctx.change.patch(node.$path, { $set: { [`#${type.slice(3)}`]: { $type: type, ...fields } } });
}

/** Maps a task's declared subtrees into its future; arbitrary globs cannot widen a kernel subtree mask. */
function futureScope(config: PoolConfig, task: Node, workspace: string): string[] {
  const run = getComponent<{ postRef: string; scope: string[] }>(task, 'org.run');
  if (run === undefined) return [workspace];
  return run.scope.map((path) => {
    const source = path.endsWith('/*') ? path.slice(0, -2) : path;
    if (source.includes('*') || source.includes('?') || !source.startsWith('/'))
      throw new KernelError('INVALID', 'Agent mutation scope requires subtree paths');
    const base = config.workspaceBase;
    if (source !== base && base !== '/' && !source.startsWith(`${base}/`))
      throw new KernelError('FORBIDDEN', 'Task mutation scope is outside the workspace base');
    return source === base
      ? workspace
      : `${workspace}${base === '/' ? source : source.slice(base.length)}`;
  });
}

/** Claims one agent and task atomically, invokes its scoped worker, then publishes the existing UI state. */
export async function* runPoolJob(this: PoolConfig, ctx: WriteActionContext, args: unknown) {
  await requirePoolController(ctx);
  const job = jobInput.parse(args);
  const poolNodeValue = await poolNode(ctx.read, this.poolPath);
  const pool = getComponent<AiPool>(poolNodeValue, 'ai.pool');
  const agentNode = await poolNode(ctx.read, job.agentPath);
  const agent = getComponent<AiAgent>(agentNode, 'ai.agent');
  const task = await poolNode(ctx.read, job.taskPath);
  const worker = await poolNode(ctx.read, job.workerPath);
  if (
    pool === undefined ||
    agent === undefined ||
    task.$type !== 'board.task' ||
    worker.$type !== 'ai.worker' ||
    worker.poolPath !== ctx.node.$path ||
    worker.agentPath !== agentNode.$path ||
    !job.taskPath.startsWith(`${this.tasksPath}/`) ||
    !job.workerPath.startsWith(`${this.workersPath}/`)
  )
    throw new KernelError('INVALID', 'Native pool job differs from its declared office');
  if (
    agent.status !== 'idle' ||
    pool.active.includes(job.agentPath) ||
    pool.active.length >= pool.maxConcurrent
  )
    throw new KernelError('CONFLICT', 'Agent or pool slot is occupied');
  const assignment = getComponent<AiAssignment>(task, 'ai.assignment');
  if (
    !job.resume &&
    (job.mode === 'discuss'
      ? !assignment?.nextRoles.includes(agent.role)
      : taskMode(task) !== job.mode || taskAgent(task, [agentNode]) === undefined)
  )
    throw new KernelError('CONFLICT', 'Task is no longer eligible for this agent');
  const prompt = poolPrompt(job, task, agentNode);
  let branchPath = '';
  let runPath = `${agentNode.$path}/runs/r-${randomUUID()}`;
  if (job.resume) {
    runPath = agent.currentRun;
    const previous = await poolNode(ctx.read, runPath);
    const status = getComponent<AiRunStatus>(previous, 'ai.run-status');
    const run = getComponent<AiRun>(previous, 'ai.run');
    if (
      status?.status !== 'pending' ||
      run === undefined ||
      run.mode !== job.mode ||
      run.taskRef !== task.$path
    )
      throw new KernelError('CONFLICT', 'Run is no longer resumable');
    branchPath = run.branchRef;
    patchAgentComponent(ctx, previous, 'ai.run-status', {
      status: 'running',
      error: '',
      finishedAt: 0,
    });
  } else {
    // The worker version is retained when Branch grants this actual node principal.
    if (job.mode === 'work') {
      const created = z.object({ path: z.string() }).parse(
        await ctx.act({
          path: this.branchesPath,
          action: 'create',
          args: {
            base: this.workspaceBase,
            ownerPath: worker.$path,
            title: `${agent.role}: ${task.title}`,
          },
          key: 'branch',
        }),
      );
      branchPath = created.path;
    }
    if ((await optionalPoolNode(ctx.read, `${agentNode.$path}/runs`)) === undefined) {
      ctx.change.put({ $path: `${agentNode.$path}/runs`, $type: 't.dir' });
    }
    ctx.change.put({
      $path: runPath,
      $type: 'ai.run',
      taskRef: task.$path,
      branchRef: branchPath,
      prompt,
      result: '',
      mode: job.mode,
      queryKey: agentNode.$id,
      $acl: [{ subject: { group: `n:${worker.$id}` }, grant: R | W }],
      '#status': {
        $type: 'ai.run-status',
        status: 'running',
        startedAt: Date.now(),
        finishedAt: 0,
        error: '',
      },
      '#log': { $type: 'ai.log', entries: [] },
      '#cost': {
        $type: 'ai.cost',
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        model: agent.model,
      },
    });
  }
  patchAgentComponent(ctx, agentNode, 'ai.agent', {
    status: 'working',
    currentTask: task.$path,
    currentRun: runPath,
  });
  patchAgentComponent(ctx, poolNodeValue, 'ai.pool', {
    active: [...pool.active, agentNode.$path],
    queue: pool.queue.filter((path) => path !== agentNode.$path),
  });
  ctx.change.patch(task.$path, {
    $set: {
      currentRun: runPath,
      aiStatus: `${agent.role} ${job.mode === 'work' ? 'working' : job.mode === 'plan' ? 'planning' : 'discussing'}`,
      ...(job.mode === 'work' ? { status: 'doing' } : {}),
      updatedAt: Date.now(),
    },
  });
  yield { type: 'started', runPath, agentPath: agentNode.$path };

  let outcome: z.infer<typeof resultInput> | undefined;
  let failure: unknown;
  try {
    const workspace = branchPath.length === 0 ? undefined : `${branchPath}/tree`;
    const writes = workspace === undefined ? [] : futureScope(this, task, workspace);
    const chat = getComponent<AiChat>(agentNode, 'ai.chat');
    outcome = resultInput.parse(
      await ctx.act({
        path: worker.$path,
        action: 'invoke',
        args: {
          prompt,
          mode: job.mode,
          runPath,
          deferBranchControl: true,
          ...(workspace === undefined ? {} : { workspace }),
          ...(chat === undefined || chat.sessionId.length === 0
            ? {}
            : { sessionId: chat.sessionId }),
        },
        scope: [
          ...new Set([
            ...this.readScope,
            this.workspaceBase,
            worker.$path,
            ctx.node.$path,
            agentNode.$path,
            ...(branchPath.length === 0 ? [] : [branchPath]),
          ]),
        ],
        writeScope: [...writes, runPath],
        key: 'model',
      }),
    );
  } catch (error) {
    failure = error;
    console.error(error);
  }

  const currentRun = await poolNode(ctx.read, runPath);
  const currentAgent = await poolNode(ctx.read, agentNode.$path);
  const currentTask = await poolNode(ctx.read, task.$path);
  const currentPool = await poolNode(ctx.read, this.poolPath);
  const runStatus = getComponent<AiRunStatus>(currentRun, 'ai.run-status')!;
  const now = Date.now();
  const aborted =
    runStatus.status === 'aborted' ||
    (failure instanceof KernelError && failure.code === 'CANCELLED');
  const status = outcome === undefined ? (aborted ? 'aborted' : 'error') : 'done';
  const output = outcome === undefined ? String(failure) : outcome.output;
  ctx.change.patch(runPath, { $set: { result: output } });
  patchAgentComponent(ctx, currentRun, 'ai.run-status', {
    status,
    finishedAt: now,
    error: status === 'error' ? output : '',
  });
  if (outcome !== undefined) {
    patchAgentComponent(ctx, currentRun, 'ai.cost', {
      inputTokens: outcome.inputTokens,
      outputTokens: outcome.outputTokens,
      costUsd: outcome.costUsd,
    });
    saveComponent(ctx, currentAgent, 'ai.chat', { streaming: false, sessionId: outcome.sessionId });
    if (outcome.branchRequest !== undefined) {
      if (branchPath.length === 0)
        throw new KernelError('INVALID', 'Read-only run requested branch control');
      await stageNativeBranchControl(
        ctx,
        branchPath,
        outcome.branchRequest.action,
        outcome.branchRequest.args,
      );
    }
    if (job.mode === 'plan') {
      saveComponent(ctx, currentTask, 'ai.plan', {
        text: output,
        approved: false,
        feedback: '',
        createdAt: now,
      });
      ctx.change.patch(task.$path, { $set: { aiStatus: 'plan ready', updatedAt: now } });
    } else {
      const thread = getComponent<AiThread>(currentTask, 'ai.thread');
      const messages = [
        ...(thread?.messages ?? []),
        { role: agent.role, from: agentNode.$path, text: output, ts: now },
      ];
      saveComponent(ctx, currentTask, 'ai.thread', { messages });
      const assignment = getComponent<AiAssignment>(currentTask, 'ai.assignment');
      if (assignment !== undefined)
        patchAgentComponent(ctx, currentTask, 'ai.assignment', {
          cursors: { ...assignment.cursors, [agentNode.$path]: messages.length },
          nextRoles:
            job.mode === 'discuss'
              ? assignment.nextRoles.filter((role) => role !== agent.role)
              : assignment.nextRoles,
        });
      ctx.change.patch(task.$path, {
        $set: {
          aiStatus:
            job.mode === 'discuss'
              ? ''
              : outcome.branchRequest?.action === 'requestMerge'
                ? 'ready for merge review'
                : 'changes not submitted for merge',
          ...(job.mode === 'work' ? { status: 'review', result: output } : {}),
          updatedAt: now,
        },
      });
    }
  } else
    ctx.change.patch(task.$path, {
      $set: { status: 'todo', aiStatus: status, result: output, updatedAt: now },
    });
  const freshAgent = getComponent<AiAgent>(currentAgent, 'ai.agent')!;
  patchAgentComponent(ctx, currentAgent, 'ai.agent', {
    status: outcome === undefined ? (aborted ? 'blocked' : 'error') : 'idle',
    currentTask: '',
    currentRun: '',
    lastRunAt: now,
    totalTokens:
      freshAgent.totalTokens +
      (outcome === undefined ? 0 : outcome.inputTokens + outcome.outputTokens),
  });
  const poolState = getComponent<AiPool>(currentPool, 'ai.pool')!;
  patchAgentComponent(ctx, currentPool, 'ai.pool', {
    active: poolState.active.filter((path) => path !== agentNode.$path),
  });
  return { runPath, status, branchPath };
}

/** Marks interrupted saved runs pending so the normal scheduler can resume their actual workspace. */
export async function recoverPool(this: PoolConfig, ctx: WriteActionContext): Promise<void> {
  await requirePoolController(ctx);
  const pool = await poolNode(ctx.read, this.poolPath);
  for (const node of await poolAgents(ctx.read, this)) {
    const agent = getComponent<AiAgent>(node, 'ai.agent')!;
    if (agent.status !== 'working' || agent.currentRun.length === 0) continue;
    const run = await poolNode(ctx.read, agent.currentRun);
    const status = getComponent<AiRunStatus>(run, 'ai.run-status');
    if (status === undefined) throw new KernelError('INVALID', 'Saved agent run has no status');
    if (status.status === 'running' || status.status === 'pending') {
      patchAgentComponent(ctx, run, 'ai.run-status', { status: 'pending' });
      patchAgentComponent(ctx, node, 'ai.agent', { status: 'idle' });
    } else
      patchAgentComponent(ctx, node, 'ai.agent', {
        status: 'idle',
        currentRun: '',
        currentTask: '',
      });
  }
  patchAgentComponent(ctx, pool, 'ai.pool', { active: [], queue: [] });
}
