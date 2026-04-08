// Agent Office — orchestrator service on /agents node.
// Two modes: DISCUSS (lightweight multi-agent chat) and WORK (full agent run).
// Watches /board/data for tasks. Manages concurrency pool.
// Deterministic routing — no LLM tokens burned on orchestration.

import { invokeClaude } from '#metatron/claude';
import { type Class, type ComponentData, createNode, getComponent, type NodeData, register } from '@treenity/core';
import { setComponent } from '@treenity/core/comp';
import type { ServiceCtx } from '@treenity/core/contexts/service';
import { createLogger } from '@treenity/core/log';
import type { ActionCtx } from '@treenity/core/server/actions';
import { debouncedWrite } from '@treenity/core/util/debounced-write';
import dayjs from 'dayjs';
import { buildPermissionRules, createCanUseTool, reconcileOnStartup } from './guardian';
import {
  AiAgent,
  AiAssignment,
  AiChat,
  AiCost,
  AiLog,
  AiPlan,
  AiPool,
  AiRunStatus,
  AiThread,
  type LogEntry,
  type ThreadMessage,
} from './types';

const log = createLogger('agent-office');

const makeRunId = () => `r-${dayjs().format('YYMMDD-HHmmss')}-${Math.random().toString(36).slice(2, 5)}`;

const MAX_OCC_RETRIES = 3;

/** Re-read + mutate + write with OCC retry. Returns fresh node. */
async function updateNode(
  store: ServiceCtx['tree'],
  path: string,
  mutate: (node: NodeData) => void,
): Promise<NodeData | null> {
  for (let attempt = 0; attempt < MAX_OCC_RETRIES; attempt++) {
    const node = await store.get(path);
    if (!node) return null;
    mutate(node);
    try {
      await store.set(node);
      return node;
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('OptimisticConcurrencyError') && attempt < MAX_OCC_RETRIES - 1) {
        log.warn(`OCC conflict on ${path}, retry ${attempt + 1}`);
        continue;
      }
      throw err;
    }
  }
  return null;
}

/** Update a specific component on a node with OCC retry. Mutates in-place (getComponent returns a ref). */
async function updateComp<T>(
  store: ServiceCtx['tree'],
  path: string,
  Type: Class<T>,
  mutate: (comp: ComponentData<T>) => void,
): Promise<NodeData | null> {
  return updateNode(store, path, (node) => {
    const comp = getComponent(node, Type);
    if (!comp) return;
    mutate(comp);
  });
}

// ── Prompt builders ──

function threadSince(task: NodeData, cursor: number): string {
  const thread = getComponent(task, AiThread);
  if (!thread?.messages?.length) return '';
  const msgs = thread.messages.slice(cursor);
  if (!msgs.length) return '';
  return '\n## Discussion\n' + msgs.map(m =>
    `**${m.role}** (${m.from}): ${m.text}`
  ).join('\n') + '\n';
}

function buildWorkPrompt(role: string, task: NodeData, agent: NodeData, cursor: number): string {
  const title = task.title || '(untitled)';
  const desc = task.description || '';

  const agentComp = getComponent(agent, AiAgent);
  const base = agentComp?.systemPrompt
    ? String(agentComp.systemPrompt)
    : `You are a ${role} agent for the Treenity project.`;

  // Include org.post hat if agent lives on an org.post node
  const hat = agent.$type === 'org.post' && typeof agent.hat === 'string' && agent.hat
    ? `\n## Hat\n${agent.hat}\n`
    : '';

  const plan = getComponent(task, AiPlan);
  const planSection = plan?.text && plan.approved
    ? `\n## Approved Plan\n${plan.text}\n${plan.feedback ? `\n### Human feedback\n${plan.feedback}\n` : ''}`
    : '';

  return `${base}
${hat}
## Current Task
**${title}**
${desc}
${planSection}${threadSince(task, cursor)}
## Instructions
- Follow the approved plan above${plan?.feedback ? ' — incorporate the feedback' : ''}
- Use MCP tools to inspect the codebase and tree
- Complete the task according to your role
- Be concise in your response
- Report what you did and the result`;
}

