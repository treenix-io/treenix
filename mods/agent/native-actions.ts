import { KernelError } from '@treenx/core/errors';
import { getComponent } from '@treenx/core';
import type { ActionDef, WriteActionContext } from '@treenx/core/kernel/types';
import type { AiAgent, AiPlan, AiPolicy, AiThread, AiRunStatus } from '#agent/types';
import { agentMethods } from '#agent/methods';
import { clearChat, patchAgentComponent, sendChat, stopChat } from '#agent/native-chat';

/** Validates external action objects while preserving optional argument calls. */
function input(args: unknown): Record<string, unknown> {
  if (args === undefined) return {};
  if (args === null || typeof args !== 'object' || Array.isArray(args))
    throw new KernelError('INVALID', 'Agent arguments must be an object');
  return { ...args };
}

/** Requires one text field at the action-input boundary. */
function text(args: unknown, key: string): string {
  const value = input(args)[key];
  if (typeof value !== 'string')
    throw new KernelError('INVALID', 'Agent text argument is required');
  return value;
}

/** Decodes the existing optional plan feedback. */
function feedback(args: unknown): { feedback?: string } {
  const value = input(args).feedback;
  if (value === undefined) return {};
  if (typeof value !== 'string') throw new KernelError('INVALID', 'Plan feedback must be text');
  return { feedback: value };
}

/** Reuses the component-local state machines under native draft and schema ownership. */
export function agentActions(type: string): Readonly<Record<string, ActionDef>> {
  if (type === 'ai.pool') return {
    scan: { kind: 'read', args: {}, async handler(ctx) {
      if (typeof ctx.node.servicePath !== 'string') throw new KernelError('INVALID', 'Pool has no native service path');
      return ctx.act({ path: ctx.node.servicePath, action: 'select', args: {} });
    } },
  };
  if (type === 'ai.agent')
    return {
      online: {
        kind: 'write',
        args: {},
        async handler(this: AiAgent) {
          agentMethods['ai.agent'].online.call(this);
        },
      },
      offline: {
        kind: 'write',
        args: {},
        async handler(this: AiAgent) {
          agentMethods['ai.agent'].offline.call(this);
        },
      },
      assign: {
        kind: 'write',
        args: {},
        async handler(this: AiAgent, _ctx, args) {
          agentMethods['ai.agent'].assign.call(this, { task: text(args, 'task') });
        },
      },
      complete: {
        kind: 'write',
        args: {},
        async handler(this: AiAgent) {
          agentMethods['ai.agent'].complete.call(this);
        },
      },
      block: {
        kind: 'write',
        args: {},
        async handler(this: AiAgent) {
          agentMethods['ai.agent'].block.call(this);
        },
      },
      fail: {
        kind: 'write',
        args: {},
        async handler(this: AiAgent) {
          agentMethods['ai.agent'].fail.call(this);
        },
      },
    };
  if (type === 'ai.thread')
    return {
      post: {
        kind: 'write',
        args: {},
        async handler(this: AiThread, _ctx, args) {
          agentMethods['ai.thread'].post.call(this, {
            role: text(args, 'role'),
            from: text(args, 'from'),
            text: text(args, 'text'),
          });
        },
      },
    };
  if (type === 'ai.plan')
    return {
      approvePlan: {
        kind: 'write',
        args: {},
        async handler(this: AiPlan, _ctx, args) {
          agentMethods['ai.plan'].approvePlan.call(this, feedback(args));
        },
      },
      rejectPlan: {
        kind: 'write',
        args: {},
        async handler(this: AiPlan, _ctx, args) {
          agentMethods['ai.plan'].rejectPlan.call(this, feedback(args));
        },
      },
    };
  if (type === 'ai.policy')
    return Object.fromEntries(
      (['addAllow', 'addDeny', 'addEscalate', 'removeRule'] as const).map((name) => [
        name,
        {
          kind: 'write' as const,
          args: {},
          async handler(this: AiPolicy, _ctx: WriteActionContext, args: unknown) {
            agentMethods['ai.policy'][name].call(this, { pattern: text(args, 'pattern') });
          },
        } satisfies ActionDef,
      ]),
    );
  if (type === 'ai.chat')
    return {
      clear: { kind: 'write', args: {}, handler: clearChat },
      stop: { kind: 'write', io: true, args: {}, handler: stopChat },
      send: {
        kind: 'write',
        io: true,
        args: {
          type: 'object',
          properties: { text: { type: 'string', minLength: 1 } },
          required: ['text'],
        },
        handler: sendChat,
      },
    };
  if (type === 'ai.run')
    return {
      stop: {
        kind: 'write',
        io: true,
        args: {},
        async handler(ctx) {
          const status = getComponent<AiRunStatus>(ctx.node, 'ai.run-status');
          if (status === undefined || status.status !== 'running')
            throw new KernelError('INVALID', 'Run is not running');
          const path = ctx.node.$path.split('/').slice(0, -2).join('/');
          await ctx.requireReadWrite(path);
          const owner = (await ctx.read.read({ node: path })).copies[0];
          if ('error' in owner) throw owner.error;
          // Runs can belong to a native controller; cancellation requires rights on that actual owner.
          const provider = ctx.io?.agent;
          if (provider === undefined)
            throw new KernelError('UNAVAILABLE', 'Native agent inference is not bound');
          provider.stop(owner.node.$id);
          patchAgentComponent(ctx, ctx.node, 'ai.run-status', {
            status: 'aborted',
            finishedAt: Date.now(),
          });
        },
      },
    };
  return {};
}
