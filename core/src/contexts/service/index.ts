// Treenix Service Context — Layer 2
// Service = register(type, "service", handler) → returns { stop() }

import { resolve as resolveCtx } from '#core';
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
  tree: Tree;
  path: string;
  subscribe: (path: string, cb: StoreListener, opts?: SubscribeOpts) => () => void;
};

declare module '#core/context' {
  interface ContextHandlers<T> {
    service: (value: T, ctx: ServiceCtx) => Promise<ServiceHandle>;
  }
}

// ── Bootstrap ──

export async function startServices(
  tree: Tree,
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
