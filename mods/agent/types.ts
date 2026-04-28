// AI Agent — autonomous worker in the tree.
// Role determines prompt + tool policy. Uses metatron's invokeClaude for LLM.
// Agent = node, tree = protocol.

import { resolvePermission } from '#metatron/permissions';
import { getComponent } from '@treenx/core';
import { getCtx, registerType } from '@treenx/core/comp';

// ── Active query registry ──
// Server-only runtime state: tracks running Claude queries so AiRun.stop()
// can abort them. Lives here (not in metatron/claude.ts) so this module can
// be safely imported by the client bundle — importing claude.ts would drag
// @anthropic-ai/claude-agent-sdk (uses node:crypto) into the browser.
// The Map exists in the client too but is always empty and harmless.

type QueryLike = { close: () => void };
type ActiveEntry = { query: QueryLike; ac: AbortController };

const activeQueries = new Map<string, ActiveEntry>();

export function registerQuery(key: string, entry: ActiveEntry): void {
  activeQueries.set(key, entry);
}

export function unregisterQuery(key: string): void {
  activeQueries.delete(key);
}

/** Abort a running query by key (config path). Returns true if aborted. */
export function abortQuery(key: string): boolean {
  const entry = activeQueries.get(key);
  if (!entry) return false;
  entry.ac.abort();
  entry.query.close();
  activeQueries.delete(key);
  return true;
}

/** Check if a query is currently running for the given key */
export function isQueryRunning(key: string): boolean {
  return activeQueries.has(key);
}

// ── Structured log entry — atomic unit of observability ──

export type LogEntry = {
  ts: number
  type: 'text' | 'tool_call' | 'tool_result' | 'thinking' | 'approval' | 'embed'
  tool?: string
  input?: Record<string, unknown>
  output?: string
  duration?: number
  approved?: boolean
  /** Treenix node path — UI can render via <Render /> */
  ref?: string
};

// ── Reusable ECS components ──

/** Structured activity log — attachable to any node (run, chat, etc.) */
export class AiLog {
  entries: LogEntry[] = [];
}

/** Generic lifecycle status — reusable for any process */
export class AiRunStatus {
  status: 'pending' | 'running' | 'done' | 'error' | 'aborted' = 'pending';
  startedAt = 0;
  finishedAt = 0;
  error = '';
}

/** Cost tracking — attachable to any billable operation */
export class AiCost {
  inputTokens = 0;
  outputTokens = 0;
  costUsd = 0;
  model = '';
}

// ── Node types ──

/** One Claude invocation — lives at /agents/{name}/runs/{id} */
export class AiRun {
  /** Reference to board task */
  taskRef = '';
  /** @format textarea */
  prompt = '';
  /** Clean text output */
  /** @format textarea */
  result = '';
  mode: 'plan' | 'work' | 'discuss' | 'chat' = 'work';
  /** Key used by invokeClaude — needed to abort the correct query */
  queryKey = '';

  /** @description Stop the running task */
  stop() {
    const { node } = getCtx();
    const status = getComponent(node, AiRunStatus);
    if (!status || status.status !== 'running') throw new Error('run is not running');
    status.status = 'aborted';
    status.finishedAt = Date.now();
    abortQuery(this.queryKey || node.$path.split('/').slice(0, -2).join('/'));
  }
}

export type AgentStatus = 'idle' | 'working' | 'blocked' | 'error' | 'offline';

/** AI Agent — autonomous worker node at /agents/{name}
 * LLM config (model, systemPrompt) lives directly on agent.
 * Chat session in ai.chat component. Work creates ai.run nodes under runs/. */