function buildDiscussPrompt(role: string, task: NodeData, cursor: number): string {
  const title = task.title || '(untitled)';
  const desc = task.description || '';

  return `You are a ${role} agent. You've been asked to join a discussion on a task.

## Task
**${title}**
${desc}
${threadSince(task, cursor)}
## Instructions
- Read the discussion above
- Share your perspective as a ${role}
- Be concise — one short paragraph
- Do NOT start working on the task — discussion only`;
}

function buildPlanPrompt(role: string, task: NodeData, agent: NodeData, cursor: number): string {
  const title = task.title || '(untitled)';
  const desc = task.description || '';

  const agentComp = getComponent(agent, AiAgent);
  const base = agentComp?.systemPrompt
    ? String(agentComp.systemPrompt)
    : `You are a ${role} agent for the Treenity project.`;

  const hat = agent.$type === 'org.post' && typeof agent.hat === 'string' && agent.hat
    ? `\n## Hat\n${agent.hat}\n`
    : '';

  const plan = getComponent(task, AiPlan);
  const prevPlanSection = plan?.text && plan.feedback
    ? `\n## Your previous plan (REJECTED)\n${plan.text}\n`
    : '';
  const feedbackSection = plan?.feedback
    ? `\n## Feedback on previous plan\n${plan.feedback}\n`
    : '';

  return `${base}
${hat}
## Task — PLAN ONLY
**${title}**
${desc}
${prevPlanSection}${feedbackSection}${threadSince(task, cursor)}
## Instructions — PLANNING MODE
You must write a detailed execution plan. Do NOT execute anything yet.

1. **Analyze** the task — use MCP tools to read current state, understand context
2. **Write a plan** — numbered steps, specific files/nodes to change, expected outcomes
3. **Identify risks** — what could go wrong, what needs clarification
4. **Estimate scope** — small (< 5 changes), medium, large

Output your plan as structured markdown. The human will review, comment, and approve before you execute.

**DO NOT make any changes. Planning only.**`;
}

// ── Pool management ──

function poolAcquire(pool: AiPool, agentPath: string): boolean {
  // Guard against duplicate active entries (race: concurrent processInbox calls)
  if (pool.active.includes(agentPath)) return false;

  if (pool.active.length >= pool.maxConcurrent) {
    if (!pool.queue.includes(agentPath)) pool.queue.push(agentPath);
    return false;
  }
  pool.active.push(agentPath);
  pool.queue = pool.queue.filter(p => p !== agentPath);
  return true;
}

function poolRelease(pool: AiPool, agentPath: string): string | null {
  pool.active = pool.active.filter(p => p !== agentPath);
  return pool.queue.shift() ?? null;
}

// ── Discussion runner (lightweight) ──

async function discussAgent(
  agentNode: NodeData,
  taskNode: NodeData,
  store: ServiceCtx['tree'],
  poolPath: string,
) {
  const agent = getComponent(agentNode, AiAgent);
  if (!agent) throw new Error(`not an ai.agent: ${agentNode.$path}`);

  const role = agent.role;
  const assignment = getComponent(taskNode, AiAssignment);
  const cursor = assignment?.cursors?.[agentNode.$path] ?? 0;
  const prompt = buildDiscussPrompt(role, taskNode, cursor);

  log.info(`discuss: ${role} on ${taskNode.$path}`);

  try {
    const result = await invokeClaude(prompt, {
      key: `discuss:${agentNode.$path}:${taskNode.$path}`,
      model: 'claude-haiku-4-5-20251001',
    });

    const text = (result.text || '').trim();
    if (!text) return;

    // Post to thread
    await updateNode(store, taskNode.$path, (freshTask) => {
      const thread = getComponent(freshTask, AiThread) ?? { $type: 'ai.thread' as const, messages: [] as ThreadMessage[] };
      thread.messages.push({ role, from: agentNode.$path, text, ts: Date.now() });
      setComponent(freshTask, AiThread, thread);

      const asgn = getComponent(freshTask, AiAssignment);
      if (asgn) {
        asgn.cursors = { ...asgn.cursors, [agentNode.$path]: thread.messages.length };
        asgn.nextRoles = asgn.nextRoles.filter(r => r !== role);
        setComponent(freshTask, AiAssignment, asgn);
      }

      const remainingRoles = asgn?.nextRoles?.length ?? 0;
      if (remainingRoles === 0) freshTask.aiStatus = '';
    });
    log.info(`discuss: ${role} posted to ${taskNode.$path} — cost=$${result.costUsd ?? '?'}`);

  } catch (err) {
    log.error(`discuss FAILED: ${role} on ${taskNode.$path}:`, err);
  } finally {
    await updateComp(store, agentNode.$path, AiAgent, (c) => {
      c.status = 'idle';
      c.currentTask = '';
    });

    await updateComp(store, poolPath, AiPool, (c) => {
      poolRelease(c, agentNode.$path);
    });
  }
}

