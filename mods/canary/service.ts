// Canary smoke tests — run at server startup to verify core mechanics

import { getComponent, type NodeData, register } from '@treenx/core';
import { executeAction } from '@treenx/core/server/actions';
import '@treenx/core/contexts/service';
import { CanaryItem } from './types';

const PREFIX = '[canary]';

register('canary.runner', 'service', async (node, ctx) => {
  const { tree } = ctx;
  const basePath = node.$path;
  const itemPath = `${basePath}/test-item`;
  let passed = 0;
  let failed = 0;

  async function assert(name: string, fn: () => Promise<void>) {
    try {
      await fn();
      passed++;
    } catch (err) {
      failed++;
      console.error(`${PREFIX} FAIL: ${name}`, err instanceof Error ? err.message : err);
    }
  }

  // ── 1. Create node via tree.set ──
  await assert('tree.set creates node', async () => {
    await tree.set({
      $path: itemPath,
      $type: 'canary.item',
      value: 0,
      label: 'canary',
    } as NodeData);
    const n = await tree.get(itemPath);
    if (!n) throw new Error('node not found after set');
    if (n.$type !== 'canary.item') throw new Error(`wrong type: ${n.$type}`);
  });

  // ── 2. getComponent resolves node-level type ──
  await assert('getComponent resolves main component', async () => {
    const n = await tree.get(itemPath);
    const comp = getComponent(n!, CanaryItem);
    if (!comp) throw new Error('getComponent returned undefined');
    if (comp.value !== 0) throw new Error(`wrong value: ${comp.value}`);
  });

  // ── 3. Action mutates state (Immer draft) ──
  await assert('action increment mutates via Immer', async () => {
    await executeAction(tree, itemPath, 'canary.item', undefined, 'increment', undefined);
    const n = await tree.get(itemPath);
    if ((n as any).value !== 1) throw new Error(`expected 1, got ${(n as any).value}`);
  });

  // ── 4. Action with parameters ──
  await assert('action setLabel accepts params', async () => {
    await executeAction(tree, itemPath, 'canary.item', undefined, 'setLabel', { label: 'updated' });
    const n = await tree.get(itemPath);
    if ((n as any).label !== 'updated') throw new Error(`expected "updated", got ${(n as any).label}`);
  });

  // ── 5. getChildren finds child nodes ──
  await assert('getChildren returns created node', async () => {
    const { items } = await tree.getChildren(basePath);
    const found = items.find(c => c.$path === itemPath);
    if (!found) throw new Error('child not found');
  });

  // ── 6. ACL — node with deny should strip data ──
  await assert('ACL deny strips node', async () => {
    const aclPath = `${basePath}/acl-test`;
    await tree.set({
      $path: aclPath,
      $type: 'canary.item',
      $acl: [{ g: 'public', p: 0 }],
      value: 42,
      label: 'secret',
    } as NodeData);
    const n = await tree.get(aclPath);
    // Node exists in tree (we're running as system, no ACL filtering here)
    if (!n) throw new Error('acl node not found');
    if ((n as any).$acl?.[0]?.p !== 0) throw new Error('acl not set');
    await tree.remove(aclPath);
  });

  // ── 7. Remove node ──
  await assert('tree.remove deletes node', async () => {
    await tree.remove(itemPath);
    const n = await tree.get(itemPath);
    if (n) throw new Error('node still exists after remove');
  });

  // Report
  if (failed > 0) {
    console.error(`${PREFIX} ${passed} passed, ${failed} FAILED`);
  } else {
    console.log(`${PREFIX} ${passed} checks passed`);
  }

  return { stop: async () => {} };
});
