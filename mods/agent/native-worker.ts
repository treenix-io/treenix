import { getComponent } from '@treenx/core';
import { KernelError } from '@treenx/core/errors';
import type { ChangeBuilder, TypeDef, WriteActionContext } from '@treenx/core/kernel/types';
import { z } from 'zod/v3';
import type { AiAgent } from '#agent/types';
import type { AgentPorts, AgentResult } from '#agent/native-io';
import { stageNativeBranchControl } from '#branch/native-actions';
import { patchAgentComponent } from '#agent/native-chat';
import type { AiLog } from '#agent/types';

export interface WorkerConfig {
  readonly poolPath: string;
  readonly agentPath: string;
}

const input = z
  .object({
    prompt: z.string(),
    mode: z.enum(['plan', 'work', 'discuss']),
    workspace: z.string().optional(),
    sessionId: z.string().optional(),
    runPath: z.string().optional(),
    deferBranchControl: z.boolean().optional(),
  })
  .strict();

/** Refuses operations that have no admitted mutation scope or workspace provenance. */
function refuse(): never {
  throw new KernelError('FORBIDDEN', 'Operation is outside the agent workspace');
}

/** Stages model edits only inside the future tree; branch control remains an action. */
function workspaceChanges(ctx: WriteActionContext, workspace: string | undefined): ChangeBuilder {
  const inside = (path: string) =>
    workspace !== undefined && (path === workspace || path.startsWith(`${workspace}/`));
  const check = (path: string) => {
    if (!inside(path)) refuse();
  };

  return {
    put(node) {
      check(node.$path);
      ctx.change.put(node);
    },
    patch(path, ops) {
      check(path);
      ctx.change.patch(path, ops);
    },
    remove(path) {
      check(path);
      ctx.change.remove(path);
    },
    move(from, to) {
      check(from);
      check(to);
      ctx.change.move(from, to);
    },
    adopt(from, to) {
      check(from);
      check(to);
      ctx.change.adopt(from, to);
    },
    restore: refuse,
    undo: refuse,
  };
}

