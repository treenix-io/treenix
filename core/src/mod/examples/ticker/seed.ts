import type { NodeData } from '#core';
import type { Tree } from '#tree';

export async function seedTicker(store: Tree) {
  if (await store.get('/demo/ticker')) return;

  await store.set({
    $path: '/demo/ticker',
    $type: 'ticker',
    config: { $type: 'ticker.config', symbol: 'BTC', intervalSec: 5 },
    mount: { $type: 't.mount.memory' },
  } as NodeData);

  await store.set({
    $path: '/sys/autostart/ticker',
    $type: 'ref',
    $ref: '/demo/ticker',
  } as NodeData);
}
