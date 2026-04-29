// Chat action — generator that streams Claude responses via trpc.streamAction
// Registered on ai.chat component. Works on any node with ai.chat + ai.thread + ai.agent.

import { abortQuery, invokeClaude } from '#metatron/claude';
import { getComponent, register } from '@treenx/core';
import { setComponent } from '@treenx/core/comp';
import type { ActionCtx } from '@treenx/core/server/actions';
import { createCanUseTool } from './guardian';
import { AiAgent, AiChat, AiThread, type ThreadMessage } from './types';

function buildChatPrompt(systemPrompt: string, messages: ThreadMessage[]): string {
  const history = messages.map(m =>
    `[${m.role}]: ${m.text}`
  ).join('\n\n');

  return `${systemPrompt}

## Conversation
${history}

Respond to the latest message.`;
}

register(
  'ai.chat',
  'action:send',
  async function* (ctx: ActionCtx, data: unknown) {
    const { text } = data as { text: string };
    if (!text?.trim()) throw new Error('text is required');

    const path = ctx.node.$path;
    const node = await ctx.tree.get(path);
    if (!node) throw new Error(`node not found: ${path}`);

    const chat = getComponent(node, AiChat);
    if (!chat) throw new Error('missing ai.chat component');

    const thread = getComponent(node, AiThread) ?? { $type: 'ai.thread' as const, messages: [] as ThreadMessage[] };
    const agent = getComponent(node, AiAgent);

    // Push user message, set streaming
    thread.messages.push({ role: 'user', from: 'human', text: text.trim(), ts: Date.now() });
    chat.streaming = true;
    setComponent(node, AiThread, thread);
    await ctx.tree.set(node);

    const systemPrompt = agent?.systemPrompt || 'You are an AI assistant for the Treenix platform.';
    const model = agent?.model || 'claude-opus-4-6';
    const prompt = buildChatPrompt(systemPrompt, thread.messages);
    const canUseTool = createCanUseTool(agent?.role || 'assistant', path, ctx.tree);

    // Callback→generator bridge
    const chunks: string[] = [];
    let notify: (() => void) | null = null;
    let finished = false;

    const resultP = invokeClaude(prompt, {
      key: path,
      sessionId: chat.sessionId || undefined,
      model,
      canUseTool,
      onOutput: (chunk) => {
        chunks.push(chunk);
        notify?.();
        notify = null;
      },
    }).then(r => { finished = true; notify?.(); return r; });

    while (!finished) {
      if (!chunks.length) {
        if (ctx.signal.aborted) break;
        await new Promise<void>(r => { notify = r; });
      }
      while (chunks.length) {
        yield { type: 'chunk', text: chunks.shift() };
      }
    }

    const result = await resultP;

    // Persist assistant response + update session
    const freshNode = await ctx.tree.get(path);
    if (freshNode) {
      const freshChat = getComponent(freshNode, AiChat);
      const freshThread = getComponent(freshNode, AiThread) ?? { $type: 'ai.thread' as const, messages: [] as ThreadMessage[] };

      // Intentionally persist full output (tool calls, thinking, results) — not just clean text.
      // Chat UI renders everything via LogRenderer; hiding internals would lose observability.
      freshThread.messages.push({
        role: 'assistant',
        from: path,
        text: result.output || result.text || '(no response)',
        ts: Date.now(),
      });

      if (freshChat) {
        freshChat.streaming = false;
        freshChat.sessionId = result.sessionId ?? '';
      }

      setComponent(freshNode, AiThread, freshThread);
      await ctx.tree.set(freshNode);
    }

    yield { type: 'done', text: result.output || result.text || '' };
  },
);

register(
  'ai.chat',
  'action:stop',
  async (ctx: ActionCtx) => {
    abortQuery(ctx.node.$path);

    const node = await ctx.tree.get(ctx.node.$path);
    if (node) {
      const chat = getComponent(node, AiChat);
      if (chat) {
        chat.streaming = false;
        await ctx.tree.set(node);
      }
    }
  },
);
