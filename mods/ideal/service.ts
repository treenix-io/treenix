// IdeasBoard service — auto-approves ideas with enough votes

import { getComponent, register } from '@treenx/core';
import '@treenx/core/contexts/service';
import { safeInterval } from '@treenx/core/util/safe-timers';
import { Idea, IdeasBoard } from './types';

register(IdeasBoard, 'service', async (board, ctx) => {
  const threshold = board.autoApproveThreshold;

  const timer = safeInterval(async () => {
    const { items } = await ctx.tree.getChildren(ctx.path);
    for (const child of items) {
      const idea = getComponent(child, Idea);
      if (!idea || idea.status !== 'new' || idea.votes < threshold) continue;
      await ctx.tree.set({ ...child, status: 'approved' });
      console.log(`[ideal] auto-approved "${idea.title}" (${idea.votes} votes)`);
    }
  }, 5000, 'ideal.auto-approve');

  console.log(`[ideal] service started on ${ctx.path}, threshold=${threshold}`);
  return { stop: async () => clearInterval(timer) };
});
