// Sensor generator demo — on-demand scan that streams N readings via generator action

import { type NodeData, register } from '@treenity/core/core';
import { type ActionCtx } from '@treenity/core/server/actions';

/** @description Stream N sensor readings as a generator, persisting each as a child node */
register(
  'examples.demo.generator',
  'action:scan',
  async function* (ctx: ActionCtx, data: unknown) {
    const count = (data as { count?: number })?.count ?? 10;
    const delay = (data as { delay?: number })?.delay ?? 500;
    for (let i = 0; i < count; i++) {
      if (ctx.signal.aborted) return;
      const ts = Date.now();
      const node = {
        $path: `${ctx.node.$path}/${String(ts).slice(-6)}`,
        $type: 'sensor-reading',
        ts,
        value: +(20 + Math.sin(i * 0.3) * 5 + Math.random() * 2).toFixed(1),
        seq: i,
      } as NodeData;
      await ctx.store.set(node);
      yield node;
      await new Promise((r) => setTimeout(r, delay));
    }
  },
);
