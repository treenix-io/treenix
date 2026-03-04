import { getComp } from '#comp';
import { type NodeData, register } from '#core';
import { TickerConfig } from './types';

register('ticker', 'service', async (node: NodeData, ctx) => {
  const config = getComp(node, TickerConfig);
  const interval = (config?.intervalSec ?? 10) * 1000;

  const timer = setInterval(async () => {
    const price = 50000 + Math.random() * 1000; // stub — replace with real API
    await ctx.store.set({
      $path: `${node.$path}/${Date.now()}`,
      $type: 'ticker.price',
      price,
      ts: Date.now(),
    } as NodeData);
  }, interval);

  return { stop: async () => clearInterval(timer) };
});
