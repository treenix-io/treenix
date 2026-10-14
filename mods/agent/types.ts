import { declareClientType } from '@treenx/core/comp/client-declaration';
import { declareOpenModule } from '@treenx/core/kernel/module-declaration';
// AI Agent — autonomous worker in the tree.
// Role determines prompt + tool policy. Uses metatron's invokeClaude for LLM.
// Agent = node, tree = protocol.

import { agentMethods } from '#agent/methods';

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
  ts: number;
  type: 'text' | 'tool_call' | 'tool_result' | 'thinking' | 'approval' | 'embed';
  tool?: string;
  input?: Record<string, unknown>;
  output?: string;
  duration?: number;
  approved?: boolean;
  /** Treenix node path — UI can render via <Render /> */
  ref?: string;
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
  /** Branch the run is rooted into (work mode) — its diff IS the run's effect */
  branchRef = '';
  /** @format textarea */
  prompt = '';
  /** Clean text output */
  /** @format textarea */
  result = '';
  mode: 'plan' | 'work' | 'discuss' | 'chat' = 'work';
  /** Key used by invokeClaude — needed to abort the correct query */
  queryKey = '';
}

export type AgentStatus = 'idle' | 'working' | 'blocked' | 'error' | 'offline';

/** AI Agent — autonomous worker node at /agents/{name}
 * LLM config (model, systemPrompt) lives directly on agent.
 * Chat session in ai.chat component. Work creates ai.run nodes under runs/. */
export class AiAgent {
  /** Open-ended role string. Guardian policies keyed by role. */
  role = 'qa';
  status: AgentStatus = 'offline';
  // trustLevel removed (core-p95): it was metadata the guardian never read —
  // decorative security. Per-agent strictness lives in the AiPolicy cascade.
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
    return agentMethods['ai.agent'].online.call(this);
  }

  /** @description Take agent offline */
  offline() {
    return agentMethods['ai.agent'].offline.call(this);
  }

  /** @description Assign a board task to this agent */
  assign(data: { /** Path to board.task */ task: string }) {
    return agentMethods['ai.agent'].assign.call(this, data);
  }

  /** @description Agent finished current task */
  complete() {
    return agentMethods['ai.agent'].complete.call(this);
  }

  /** @description Agent is blocked */
  block(data?: { /** Reason */ reason?: string }) {
    return agentMethods['ai.agent'].block.call(this, data);
  }

  /** @description Agent hit an error */
  fail(data?: { /** Error message */ error?: string }) {
    return agentMethods['ai.agent'].fail.call(this, data);
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
    return agentMethods['ai.thread'].post.call(this, data);
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
    return agentMethods['ai.plan'].approvePlan.call(this, data);
  }

  /** @description Reject the plan — agent will re-plan with feedback */
  rejectPlan(data?: { /** What to change */ feedback?: string }) {
    return agentMethods['ai.plan'].rejectPlan.call(this, data);
  }
}

const declaredAiPlan = declareClientType('ai.plan', AiPlan);

/** Human decision record for an agent tool call that requires approval. */
export class AiApproval {
  agentPath = '';
  agentRole = '';
  tool = '';
  /** @format textarea */
  input = '';
  inputTruncated = false;
  /** Path of the t.branch this approval reviews ('' for plain tool approvals).
   *  Approval UIs render the branch diff through it; resolution = the human
   *  runs `merge` on the branch, not the approve action. */
  branchRef = '';
  status: 'pending' | 'approved' | 'denied' = 'pending';
  reason = '';
  createdAt = 0;
  resolvedAt = 0;
  /** Deadline (ms epoch); past it the waiter/reconcile denies with reason 'timeout'/'expired'. */
  expiresAt = 0;
  /** Human's "remember this decision" choice — read by the guardian waiter, which
   *  persists the rule. The node IS the resolution state (survives restarts). */
  remember: '' | 'agent' | 'global' = '';

  /** @description Approve this tool usage */
  approve(data?: {
    /** Remember this decision for future calls */
    remember?: 'agent' | 'global';
  }) {
    if (this.status !== 'pending') throw new Error('already resolved');
    this.status = 'approved';
    this.resolvedAt = Date.now();
    this.remember = data?.remember ?? '';
  }

  /** @description Deny this tool usage */
  deny(data?: {
    /** Remember this decision for future calls */
    remember?: 'agent' | 'global';
  }) {
    if (this.status !== 'pending') throw new Error('already resolved');
    this.status = 'denied';
    this.resolvedAt = Date.now();
    this.remember = data?.remember ?? '';
  }
}

const declaredAiApproval = declareClientType('ai.approval', AiApproval);

/** Persistent tool policy — lives on agent (per-agent) or /guardian (global) */
export class AiPolicy {
  allow: string[] = [];
  deny: string[] = [];
  escalate: string[] = [];
  /** @description Add a tool to allow list */
  addAllow(data: { /** Tool name or glob pattern */ pattern: string }) {
    return agentMethods['ai.policy'].addAllow.call(this, data);
  }

  /** @description Add a tool to deny list */
  addDeny(data: { /** Tool name or glob pattern */ pattern: string }) {
    return agentMethods['ai.policy'].addDeny.call(this, data);
  }

  /** @description Add a tool to escalate list (requires human approval) */
  addEscalate(data: { /** Tool name or glob pattern */ pattern: string }) {
    return agentMethods['ai.policy'].addEscalate.call(this, data);
  }

  /** @description Remove a rule from all lists */
  removeRule(data: { /** Pattern to remove */ pattern: string }) {
    return agentMethods['ai.policy'].removeRule.call(this, data);
  }
}

/** Approval inbox — field-level ref points to the approvals dir */
export class AiApprovals {
  source: { $type: 'ref'; $ref: string } = { $type: 'ref', $ref: '' };
}

const declaredAiApprovals = declareClientType('ai.approvals', AiApprovals);
const declaredAiPolicy = declareClientType('ai.policy', AiPolicy);
const declaredAiAgent = declareClientType('ai.agent', AiAgent);
const declaredAiPool = declareClientType('ai.pool', AiPool);
const declaredAiAssignment = declareClientType('ai.assignment', AiAssignment);
const declaredAiThread = declareClientType('ai.thread', AiThread);

/** Interactive chat session — compose with ai.thread for messages */
export class AiChat {
  streaming = false;
  sessionId = '';
}

export type ChatChunk = { type: 'chunk' | 'done'; text: string };

/** Chat actions are supplied by the owning native module. */
export interface AiChat {
  send(data: { text: string }): AsyncGenerator<ChatChunk>;
  stop(): void;
}

// New ECS components + node types
const declaredAiChat = declareClientType('ai.chat', AiChat);
const declaredAiLog = declareClientType('ai.log', AiLog);
const declaredAiRunStatus = declareClientType('ai.run-status', AiRunStatus);
const declaredAiCost = declareClientType('ai.cost', AiCost);
const declaredAiRun = declareClientType('ai.run', AiRun);

export interface AiRun {
  /** @description Stop the running task */
  stop(): Promise<void>;
}

export interface AiChat {
  /** @description Clear chat history and reset session */
  clear(): Promise<void>;
}

export const clientModules = [
  declareOpenModule(
    '@treenx/mods/agent/types',
    [],
    [
      declaredAiPlan,
      declaredAiApproval,
      declaredAiApprovals,
      declaredAiPolicy,
      declaredAiAgent,
      declaredAiPool,
      declaredAiAssignment,
      declaredAiThread,
      declaredAiChat,
      declaredAiLog,
      declaredAiRunStatus,
      declaredAiCost,
      declaredAiRun,
    ],
  ),
];