/** Invokes one model with the real worker's separately bounded read and mutation authority. */
async function* invokeWorker(this: WorkerConfig, ctx: WriteActionContext, args: unknown) {
  const request = input.parse(args);
  if (ctx.executor.scope === undefined || ctx.executor.writeScope === undefined) refuse();
  const pool = (await ctx.read.read({ node: this.poolPath })).copies[0];
  if ('error' in pool) throw pool.error;
  if (ctx.caller.principal !== `n:${pool.node.$id}`) refuse();
  const copy = (await ctx.read.read({ node: this.agentPath })).copies[0];
  if ('error' in copy) throw copy.error;
  const agent = getComponent<AiAgent>(copy.node, 'ai.agent');
  if (agent === undefined) throw new KernelError('INVALID', 'Worker has no owning agent');
  const provider = ctx.io?.agent;
  if (provider === undefined)
    throw new KernelError('UNAVAILABLE', 'Native agent inference is not bound');
  if (
    request.mode === 'work' &&
    (request.workspace === undefined || !request.workspace.endsWith('/tree'))
  )
    throw new KernelError('INVALID', 'Work requires a branch workspace');
  const workspace = request.mode === 'work' ? request.workspace : undefined;
  const branch = workspace?.slice(0, -5);
  let branchRequest: { action: 'requestMerge' | 'abandon'; args: unknown } | undefined;
  if (request.runPath !== undefined && agent.currentRun !== request.runPath)
    throw new KernelError('INVALID', 'Worker log differs from its owning run');
  let calls = 0;
  const ports: AgentPorts = {
    read: ctx.read,
    change: workspaceChanges(ctx, workspace),
    async act(call) {
      if (workspace !== undefined) {
        if (call.path === branch && (call.action === 'requestMerge' || call.action === 'abandon')) {
          if (call.component !== undefined && call.component !== '') refuse();
          if (request.deferBranchControl) {
            branchRequest = { action: call.action, args: call.args };
            return {
              status: call.action === 'requestMerge' ? 'review' : 'abandoned',
              staged: true,
            };
          }
          return {
            ...(await stageNativeBranchControl(ctx, call.path, call.action, call.args)),
            staged: true,
          };
        }
        if (
          call.path === workspace ||
          call.path.startsWith(`${workspace}/`) ||
          (call.path === branch && call.action === 'diff')
        )
          return ctx.act({ ...call, key: call.key ?? `model:${++calls}` });
      }
      const described = await ctx.read.read({
        node: call.path,
        action: {
          name: call.action,
          ...(call.component === undefined ? {} : { component: call.component }),
        },
      });
      if (described.action === undefined)
        throw new KernelError('INVALID', 'Agent action has no description');
      if (described.action.kind !== 'read') refuse();
      return ctx.act({ ...call, key: call.key ?? `model:${++calls}` });
    },
  };
  const instructions =
    workspace === undefined
      ? 'This invocation is read-only. Return your discussion or plan as text.'
      : `Your isolated workspace is ${workspace}. Use that prefix for reads and writes to the future tree. Other admitted paths are read-only. Request human merge with requestMerge on ${branch}; this control request is staged with your next response frame. Live changes require an administrator.`;

  let result: AgentResult | undefined;
  for await (const event of provider.invoke(
    {
      key: copy.node.$id,
      model: agent.model,
      systemPrompt: `${agent.systemPrompt}\n${instructions}`,
      prompt: request.prompt,
      ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
    },
    ports,
  )) {
    if (event.type === 'chunk') {
      if (request.runPath !== undefined) {
        const run = (await ctx.read.read({ node: request.runPath })).copies[0];
        if ('error' in run) throw run.error;
        const log = getComponent<AiLog>(run.node, 'ai.log');
        if (log === undefined) throw new KernelError('INVALID', 'Worker run has no activity log');
        patchAgentComponent(ctx, run.node, 'ai.log', {
          entries: [...log.entries, { ts: Date.now(), type: 'text', output: event.text }],
        });
      }
      yield event;
    } else result = event.result;
  }
  if (result === undefined)
    throw new KernelError('UNAVAILABLE', 'Agent provider ended without a result');
  return { ...result, ...(branchRequest === undefined ? {} : { branchRequest }) };
}

/** Publishes an immutable worker capability without changing the ordinary agent configuration type. */
export function nativeWorkerType(owner: string): TypeDef {
  return {
    name: 'ai.worker',
    module: owner,
    security: 'user-capability',
    version: 0,
    actionsOnly: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        poolPath: { type: 'string', minLength: 1 },
        agentPath: { type: 'string', minLength: 1 },
      },
      required: ['poolPath', 'agentPath'],
      methods: {
        invoke: {
          kind: 'setuid',
          streaming: true,
          arguments: [
            {
              name: 'data',
              type: 'object',
              properties: {
                prompt: { type: 'string' },
                mode: { enum: ['plan', 'work', 'discuss'] },
                workspace: { type: 'string' },
                sessionId: { type: 'string' },
                runPath: { type: 'string' },
                deferBranchControl: { type: 'boolean' },
              },
              required: ['prompt', 'mode'],
            },
          ],
        },
      },
    },
    actions: {
      invoke: {
        kind: 'setuid',
        io: true,
        args: {
          type: 'object',
          properties: {
            prompt: { type: 'string' },
            mode: { enum: ['plan', 'work', 'discuss'] },
            workspace: { type: 'string' },
            sessionId: { type: 'string' },
            runPath: { type: 'string' },
            deferBranchControl: { type: 'boolean' },
          },
          required: ['prompt', 'mode'],
          additionalProperties: false,
        },
        handler: invokeWorker,
      },
    },
  };
}
