// Treenix Service Context — Layer 2
// Service = register(type, "service", handler) → returns { stop() }

import { resolve as resolveCtx } from '#core';
import { type ExecTree } from '#tree';

// ── Types ──

export type ServiceHandle = { stop(): Promise<void> };
// kriz: why this type here??? is it service context? used only in tests. i think it should be imported from somewhere
// kriz: or belong to tests
export type StoreEvent =
  | { type: 'set'; path: string }
  | { type: 'patch'; path: string }
  | { type: 'remove'; path: string };
export type StoreListener = (event: StoreEvent) => void;
export type SubscribeOpts = { children?: boolean };
export type ServiceCtx = {
  // Exec-capable by contract (core-pxlu): the factory passes the pipeline tree,
  // so services call tree.execute directly — full executor + federation routing.
  tree: ExecTree;
  path: string;
  // kriz: what is it for? why not tree, or sub like client! should fully review subscription/watch infostructure and unify!
  // where is node itself? look to the ExecCtx, why is the diff?
  subscribe: (path: string, cb: StoreListener, opts?: SubscribeOpts) => () => void;
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