// ── Work runner (full agent → ai.run with live streaming) ──

async function runAgent(
  agentNode: NodeData,
  taskNode: NodeData,
  store: ServiceCtx['tree'],
  poolPath: string,
) {
  const agent = getComponent(agentNode, AiAgent);
  if (!agent) throw new Error(`not an ai.agent: ${agentNode.$path}`);

  const role = agent.role;
  const chat = getComponent(agentNode, AiChat);
  const assignment = getComponent(taskNode, AiAssignment);
  const cursor = assignment?.cursors?.[agentNode.$path] ?? 0;
  const prompt = buildWorkPrompt(role, taskNode, agentNode, cursor);
  const permissionRules = buildPermissionRules(role);
  const canUseTool = createCanUseTool(role, agentNode.$path, store);

  // Create ai.run with ECS components for structured observability
  const runId = makeRunId();
  const runPath = `${agentNode.$path}/runs/${runId}`;

  const queryKey = agentNode.$path;
  const runNode = createNode(runPath, 'ai.run', {
    taskRef: taskNode.$path,
    prompt,
    result: '',
    mode: 'work' as const,
    queryKey,
  });
  setComponent(runNode, AiRunStatus, { status: 'running', startedAt: Date.now(), finishedAt: 0, error: '' });
  setComponent(runNode, AiLog, { entries: [] });
  setComponent(runNode, AiCost, { inputTokens: 0, outputTokens: 0, costUsd: 0, model: agent.model || '' });
  await store.set(runNode);

  // Save currentRun on agent + board task for UI linkage
  await updateComp(store, agentNode.$path, AiAgent, (c) => {
    c.currentRun = runPath;
  });
  await updateNode(store, taskNode.$path, (n) => {
    n.currentRun = runPath;
  });

  log.info(`work: ${role} agent ${agentNode.$path} on task ${taskNode.$path} → ${runPath}`);

  // Streaming progress — debounced writes to ai.log.entries every 2s
  const streamEntries: LogEntry[] = [];
  const progress = debouncedWrite(async () => {
    await updateNode(store, runPath, (n) => {
      const logComp = getComponent(n, AiLog);
      if (logComp) logComp.entries = [...streamEntries];
    });
  }, 2000, 'agent.progress');

  const onLogEntry = (entry: LogEntry) => {
    streamEntries.push(entry);
    progress.trigger();
  };

  try {
    const result = await invokeClaude(prompt, {
      key: agentNode.$path,
      sessionId: chat?.sessionId || undefined,
      model: agent.model || undefined,
      permissionRules,
      canUseTool,
      onLogEntry,
    });

    progress.cancel();

    // Finalize ai.run — update all ECS components
    const finalStatus = result.aborted ? 'aborted' : result.error ? 'error' : 'done';
    await updateNode(store, runPath, (n) => {
      n.result = result.aborted
        ? (result.text || '[interrupted]')
        : (result.text || result.output);

      const logComp = getComponent(n, AiLog);
      if (logComp) logComp.entries = result.logEntries;

      const statusComp = getComponent(n, AiRunStatus);
      if (statusComp) {
        statusComp.status = finalStatus;
        statusComp.finishedAt = Date.now();
        if (result.error) statusComp.error = result.text || 'unknown error';
      }

      const costComp = getComponent(n, AiCost);
      if (costComp) costComp.costUsd = result.costUsd ?? 0;
    });

    // Save sessionId to ai.chat on agent node
    await updateNode(store, agentNode.$path, (n) => {
      const c = getComponent(n, AiChat);
      if (c) c.sessionId = result.sessionId ?? '';
    });

    // Update agent: complete
    await updateComp(store, agentNode.$path, AiAgent, (c) => {
      c.status = 'idle';
      c.currentTask = '';
      c.currentRun = '';
      c.lastRunAt = Date.now();
      c.totalTokens = (c.totalTokens || 0) + (result.costUsd ? Math.round(result.costUsd * 100000) : 0);
    });

    // Post result to board task thread + update status
    const text = result.text || result.output || '(no output)';
    await updateNode(store, taskNode.$path, (freshTask) => {
      const thread = getComponent(freshTask, AiThread) ?? { $type: 'ai.thread' as const, messages: [] as ThreadMessage[] };
      thread.messages.push({ role, from: agentNode.$path, text, ts: Date.now() });
      setComponent(freshTask, AiThread, thread);

      const asgn = getComponent(freshTask, AiAssignment);
      if (asgn) {
        asgn.cursors = { ...asgn.cursors, [agentNode.$path]: thread.messages.length };
        setComponent(freshTask, AiAssignment, asgn);
      }

      freshTask.status = 'review';
      freshTask.aiStatus = '✅ done';
      freshTask.result = text;
      freshTask.updatedAt = Date.now();
    });

    log.info(`work: ${role} done on ${taskNode.$path} — cost=$${result.costUsd ?? '?'}`);

  } catch (err) {
    const stack = err instanceof Error ? err.stack ?? err.message : String(err);
    log.error(`work: ${role} FAILED on ${taskNode.$path}:`, err);

    progress.cancel();

    // Mark ai.run as error
    await updateNode(store, runPath, (n) => {
      n.result = `Error: ${stack}`;
      const logComp = getComponent(n, AiLog);
      if (logComp) logComp.entries = [...streamEntries, { ts: Date.now(), type: 'text' as const, output: `Error: ${stack}` }];
      const statusComp = getComponent(n, AiRunStatus);
      if (statusComp) {
        statusComp.status = 'error';
        statusComp.finishedAt = Date.now();
        statusComp.error = stack;
      }
    });

    await updateComp(store, agentNode.$path, AiAgent, (c) => {
      c.status = 'error';
      c.currentTask = '';
      c.currentRun = '';
    });

    await updateNode(store, taskNode.$path, (n) => {
      n.status = 'todo';
      n.aiStatus = '❌ error';
      n.result = `Agent error: ${stack}`;
      n.updatedAt = Date.now();
    });
  } finally {
    await updateComp(store, poolPath, AiPool, (c) => {
      poolRelease(c, agentNode.$path);
    });
  }
}

