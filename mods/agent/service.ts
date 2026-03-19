// Agent Office — orchestrator service on /agents node.
// Two modes: DISCUSS (lightweight multi-agent chat) and WORK (full agent run).
// Watches /board/data for tasks. Manages concurrency pool.
// Deterministic routing — no LLM tokens burned on orchestration.

import { invokeClaude } from '#metatron/claude';
import { MetatronConfig } from '#metatron/types';
import { type Class, type ComponentData, createNode, getComponent, type NodeData, register } from '@treenity/core';
import { setComponent } from '@treenity/core/comp';
import type { ServiceCtx } from '@treenity/core/contexts/service';
import { createLogger } from '@treenity/core/log';
import type { ActionCtx } from '@treenity/core/server/actions';
import { debouncedWrite } from '@treenity/core/util/debounced-write';
import { buildPermissionRules, createCanUseTool, reconcileOnStartup } from './guardian';
import { AiAgent, AiAssignment, AiPlan, AiPool, AiThread, type ThreadMessage } from './types';

const log = createLogger('agent-office');

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

  const config = getComponent(agent, MetatronConfig);
  if (!config) throw new Error(`agent ${agent.$path} missing metatron.config component`);

  const base = config.systemPrompt
    ? String(config.systemPrompt)
    : `You are a ${role} agent for the Treenity project.`;

  const plan = getComponent(task, AiPlan);
  const planSection = plan?.text && plan.approved
    ? `\n## Approved Plan\n${plan.text}\n${plan.feedback ? `\n### Human feedback\n${plan.feedback}\n` : ''}`
    : '';

  return `${base}

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

  const config = getComponent(agent, MetatronConfig);
  if (!config) throw new Error(`agent ${agent.$path} missing metatron.config component`);

  const base = config.systemPrompt
    ? String(config.systemPrompt)
    : `You are a ${role} agent for the Treenity project.`;

  const plan = getComponent(task, AiPlan);
  const prevPlanSection = plan?.text && plan.feedback
    ? `\n## Your previous plan (REJECTED)\n${plan.text}\n`
    : '';
  const feedbackSection = plan?.feedback
    ? `\n## Feedback on previous plan\n${plan.feedback}\n`
    : '';

  return `${base}

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

// ── Work runner (full agent → metatron.task with live streaming) ──

async function runAgent(
  agentNode: NodeData,
  taskNode: NodeData,
  store: ServiceCtx['tree'],
  poolPath: string,
) {
  const agent = getComponent(agentNode, AiAgent);
  if (!agent) throw new Error(`not an ai.agent: ${agentNode.$path}`);

  const config = getComponent(agentNode, MetatronConfig);
  if (!config) throw new Error(`agent ${agentNode.$path} missing metatron.config component`);

  const role = agent.role;
  const assignment = getComponent(taskNode, AiAssignment);
  const cursor = assignment?.cursors?.[agentNode.$path] ?? 0;
  const prompt = buildWorkPrompt(role, taskNode, agentNode, cursor);
  const permissionRules = buildPermissionRules(role);
  const canUseTool = createCanUseTool(role, agentNode.$path, store);

  // Create metatron.task for live streaming + structured log (D29)
  const taskId = `t-${Date.now()}`;
  const mtTaskPath = `${agentNode.$path}/tasks/${taskId}`;

  await store.set(createNode(mtTaskPath, 'metatron.task', {
    prompt,
    status: 'running',
    createdAt: Date.now(),
  }));

  // Save taskRef on agent + board task for UI linkage
  await updateComp(store, agentNode.$path, AiAgent, (c) => {
    c.taskRef = mtTaskPath;
  });
  await updateNode(store, taskNode.$path, (n) => {
    n.taskRef = mtTaskPath;
  });

  log.info(`work: ${role} agent ${agentNode.$path} on task ${taskNode.$path} → ${mtTaskPath}`);

  // Streaming progress — debounced writes to metatron.task.log every 2s
  let tailBuf = '';
  const progress = debouncedWrite(async () => {
    const t = await store.get(mtTaskPath);
    if (t && t.status === 'running') {
      const { $rev: _, ...rest } = t;
      await store.set({ ...rest, log: tailBuf });
    }
  }, 2000, 'agent.progress');

  const onOutput = (chunk: string) => {
    tailBuf += chunk;
    progress.trigger();
  };

  try {
    const result = await invokeClaude(prompt, {
      key: agentNode.$path,
      sessionId: config.sessionId || undefined,
      model: config.model || undefined,
      permissionRules,
      canUseTool,
      onOutput,
    });

    progress.cancel();

    // Finalize metatron.task
    const finalStatus = result.aborted ? 'done' : result.error ? 'error' : 'done';
    const mtTask = await store.get(mtTaskPath);
    if (mtTask) {
      await store.set({
        ...mtTask,
        status: finalStatus,
        log: result.output,
        result: result.aborted
          ? (result.text || '[interrupted]')
          : (result.text || result.output),
      });
    }

    // Save sessionId to metatron.config on agent node
    await updateNode(store, agentNode.$path, (n) => {
      const cfg = getComponent(n, MetatronConfig);
      if (cfg) cfg.sessionId = result.sessionId ?? '';
    });

    // Update agent: complete
    await updateComp(store, agentNode.$path, AiAgent, (c) => {
      c.status = 'idle';
      c.currentTask = '';
      c.taskRef = '';
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

    // Mark metatron.task as error
    const mtTask = await store.get(mtTaskPath);
    if (mtTask) {
      await store.set({ ...mtTask, status: 'error', log: tailBuf, result: `Error: ${stack}` });
    }

    await updateComp(store, agentNode.$path, AiAgent, (c) => {
      c.status = 'error';
      c.currentTask = '';
      c.taskRef = '';
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

  const config = getComponent(agentNode, MetatronConfig);
  if (!config) throw new Error(`agent ${agentNode.$path} missing metatron.config component`);

  const role = agent.role;
  const assignment = getComponent(taskNode, AiAssignment);
  const cursor = assignment?.cursors?.[agentNode.$path] ?? 0;
  const prompt = buildPlanPrompt(role, taskNode, agentNode, cursor);

  // Plan mode uses read-only tools only — no writes, no execution
  const canUseTool = createCanUseTool(role, agentNode.$path, store);

  log.info(`plan: ${role} agent ${agentNode.$path} planning for ${taskNode.$path}`);

  try {
    const result = await invokeClaude(prompt, {
      key: `plan:${agentNode.$path}`,
      sessionId: config.sessionId || undefined,
      model: config.model || undefined,
      canUseTool,
    });

    const planText = (result.text || result.output || '').trim();

    // Save sessionId
    await updateNode(store, agentNode.$path, (n) => {
      const cfg = getComponent(n, MetatronConfig);
      if (cfg) cfg.sessionId = result.sessionId ?? '';
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

    await updateNode(store, taskNode.$path, (n) => {
      n.aiStatus = '❌ plan failed';
      n.result = `Plan error: ${msg}`;
      n.updatedAt = Date.now();
    });
  } finally {
    await updateComp(store, agentNode.$path, AiAgent, (c) => {
      c.status = 'idle';
      c.currentTask = '';
      c.taskRef = '';
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

  /** Build a map of role → idle agents (dynamic, no hardcoded roles) */
  async function buildRoleIndex(): Promise<Map<string, NodeData[]>> {
    const agents = await getAgents();
    const index = new Map<string, NodeData[]>();

    for (const a of agents) {
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

        // ── Work mode: assignee + status=todo ──
        if (task.status === 'todo' && typeof task.assignee === 'string') {
          const role = task.assignee as string;

          // Plan mode: check if task has an approved plan
          const plan = getComponent(task, AiPlan);
          const needsPlan = !plan || !plan.text;
          const planRejected = plan && plan.text && !plan.approved && !!plan.feedback;
          const planPending = plan && plan.text && !plan.approved && !plan.feedback;

          // Plan exists but not approved and no feedback → waiting for human review
          if (planPending) continue;

          const idleAgents = roleIndex.get(role);
          if (!idleAgents?.length) continue;

          const agent = idleAgents[0];
          if (!poolAcquire(pool, agent.$path)) {
            log.warn(`pool full, ${agent.$path} queued`);
            continue;
          }
          poolDirty = true;
          idleAgents.shift();

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
