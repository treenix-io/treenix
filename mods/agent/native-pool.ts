import { getComponent } from '@treenx/core';
import { KernelError } from '@treenx/core/errors';
import type { Node, Reader, ReadActionContext } from '@treenx/core/kernel/types';
import type {
  AiAgent,
  AiAssignment,
  AiPlan,
  AiPool,
  AiRun,
  AiRunStatus,
  AiThread,
} from '#agent/types';
import type { WorkerConfig } from '#agent/native-worker';

export interface PoolConfig {
  readonly poolPath: string;
  readonly tasksPath: string;
  readonly orgPath: string;
  readonly workersPath: string;
  readonly branchesPath: string;
  readonly approvalsPath: string;
  readonly workspaceBase: string;
  readonly readScope: readonly string[];
}

export interface PoolJob {
  readonly agentPath: string;
  readonly taskPath: string;
  readonly workerPath: string;
  readonly mode: 'plan' | 'work' | 'discuss';
  readonly resume?: boolean;
}

/** Reads one native projection, retaining every refusal as a loud failure. */
export async function poolNode(read: Reader, path: string): Promise<Node> {
  const copy = (await read.read({ node: path })).copies[0];
  if ('error' in copy) throw copy.error;
  return copy.node;
}

/** Consumes only expected absence for optional office nodes and newly allocated records. */
export async function optionalPoolNode(read: Reader, path: string): Promise<Node | undefined> {
  try {
    return await poolNode(read, path);
  } catch (error) {
    if (error instanceof KernelError && error.code === 'NOT_FOUND') return undefined;
    throw error;
  }
}

/** Exhausts a native child selection without silently truncating a large office. */
export async function poolChildren(read: Reader, path: string): Promise<Node[]> {
  const nodes: Node[] = [];
  let after: string | undefined;
  do {
    const result = await read.read({
      children: path,
      window: { limit: 100, ...(after === undefined ? {} : { after }) },
    });
    for (const copy of result.copies) {
      if ('error' in copy) throw copy.error;
      nodes.push(copy.node);
    }
    after = result.next;
  } while (after !== undefined);
  return nodes;
}

/** Discovers standalone agents and composed Org posts without a legacy Tree adapter. */
export async function poolAgents(read: Reader, config: PoolConfig): Promise<Node[]> {
  const agents = (await poolChildren(read, config.poolPath)).filter(
    (node) => node.$type === 'ai.agent',
  );
  if ((await optionalPoolNode(read, config.orgPath)) === undefined) return agents;
  for (const child of await poolChildren(read, config.orgPath)) {
    const posts = child.$type === 'org.post'
      ? [child]
      : child.$type === 'org.division'
        ? await poolChildren(read, child.$path)
        : [];
    for (const post of posts)
      if (post.$type === 'org.post' && getComponent<AiAgent>(post, 'ai.agent') !== undefined)
        agents.push(post);
  }
  return agents;
}

/** Chooses the next phase while preserving the human plan-review stop. */
export function taskMode(task: Node): 'plan' | 'work' | undefined {
  if (task.status !== 'todo') return undefined;
  const plan = getComponent<AiPlan>(task, 'ai.plan');
  if (plan === undefined || plan.text.length === 0 || (!plan.approved && plan.feedback.length > 0))
    return 'plan';
  return plan.approved ? 'work' : undefined;
}

/** Routes Org assignments to their named post; ordinary tasks use the role index. */
export function taskAgent(task: Node, agents: readonly Node[], role?: string): Node | undefined {
  const run = getComponent<{ postRef: string; scope: string[] }>(task, 'org.run');
  if (role === undefined && run !== undefined && run.postRef.length > 0)
    return agents.find((node) => node.$path === run.postRef);
  return agents.find(
    (node) => getComponent<AiAgent>(node, 'ai.agent')!.role === (role ?? task.assignee),
  );
}

