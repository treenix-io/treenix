// Treenity Service Context — Layer 2
// Service = register(type, "service", handler) → returns { stop() }

import { type NodeData, resolve as resolveCtx } from '#core';
import { type Tree } from '#tree';

// ── Types ──

export type ServiceHandle = { stop(): Promise<void> };
export type StoreEvent =
  | { type: 'set'; path: string }
  | { type: 'patch'; path: string }
  | { type: 'remove'; path: string };
export type StoreListener = (event: StoreEvent) => void;
export type SubscribeOpts = { children?: boolean };
export type ServiceCtx = {
  store: Tree;
  subscribe: (path: string, cb: StoreListener, opts?: SubscribeOpts) => () => void;
};
export type ServiceHandler = (node: NodeData, ctx: ServiceCtx) => Promise<ServiceHandle>;

declare module '#core/context' {
  interface ContextHandlers {
    service: ServiceHandler;
  }
}

// ── Bootstrap ──

export async function startServices(
  store: Tree,
  subscribe: ServiceCtx['subscribe'],
  path = '/sys/autostart',
): Promise<ServiceHandle | null> {
  const node = await store.get(path);
  if (!node) return null;
  const handler = resolveCtx(node.$type, 'service');
  if (!handler) {
    console.error(`[service] no handler for ${node.$type}`);
    return null;
  }
  return await handler(node, { store, subscribe });
}
