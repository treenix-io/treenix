import type { NodeData } from '#core';
import type { Tree } from '#tree';

export async function seedTicker(tree: Tree) {
  if (await tree.get('/demo/ticker')) return;

  await tree.set({
    $path: '/demo/ticker',
    $type: 'ticker',
    '#config': { $type: 'ticker.config', symbol: 'BTC', intervalSec: 5 },
    '#mount': { $type: 't.mount.memory' },
  } as NodeData);

  await tree.set({
    $path: '/sys/autostart/ticker',
    $type: 'ref',
    $ref: '/demo/ticker',
  } as NodeData);
}
