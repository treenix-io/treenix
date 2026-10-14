import type { AiAgent,AiThread,AiPlan,AiPolicy } from '#agent/types';

export const agentMethods = {
  'ai.agent': {
    online: function (this: AiAgent) {
      this.status = 'idle';
      this.currentTask = '';
    },
    offline: function (this: AiAgent) {
      if (this.status === 'working') throw new Error('cannot go offline while working');
      this.status = 'offline';
    },
    assign: function (this: AiAgent, data: { /** Path to board.task */ task: string }) {
      if (this.status !== 'idle') throw new Error(`cannot assign: agent is ${this.status}`);
      if (!data.task?.trim()) throw new Error('task path required');
      this.currentTask = data.task.trim();
      this.status = 'working';
    },
    complete: function (this: AiAgent) {
      if (this.status !== 'working') throw new Error(`cannot complete: agent is ${this.status}`);
      this.currentTask = '';
      this.status = 'idle';
      this.lastRunAt = Date.now();
    },
    block: function (this: AiAgent, _data?: { /** Reason */ reason?: string }) {
      this.status = 'blocked';
    },
    fail: function (this: AiAgent, _data?: { /** Error message */ error?: string }) {
      this.status = 'error';
      this.currentTask = '';
    },
  },
  'ai.thread': {
    post: function (this: AiThread, data: { role: string; from: string; text: string }) {
      if (!data.text?.trim()) throw new Error('empty message');
      this.messages.push({ role: data.role, from: data.from, text: data.text, ts: Date.now() });
    },
  },
  'ai.plan': {
    approvePlan: function (
      this: AiPlan,
      data?: { /** Optional feedback/adjustments for the agent */ feedback?: string },
    ) {
      if (this.approved) throw new Error('plan already approved');
      if (!this.text) throw new Error('no plan to approve');
      this.approved = true;
      if (data?.feedback) this.feedback = data.feedback;
    },
    rejectPlan: function (this: AiPlan, data?: { /** What to change */ feedback?: string }) {
      if (!this.text) throw new Error('no plan to reject');
      this.approved = false;
      if (data?.feedback) this.feedback = data.feedback;
    },
  },
  'ai.policy': {
    addAllow: function (
      this: AiPolicy,
      data: { /** Tool name or glob pattern */ pattern: string },
    ) {
      if (!data.pattern?.trim()) throw new Error('pattern required');
      const p = data.pattern.trim();
      if (!this.allow.includes(p)) this.allow.push(p);
      this.deny = this.deny.filter((d) => d !== p);
      this.escalate = this.escalate.filter((e) => e !== p);
    },
    addDeny: function (this: AiPolicy, data: { /** Tool name or glob pattern */ pattern: string }) {
      if (!data.pattern?.trim()) throw new Error('pattern required');
      const p = data.pattern.trim();
      if (!this.deny.includes(p)) this.deny.push(p);
      this.allow = this.allow.filter((a) => a !== p);
      this.escalate = this.escalate.filter((e) => e !== p);
    },
    addEscalate: function (
      this: AiPolicy,
      data: { /** Tool name or glob pattern */ pattern: string },
    ) {
      if (!data.pattern?.trim()) throw new Error('pattern required');
      const p = data.pattern.trim();
      if (!this.escalate.includes(p)) this.escalate.push(p);
      this.allow = this.allow.filter((a) => a !== p);
      this.deny = this.deny.filter((d) => d !== p);
    },
    removeRule: function (this: AiPolicy, data: { /** Pattern to remove */ pattern: string }) {
      if (!data.pattern?.trim()) throw new Error('pattern required');
      const p = data.pattern.trim();
      this.allow = this.allow.filter((a) => a !== p);
      this.deny = this.deny.filter((d) => d !== p);
      this.escalate = this.escalate.filter((e) => e !== p);
    },
  },
};
