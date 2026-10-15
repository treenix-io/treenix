import { getComponent } from '@treenx/core';
import { KernelError } from '@treenx/core/errors';
import { componentEntries } from '@treenx/core/kernel/migrate';
import type { Node, WriteActionContext } from '@treenx/core/kernel/types';
import type { AiAgent, AiChat, AiThread, ThreadMessage } from '#agent/types';
import type { AgentResult } from '#agent/native-io';

/** Updates the existing component address and preserves every other component on its node. */
export function patchAgentComponent(
  ctx: WriteActionContext,
  node: Node,
  type: string,
  fields: Record<string, unknown>,
): void {
  const entry = componentEntries(node).find(([, component]) => component.$type === type);
  if (entry === undefined) throw new KernelError('INVALID', `Missing agent component: ${type}`);
  const [key, component] = entry;
  if (key === '') ctx.change.patch(node.$path, { $set: fields });
  else if (!key.includes('.'))
    ctx.change.patch(node.$path, { $set: { [key]: { ...component, ...fields } } });
  else {
    const { $id, $rev, ...updated } = node;
    Reflect.set(updated, key, { ...component, ...fields });
    ctx.change.put(updated);
  }
}

/** Requires the existing composition rather than inventing an agent configuration or thread. */
function thread(node: Node): AiThread {
  const value = getComponent<AiThread>(node, 'ai.thread');
  if (value === undefined) throw new KernelError('INVALID', 'Chat requires an ai.thread component');
  return value;
}

/** Retains the existing conversation format used by the interactive chat. */
function prompt(systemPrompt: string, messages: readonly ThreadMessage[]): string {
  return `${systemPrompt}\n\n## Conversation\n${messages.map((message) => `[${message.role}]: ${message.text}`).join('\n\n')}\n\nRespond to the latest message.`;
}

/** Commits the user message before inference, streams under native admission, then publishes the response. */
export async function* sendChat(this: AiChat, ctx: WriteActionContext, args: unknown) {
  if (
    args === null ||
    typeof args !== 'object' ||
    !('text' in args) ||
    typeof args.text !== 'string' ||
    args.text.trim().length === 0
  )
    throw new KernelError('INVALID', 'Chat text is required');
  if (this.streaming) throw new KernelError('CONFLICT', 'Chat already has a running response');
  const agent = getComponent<AiAgent>(ctx.node, 'ai.agent');
  if (agent === undefined) throw new KernelError('INVALID', 'Chat requires an ai.agent component');
  const provider = ctx.io?.agent;
  if (provider === undefined)
    throw new KernelError('UNAVAILABLE', 'Native agent inference is not bound');
  const messages = [
    ...thread(ctx.node).messages,
    { role: 'user', from: ctx.caller.principal, text: args.text.trim(), ts: Date.now() },
  ];
  const request = {
    key: ctx.node.$id,
    model: agent.model,
    provider: agent.provider,
    systemPrompt: agent.systemPrompt,
    prompt: prompt(agent.systemPrompt, messages),
    ...(this.sessionId.length === 0 ? {} : { sessionId: this.sessionId }),
  };

  this.streaming = true;
  patchAgentComponent(ctx, ctx.node, 'ai.thread', { messages });
  yield { type: 'chunk', text: '' };

  let result: AgentResult | undefined;
  try {
    for await (const event of provider.invoke(request, {
      read: ctx.read,
      act: ctx.act,
      change: ctx.change,
    })) {
      if (event.type === 'chunk') yield event;
      else result = event.result;
    }
    if (result === undefined)
      throw new KernelError('UNAVAILABLE', 'Agent provider ended without a result');
  } catch (error) {
    console.error('[agent] Chat inference failed:', error);
    this.streaming = false;
    yield { type: 'chunk', text: '' };
    throw error;
  }

  const accepted = thread(ctx.node).messages;
  patchAgentComponent(ctx, ctx.node, 'ai.thread', {
    messages: [
      ...accepted,
      {
        role: 'assistant',
        from: ctx.node.$path,
        text: result.output,
        ts: Date.now(),
      },
    ],
  });
  this.sessionId = result.sessionId;
  this.streaming = false;
  yield { type: 'done', text: result.output };
}

/** Cancels this node's bound invocation through the same authorized native action boundary. */
export async function stopChat(this: AiChat, ctx: WriteActionContext) {
  const provider = ctx.io?.agent;
  if (provider === undefined)
    throw new KernelError('UNAVAILABLE', 'Native agent inference is not bound');
  provider.stop(ctx.node.$id);
  this.streaming = false;
}

/** Resets the existing thread and model session together. */
export async function clearChat(this: AiChat, ctx: WriteActionContext) {
  thread(ctx.node);
  patchAgentComponent(ctx, ctx.node, 'ai.thread', { messages: [] });
  this.sessionId = '';
  this.streaming = false;
}
