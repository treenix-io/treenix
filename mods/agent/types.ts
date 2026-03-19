// AI Agent — autonomous worker in the tree.
// Role determines prompt + tool policy. Uses metatron's invokeClaude for LLM.
// Agent = node, tree = protocol.

import { registerType } from '@treenity/core/comp';

export type AgentStatus = 'idle' | 'working' | 'blocked' | 'error' | 'offline';

/** AI Agent — autonomous worker node at /agents/{name}
 * LLM config (model, systemPrompt, sessionId) lives in named metatron.config component.
 * Work creates metatron.task nodes under /agents/{name}/tasks/. */
export class AiAgent {
  /** Open-ended role string. Guardian policies keyed by role. */
  role = 'qa';
  status: AgentStatus = 'offline';
  /** Path to current board.task being worked on */
  currentTask = '';
  /** Path to current metatron.task (live log) */
  taskRef = '';
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

/** Persistent tool policy — lives on agent (per-agent) or /agents/guardian (global) */
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