export class AiAgent {
  /** Open-ended role string. Guardian policies keyed by role. */
  role = 'qa';
  status: AgentStatus = 'offline';
  /** Trust level (metadata only — not enforced by guardian yet).
   * 0=sandbox 1=observer 2=worker 3=operator 4=admin */
  trustLevel: 0 | 1 | 2 | 3 | 4 = 2;
  model = 'claude-opus-4-6';
  /** @format textarea */
  systemPrompt = '';
  /** Path to current board.task being worked on */
  currentTask = '';
  /** Path to current ai.run (live log) */
  currentRun = '';
  lastRunAt = 0;
  /** Total tokens used across all tasks */
  totalTokens = 0;

  /** @description Bring agent online */
  online() {
    this.status = 'idle';
    this.currentTask = '';
  }

  /** @description Take agent offline */
  offline() {
    if (this.status === 'working')
      throw new Error('cannot go offline while working');
    this.status = 'offline';
  }

  /** @description Assign a board task to this agent */
  assign(data: { /** Path to board.task */ task: string }) {
    if (this.status !== 'idle')
      throw new Error(`cannot assign: agent is ${this.status}`);
    if (!data.task?.trim()) throw new Error('task path required');
    this.currentTask = data.task.trim();
    this.status = 'working';
  }

  /** @description Agent finished current task */
  complete() {
    if (this.status !== 'working')
      throw new Error(`cannot complete: agent is ${this.status}`);
    this.currentTask = '';
    this.status = 'idle';
    this.lastRunAt = Date.now();
  }

  /** @description Agent is blocked */
  block(data?: { /** Reason */ reason?: string }) {
    this.status = 'blocked';
  }

  /** @description Agent hit an error */
  fail(data?: { /** Error message */ error?: string }) {
    this.status = 'error';
    this.currentTask = '';
  }
}

/** Concurrency pool — lives on /agents node */
export class AiPool {
  maxConcurrent = 2;
  /** Paths of currently active agent nodes */
  active: string[] = [];
  /** Paths of agents waiting for a slot */
  queue: string[] = [];
}

/** AI workflow on a board.task — routing + discussion cursor */
export class AiAssignment {
  /** Who created the task */
  origin = '';
  /** Roles to wake for discussion (empty = no discussion pending) */
  nextRoles: string[] = [];
  /** agentPath → last read message index (don't re-send old messages) */
  cursors: Record<string, number> = {};
}

/** Discussion thread on a task — lightweight multi-agent chat */
export class AiThread {
  messages: ThreadMessage[] = [];

  /** @description Post a message to the discussion */
  post(data: { role: string; from: string; text: string }) {
    if (!data.text?.trim()) throw new Error('empty message');
    this.messages.push({ role: data.role, from: data.from, text: data.text, ts: Date.now() });
  }
}

export type ThreadMessage = {
  role: string;
  from: string;
  text: string;
  ts: number;
};

/** AI execution plan — lives as named component on board.task node.
 * Agent writes plan first, human reviews + approves before execution. */
export class AiPlan {
  /** @format textarea */
  text = '';
  approved = false;
  /** @format textarea */
  feedback = '';
  createdAt = 0;

  /** @description Approve the plan — agent will proceed to execute */
  approvePlan(data?: { /** Optional feedback/adjustments for the agent */ feedback?: string }) {
    if (this.approved) throw new Error('plan already approved');
    if (!this.text) throw new Error('no plan to approve');
    this.approved = true;
    if (data?.feedback) this.feedback = data.feedback;
  }

  /** @description Reject the plan — agent will re-plan with feedback */
  rejectPlan(data?: { /** What to change */ feedback?: string }) {
    if (!this.text) throw new Error('no plan to reject');
    this.approved = false;
    if (data?.feedback) this.feedback = data.feedback;
  }
}

registerType('ai.plan', AiPlan);

export class AiApproval {
  agentPath = '';
  agentRole = '';
  tool = '';
  /** @format textarea */
  input = '';
  inputTruncated = false;
  status: 'pending' | 'approved' | 'denied' = 'pending';
  reason = '';
  createdAt = 0;
  resolvedAt = 0;

