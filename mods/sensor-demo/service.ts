// Sensor demo — generates fake readings every second as children

import { type NodeData, register } from '@treenity/core/core';
import '@treenity/core/contexts/service';

register('examples.demo.sensor', 'service', async (node, ctx) => {
  let seq = 0;
  const MAX = 10;
  const timer = setInterval(async () => {
    const ts = Date.now();
    const name = String(ts).slice(-6).padStart(6, '0');
    await ctx.store.set({
      $path: `${node.$path}/${name}`,
      $type: 'sensor-reading',
      ts,
      value: +(20 + Math.sin(seq * 0.1) * 5 + Math.random() * 2).toFixed(1),
      seq: seq++,
    } as NodeData);
    // Trim old readings
    const { items } = await ctx.store.getChildren(node.$path);
    if (items.length > MAX) {
      items.sort((a, b) => (a.ts as number) - (b.ts as number));
      for (const old of items.slice(0, items.length - MAX)) await ctx.store.remove(old.$path);
    }
  }, 1000);
  console.log(`[sensor-demo] started on ${node.$path}`);
  return { stop: async () => clearInterval(timer) };
});