// ── Plan runner (lightweight — write plan only, no execution) ──

async function planAgent(
  agentNode: NodeData,
  taskNode: NodeData,
  store: ServiceCtx['tree'],
  poolPath: string,
) {
  const agent = getComponent(agentNode, AiAgent);
  if (!agent) throw new Error(`not an ai.agent: ${agentNode.$path}`);

  const role = agent.role;
  const chat = getComponent(agentNode, AiChat);
  const assignment = getComponent(taskNode, AiAssignment);
  const cursor = assignment?.cursors?.[agentNode.$path] ?? 0;
  const prompt = buildPlanPrompt(role, taskNode, agentNode, cursor);

  // Plan mode: policy-enforced read-only (not just prompt-constrained)
  const canUseTool = createCanUseTool(role, agentNode.$path, store, { readOnly: true });

  // Create ai.run for plan mode — same ECS observability as work mode
  const runId = makeRunId();
  const runPath = `${agentNode.$path}/runs/${runId}`;

  const queryKey = `plan:${agentNode.$path}`;
  const runNode = createNode(runPath, 'ai.run', {
    taskRef: taskNode.$path,
    prompt,
    result: '',
    mode: 'plan' as const,
    queryKey,
  });
  setComponent(runNode, AiRunStatus, { status: 'running', startedAt: Date.now(), finishedAt: 0, error: '' });
  setComponent(runNode, AiLog, { entries: [] });
  setComponent(runNode, AiCost, { inputTokens: 0, outputTokens: 0, costUsd: 0, model: agent.model || '' });
  await store.set(runNode);

  await updateComp(store, agentNode.$path, AiAgent, (c) => {
    c.currentRun = runPath;
  });

  log.info(`plan: ${role} agent ${agentNode.$path} planning for ${taskNode.$path} → ${runPath}`);

  try {
    const result = await invokeClaude(prompt, {
      key: `plan:${agentNode.$path}`,
      sessionId: chat?.sessionId || undefined,
      model: agent.model || undefined,
      canUseTool,
    });

    const planText = (result.text || result.output || '').trim();

    // Finalize ai.run
    await updateNode(store, runPath, (n) => {
      n.result = planText;
      const statusComp = getComponent(n, AiRunStatus);
      if (statusComp) { statusComp.status = 'done'; statusComp.finishedAt = Date.now(); }
      const costComp = getComponent(n, AiCost);
      if (costComp) costComp.costUsd = result.costUsd ?? 0;
      const logComp = getComponent(n, AiLog);
      if (logComp) logComp.entries = result.logEntries;
    });

    // Save sessionId to ai.chat
    await updateNode(store, agentNode.$path, (n) => {
      const c = getComponent(n, AiChat);
      if (c) c.sessionId = result.sessionId ?? '';
    });

    // Save plan as ai.plan component on the task
    await updateNode(store, taskNode.$path, (freshTask) => {
      const plan = getComponent(freshTask, AiPlan) ?? new AiPlan();
      plan.text = planText;
      plan.approved = false;
      plan.feedback = '';
      plan.createdAt = Date.now();
      setComponent(freshTask, AiPlan, plan);

      freshTask.aiStatus = '📋 plan ready';
      freshTask.updatedAt = Date.now();
    });

    log.info(`plan: ${role} plan ready for ${taskNode.$path} — cost=$${result.costUsd ?? '?'}`);

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`plan: ${role} FAILED on ${taskNode.$path}:`, err);

    await updateNode(store, runPath, (n) => {
      n.result = `Plan error: ${msg}`;
      const statusComp = getComponent(n, AiRunStatus);
      if (statusComp) { statusComp.status = 'error'; statusComp.finishedAt = Date.now(); statusComp.error = msg; }
    });

    await updateNode(store, taskNode.$path, (n) => {
      n.aiStatus = '❌ plan failed';
      n.result = `Plan error: ${msg}`;
      n.updatedAt = Date.now();
    });
  } finally {
    await updateComp(store, agentNode.$path, AiAgent, (c) => {
      c.status = 'idle';
      c.currentTask = '';
      c.currentRun = '';
    });

    await updateComp(store, poolPath, AiPool, (c) => {
      poolRelease(c, agentNode.$path);
    });
  }
}