  /** @description Approve this tool usage */
  approve(data?: {
    /** Remember this decision for future calls */
    remember?: 'agent' | 'global'
  }) {
    if (this.status !== 'pending') throw new Error('already resolved');
    this.status = 'approved';
    this.resolvedAt = Date.now();
    const { node } = getCtx();
    const id = node.$path.split('/').pop();
    if (id) resolvePermission(id, true, {
      tool: this.tool,
      input: this.input,
      agentPath: this.agentPath,
      scope: data?.remember,
    });
  }

  /** @description Deny this tool usage */
  deny(data?: {
    /** Remember this decision for future calls */
    remember?: 'agent' | 'global'
  }) {
    if (this.status !== 'pending') throw new Error('already resolved');
    this.status = 'denied';
    this.resolvedAt = Date.now();
    const { node } = getCtx();
    const id = node.$path.split('/').pop();
    if (id) resolvePermission(id, false, {
      tool: this.tool,
      input: this.input,
      agentPath: this.agentPath,
      scope: data?.remember,
    });
  }
}

registerType('ai.approval', AiApproval);

/** Persistent tool policy — lives on agent (per-agent) or /guardian (global) */
export class AiPolicy {
  allow: string[] = [];
  deny: string[] = [];
  escalate: string[] = [];
  /** @description Add a tool to allow list */
  addAllow(data: { /** Tool name or glob pattern */ pattern: string }) {
    if (!data.pattern?.trim()) throw new Error('pattern required');
    const p = data.pattern.trim();
    if (!this.allow.includes(p)) this.allow.push(p);
    this.deny = this.deny.filter(d => d !== p);
    this.escalate = this.escalate.filter(e => e !== p);
  }

  /** @description Add a tool to deny list */
  addDeny(data: { /** Tool name or glob pattern */ pattern: string }) {
    if (!data.pattern?.trim()) throw new Error('pattern required');
    const p = data.pattern.trim();
    if (!this.deny.includes(p)) this.deny.push(p);
    this.allow = this.allow.filter(a => a !== p);
    this.escalate = this.escalate.filter(e => e !== p);
  }

  /** @description Add a tool to escalate list (requires human approval) */
  addEscalate(data: { /** Tool name or glob pattern */ pattern: string }) {
    if (!data.pattern?.trim()) throw new Error('pattern required');
    const p = data.pattern.trim();
    if (!this.escalate.includes(p)) this.escalate.push(p);
    this.allow = this.allow.filter(a => a !== p);
    this.deny = this.deny.filter(d => d !== p);
  }

  /** @description Remove a rule from all lists */
  removeRule(data: { /** Pattern to remove */ pattern: string }) {
    if (!data.pattern?.trim()) throw new Error('pattern required');
    const p = data.pattern.trim();
    this.allow = this.allow.filter(a => a !== p);
    this.deny = this.deny.filter(d => d !== p);
    this.escalate = this.escalate.filter(e => e !== p);
  }
}

/** Approval inbox — field-level ref points to the approvals dir */
export class AiApprovals {
  source: { $type: 'ref'; $ref: string } = { $type: 'ref', $ref: '' };
}

registerType('ai.approvals', AiApprovals);
registerType('ai.policy', AiPolicy);
registerType('ai.agent', AiAgent);
registerType('ai.pool', AiPool);
registerType('ai.assignment', AiAssignment);
registerType('ai.thread', AiThread);

/** Interactive chat session — compose with ai.thread for messages */
export class AiChat {
  streaming = false;
  sessionId = '';

  /** @description Clear chat history and reset session */
  clear() {
    const { node } = getCtx();
    const thread = getComponent(node, AiThread);
    if (thread) thread.messages = [];
    this.sessionId = '';
    this.streaming = false;
  }
}

// New ECS components + node types
registerType('ai.chat', AiChat);
registerType('ai.log', AiLog);
registerType('ai.run-status', AiRunStatus);
registerType('ai.cost', AiCost);
registerType('ai.run', AiRun);
