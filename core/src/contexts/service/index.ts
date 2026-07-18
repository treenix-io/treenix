// Treenix Service Context — Layer 2
// Service = register(type, "service", handler) → returns { stop() }

import { resolve as resolveCtx } from '#core';
import { type ExecTree, type TreeEvent } from '#tree';

// ── Types ──

export type ServiceHandle = { stop(): Promise<void> };
export type SubscribeOpts = { children?: boolean };
export type ServiceCtx = {
  // Exec-capable by contract (core-pxlu): the factory passes the pipeline tree,
  // so services call tree.execute directly — full executor + federation routing.
  tree: ExecTree;
  path: string;
  /** Pipeline CDC feed — cdc.subscribe wired by the factory. Events are the
   *  store's own TreeEvents (ns6p.4 §4.3: the StoreEvent mirror + factory
   *  `as`-bridge died); typed at L1 so this layer stays below #sub. Rename/
   *  seal into Tree.watch is ns6p.3. */
  subscribe: (path: string, cb: (event: TreeEvent) => void, opts?: SubscribeOpts) => () => void;
};

declare module '#core/context' {
  interface ContextHandlers<T> {
    service: (value: T, ctx: ServiceCtx) => Promise<ServiceHandle>;
  }
}

// ── Bootstrap ──

export async function startServices(
  tree: ExecTree,
  subscribe: ServiceCtx['subscribe'],
  path = '/sys/autostart',
): Promise<ServiceHandle | null> {
  const node = await tree.get(path);
  if (!node) return null;
  const handler = resolveCtx(node.$type, 'service');
  if (!handler) {
    console.error(`[service] no handler for ${node.$type}`);
    return null;
  }
  return await handler(node, { tree, path: node.$path, subscribe });
}
