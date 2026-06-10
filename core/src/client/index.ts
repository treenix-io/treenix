// Treenix Client SDK — transport-agnostic tree client interface.
// Transports: trpc (now), ws (future), http (future).

import type { Tree } from '#tree';

export type WatchSub = { unsubscribe(): void };

export type TreenixClient = {
  tree: Tree;
  // kriz: should accept ExecuteData
  execute(path: string, action: string, data?: unknown, opts?: { type?: string; key?: string }): Promise<unknown>;
  // TODO: merge watch + watch path via setting `/` or `*` as path.
  /** Global SSE stream — all events for this user */
  watch(onEvent: (e: any) => void): WatchSub;
  /** Watch specific path — registers watch + filters events. Returns initial node + subscription. */
  // kriz: return promise { node: any } & WatchSub, or even WatchSub & { node: Promise<any> } ? discuss
  watchPath(path: string, onEvent: (e: any) => void): Promise<{ node: any; unsubscribe(): void }>;
  /** Tear down transport — unsubscribe SSE, clear all watchers */
  destroy(): void;
};

// kriz: circular import, trpc and handle need this index.ts
export { createTrpcTransport } from './trpc';
export { createNodeClient } from './handle';
export { createClient, type WireClient } from './wire';