/** Uses persisted state to return eligible jobs; capacity and queue stay visible on the original pool. */
export async function selectPoolJobs(
  config: PoolConfig,
  ctx: ReadActionContext,
): Promise<PoolJob[]> {
  const pool = getComponent<AiPool>(await poolNode(ctx.read, config.poolPath), 'ai.pool');
  if (pool === undefined || !Number.isSafeInteger(pool.maxConcurrent) || pool.maxConcurrent < 1)
    throw new KernelError('INVALID', 'Pool capacity must be a positive integer');
  const agents = await poolAgents(ctx.read, config);
  const idle = agents.filter((node) => getComponent<AiAgent>(node, 'ai.agent')!.status === 'idle');
  const workers = new Map<string, string>();
  for (const node of await poolChildren(ctx.read, config.workersPath)) {
    if (node.$type !== 'ai.worker') continue;
    const worker = getComponent<WorkerConfig>(node, 'ai.worker')!;
    if (worker.poolPath !== ctx.node.$path)
      throw new KernelError('INVALID', 'Worker belongs to another pool');
    if (workers.has(worker.agentPath))
      throw new KernelError('CONFLICT', 'Agent has multiple native workers');
    workers.set(worker.agentPath, node.$path);
  }
  const jobs: PoolJob[] = [];
  const selected = new Set<string>();

  /** Requires an administrator-provisioned worker before scheduling this genuine agent. */
  function add(agent: Node, taskPath: string, mode: PoolJob['mode'], resume = false): void {
    if (selected.has(agent.$path)) return;
    const workerPath = workers.get(agent.$path);
    if (workerPath === undefined)
      throw new KernelError('UNAVAILABLE', `Provision a native worker for ${agent.$path}`);
    selected.add(agent.$path);
    jobs.push({
      agentPath: agent.$path,
      taskPath,
      workerPath,
      mode,
      ...(resume ? { resume: true } : {}),
    });
  }

  for (const agent of idle) {
    const config = getComponent<AiAgent>(agent, 'ai.agent')!;
    if (config.currentRun.length === 0) continue;
    const run = await poolNode(ctx.read, config.currentRun);
    const status = getComponent<AiRunStatus>(run, 'ai.run-status');
    const data = getComponent<AiRun>(run, 'ai.run');
    if (
      status === undefined ||
      data === undefined ||
      status.status !== 'pending' ||
      data.mode === 'chat'
    )
      throw new KernelError('INVALID', 'Agent has no resumable native run');
    add(agent, data.taskRef, data.mode, true);
  }

  for (const task of await poolChildren(ctx.read, config.tasksPath)) {
    if (task.$type !== 'board.task') continue;
    const assignment = getComponent<AiAssignment>(task, 'ai.assignment');
    for (const role of assignment?.nextRoles ?? []) {
      const agent = taskAgent(
        task,
        idle.filter((node) => !selected.has(node.$path)),
        role,
      );
      if (agent !== undefined) add(agent, task.$path, 'discuss');
    }
    const mode = taskMode(task);
    if (mode === undefined) continue;
    const agent = taskAgent(
      task,
      idle.filter((node) => !selected.has(node.$path)),
    );
    if (agent !== undefined) add(agent, task.$path, mode);
  }
  return jobs;
}

/** Composes the task, approved plan, Org hat and unread discussion for the selected phase. */
export function poolPrompt(job: PoolJob, task: Node, agent: Node): string {
  const assignment = getComponent<AiAssignment>(task, 'ai.assignment');
  const thread = getComponent<AiThread>(task, 'ai.thread');
  const plan = getComponent<AiPlan>(task, 'ai.plan');
  const cursor = assignment?.cursors[agent.$path] ?? 0;
  const messages = (thread?.messages ?? [])
    .slice(cursor)
    .map((message) => `${message.role}: ${message.text}`)
    .join('\n');
  const hat = agent.$type === 'org.post' ? agent.hat : '';
  const instruction =
    job.mode === 'plan'
      ? 'Write a numbered execution plan, expected outcomes and risks. Make no changes. A human must approve before work.'
      : job.mode === 'discuss'
        ? 'Share a concise discussion response. Make no changes.'
        : 'Follow the approved plan in your isolated workspace. Request merge when ready for human review.';
  return `Task: ${task.title}\n${task.description}\nHat: ${hat}\nPlan: ${plan?.text ?? ''}\nFeedback: ${plan?.feedback ?? ''}\nDiscussion:\n${messages}\n${instruction}${job.resume ? '\nContinue the interrupted run in its existing workspace.' : ''}`;
}
