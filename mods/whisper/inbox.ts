// Whisper → Agent bridge service
// Watches a whisper channel for completed transcriptions, creates agent tasks

import { createNode, getComponent, type NodeData, register } from '@treenx/core';
import { WhisperInbox, WhisperText } from './types';

const log = (msg: string) => console.log(`[whisper.inbox] ${msg}`);

function getText(node: NodeData): string | undefined {
  const comp = getComponent(node, WhisperText);
  if (!comp) return undefined;
  return comp.content && comp.content !== '...' ? comp.content : undefined;
}

register('whisper.inbox', 'service', async (node, ctx) => {
  const config = getComponent(node, WhisperInbox);
  if (!config) throw new Error(`missing config on ${node.$path}`);

  const sent = new Set<string>();

  // Mark existing COMPLETED transcriptions as already processed
  const { items } = await ctx.tree.getChildren(config.source);
  for (const child of items) {
    if (child.$type !== 'whisper.transcription') continue;
    if (getText(child)) sent.add(child.$path);
  }
  log(`watching ${config.source} → ${config.target} (${sent.size} existing)`);

  const unsub = ctx.subscribe(config.source, (event) => {
    if (event.type !== 'set' && event.type !== 'patch') return;

    ctx.tree.get(event.path).then(async (n) => {
      if (!n || n.$type !== 'whisper.transcription') return;
      if (sent.has(n.$path)) return;

      const text = getText(n);
      if (!text) return;

      sent.add(n.$path);

      const taskId = `t-${Date.now()}`;
      const taskPath = `${config.target}/tasks/${taskId}`;
      await ctx.tree.set(createNode(taskPath, 'agent.task', {
        prompt: text,
        status: 'pending',
        createdAt: Date.now(),
      }));

      log(`${n.$path} → ${taskPath}`);
    }).catch(err => console.error(`[whisper.inbox] error processing ${event.path}:`, err));
  }, { children: true });

  return { stop: async () => unsub() };
});
