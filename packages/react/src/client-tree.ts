// Unified Client Tree — the browser as a peer node.
// /local/* paths live in browser memory only (never hit the network).
// Everything else routes through tRPC to the server.
// Same Tree interface everywhere — components don't know where data lives.

import { createFilterTree, createMemoryTree } from '@treenity/core/tree';
import { withCache } from '@treenity/core/tree/cache';
import { createRemoteTree } from './remote-tree';
import type { trpc } from './trpc';

type TrpcClient = typeof trpc;

export function createClientTree(client: TrpcClient) {
  const local = createMemoryTree();
  const remote = withCache(createRemoteTree(client));

  const tree = createFilterTree(
    local,
    remote,
    (node) => node.$path.startsWith('/local'),
  );

  return { tree, local, remote };
}
