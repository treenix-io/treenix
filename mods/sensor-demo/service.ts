// Sensor demo — generates fake readings every second as children

import { createNode, register } from '@treenx/core';
import '@treenx/core/contexts/service';
import { safeInterval } from '@treenx/core/util/safe-timers';
import { SensorReading } from './types';

register('examples.demo.sensor', 'service', async (node, ctx) => {
  let seq = 0;
  const MAX = 10;
  const timer = safeInterval(async () => {
    const ts = Date.now();
    const name = String(ts).slice(-6).padStart(6, '0');
    await ctx.tree.set(createNode(`${node.$path}/${name}`, SensorReading, {
      ts,
      value: +(20 + Math.sin(seq * 0.1) * 5 + Math.random() * 2).toFixed(1),
      seq: seq++,
    }));
    // Trim old readings
    const { items } = await ctx.tree.getChildren(node.$path);
    if (items.length > MAX) {
      items.sort((a, b) => (a.ts as number) - (b.ts as number));
      for (const old of items.slice(0, items.length - MAX)) await ctx.tree.remove(old.$path);
    }
  }, 1000, 'sensor-demo.tick');
  console.log(`[sensor-demo] started on ${node.$path}`);
  return { stop: async () => clearInterval(timer) };
});