// ── Actions on /agents node ──

/** @description Manually trigger inbox scan */
register('ai.pool', 'action:scan', async (_ctx: ActionCtx) => {
  log.info('manual scan triggered');
}, { description: 'Trigger inbox scan for pending tasks' });

// ── Orchestrator service ──

register('ai.pool', 'service', async (node: NodeData, ctx: ServiceCtx) => {
  let stopped = false;
  const poolPath = node.$path;

  log.info(`orchestrator started at ${poolPath}`);

  // Clean up orphaned approvals, stuck agents/tasks from previous run
  // Returns agents that can be resumed (have sessionId + currentTask)
  const resumable = await reconcileOnStartup(ctx.tree);

  async function getAgents(): Promise<NodeData[]> {
    const { items } = await ctx.tree.getChildren(poolPath);
    return items.filter(n => n.$type === 'ai.agent');
  }

  /** Collect org.post nodes that have ai.agent components */
  async function getOrgAgents(): Promise<NodeData[]> {
    const orgPosts: NodeData[] = [];
    try {
      const orgNode = await ctx.tree.get('/org');
      if (!orgNode) return orgPosts;
      const { items: divisions } = await ctx.tree.getChildren('/org');
      for (const div of divisions) {
        if (div.$type !== 'org.division') continue;
        const { items: posts } = await ctx.tree.getChildren(div.$path);
        for (const post of posts) {
          if (post.$type === 'org.post' && getComponent(post, AiAgent)) orgPosts.push(post);
        }
      }
    } catch {
      // org tree may not exist
    }
    return orgPosts;
  }

  /** Resolve org.run component on a task (duck-typed, no org import) */
  function getOrgRun(task: NodeData): { postRef: string; scope: string[] } | null {
    for (const k of Object.keys(task)) {
      const v = task[k];
      if (v && typeof v === 'object' && '$type' in v && (v as ComponentData).$type === 'org.run') {
        const run = v as Record<string, unknown>;
        if (typeof run.postRef === 'string' && run.postRef) {
          return { postRef: run.postRef, scope: Array.isArray(run.scope) ? run.scope as string[] : [] };
        }
      }
    }
    return null;
  }

  /** Build a map of role → idle agents (dynamic, no hardcoded roles).
   *  Discovers agents both under /agents and on org.post nodes. */
  async function buildRoleIndex(): Promise<Map<string, NodeData[]>> {
    const agents = await getAgents();
    const orgAgents = await getOrgAgents();
    const all = [...agents, ...orgAgents];
    const index = new Map<string, NodeData[]>();

    for (const a of all) {
      const comp = getComponent(a, AiAgent);
      if (!comp || comp.status !== 'idle') continue;
      const list = index.get(comp.role) ?? [];
      list.push(a);
      index.set(comp.role, list);
    }

    return index;
  }

  let processing = false;
  let pendingRerun = false;

  async function processInbox() {
    if (stopped) return;
    if (processing) { pendingRerun = true; return; }
    processing = true;

    try {
      const roleIndex = await buildRoleIndex();
      if (!roleIndex.size) return;

      const { items: boardTasks } = await ctx.tree.getChildren('/board/data');
      const poolNode = await ctx.tree.get(poolPath);
      if (!poolNode) return;
      const pool = getComponent(poolNode, AiPool) ?? new AiPool();
      let poolDirty = false;

      for (const task of boardTasks) {
        if (task.$type !== 'board.task') continue;

        // ── Discussion mode: nextRoles on ai.assignment ──
        const assignment = getComponent(task, AiAssignment);
        if (assignment?.nextRoles?.length) {
          for (const role of [...assignment.nextRoles]) {
            const idleAgents = roleIndex.get(role);
            if (!idleAgents?.length) continue;

            const agent = idleAgents[0];
            if (!poolAcquire(pool, agent.$path)) continue;
            poolDirty = true;
            idleAgents.shift();

            // Mark agent busy + get fresh node for runner
            const readyAgent = await updateComp(ctx.tree, agent.$path, AiAgent, (c) => {
              c.status = 'working';
              c.currentTask = task.$path;
            });
            if (!readyAgent) continue;

            // Tag task with AI status
            await updateNode(ctx.tree, task.$path, (n) => {
              n.aiStatus = `💬 ${role} discussing`;
            });

            discussAgent(readyAgent, task, ctx.tree, poolPath).catch(err => log.error('discussAgent error:', err));
          }
        }

        // ── Work mode: status=todo, route by org.run.postRef or assignee ──
        if (task.status !== 'todo') continue;

        // Resolve role: org.run.postRef takes priority over assignee
        const orgRun = getOrgRun(task);
        let role: string | undefined;
        let targetAgentPath: string | undefined;

        if (orgRun) {
          // org.run routing: resolve postRef → post node → ai.agent → role
          try {
            const postNode = await ctx.tree.get(orgRun.postRef);
            if (postNode) {
              const postAgent = getComponent(postNode, AiAgent);
              if (postAgent) {
                role = postAgent.role;
                targetAgentPath = postNode.$path;
              }
            }
          } catch { /* post not found — fall through to assignee */ }
        }

        if (!role && typeof task.assignee === 'string') {
          role = task.assignee as string;
        }

        if (role) {

          // Plan mode: check if task has an approved plan
          const plan = getComponent(task, AiPlan);
          const needsPlan = !plan || !plan.text;
          const planRejected = plan && plan.text && !plan.approved && !!plan.feedback;
          const planPending = plan && plan.text && !plan.approved && !plan.feedback;

          // Plan exists but not approved and no feedback → waiting for human review
          if (planPending) continue;

          const idleAgents = roleIndex.get(role);
          if (!idleAgents?.length) continue;

          // org.run targets a specific post agent; otherwise take first idle
          let agentIdx = 0;
          if (targetAgentPath) {
            const idx = idleAgents.findIndex(a => a.$path === targetAgentPath);
            if (idx < 0) continue; // target agent not idle
            agentIdx = idx;
          }

          const agent = idleAgents[agentIdx];
          if (!poolAcquire(pool, agent.$path)) {
            log.warn(`pool full, ${agent.$path} queued`);
            continue;
          }
          poolDirty = true;
          idleAgents.splice(agentIdx, 1);

          const readyAgent = await updateComp(ctx.tree, agent.$path, AiAgent, (c) => {
            c.status = 'working';
            c.currentTask = task.$path;
          });
          if (!readyAgent) continue;

          if (needsPlan || planRejected) {
            // Phase 1: agent writes (or rewrites) a plan
            await updateNode(ctx.tree, task.$path, (n) => {
              n.aiStatus = `📝 ${role} planning`;
              n.updatedAt = Date.now();
            });
            planAgent(readyAgent, task, ctx.tree, poolPath).catch(err => log.error('planAgent error:', err));
          } else {
            // Phase 2: plan approved → execute
            await updateNode(ctx.tree, task.$path, (n) => {
              n.status = 'doing';
              n.aiStatus = `⚡ ${role} working`;
              n.updatedAt = Date.now();
            });
            runAgent(readyAgent, task, ctx.tree, poolPath).catch(err => log.error('runAgent error:', err));
          }
        }
      }

      if (poolDirty) {
        await updateComp(ctx.tree, poolPath, AiPool, (c) => {
          c.active = pool.active;
          c.queue = pool.queue;
        });
      }

    } catch (err) {
      log.error('processInbox error:', err);
    } finally {
      processing = false;
      if (pendingRerun) { pendingRerun = false; processInbox(); }
    }
  }

  const unsubBoard = ctx.subscribe('/board/data', (event) => {
    if (event.type === 'set' || event.type === 'patch') processInbox();
  }, { children: true });

  const unsubAgents = ctx.subscribe(poolPath, (event) => {
    if (event.type === 'set' || event.type === 'patch') processInbox();
  }, { children: true });

  processInbox();

  // Resume agents that were working before restart (have saved sessionId)
  for (const { agentPath, taskPath } of resumable) {
    const agentNode = await ctx.tree.get(agentPath);
    const taskNode = await ctx.tree.get(taskPath);
    if (!agentNode || !taskNode) {
      log.warn(`resume: skipping ${agentPath} — agent or task not found`);
      continue;
    }
    log.info(`resume: re-launching ${agentPath} on ${taskPath}`);
    runAgent(agentNode, taskNode, ctx.tree, poolPath).catch(err => log.error('resume runAgent error:', err));
  }

  return {
    stop: async () => {
      log.info('orchestrator stopping');
      stopped = true;
      unsubBoard();
      unsubAgents();
    },
  };
});
