// Unified Client Tree — the browser as a peer node.
// FilterTree: /local/* → memory+mounts, everything else → remote.
// Reads merge both — /local visible alongside server nodes.

import type { NodeData } from '@treenx/core';
import { withMounts } from '@treenx/core/server/mount';
import './fiber-tree'; // registers t.mount.react
import { createFilterTree, createMemoryTree } from '@treenx/core/tree';
import { withCache } from '@treenx/core/tree/cache';
import { createRemoteTree } from './remote-tree';
import type { trpc } from './trpc';

type TrpcClient = typeof trpc

export function createClientTree(client: TrpcClient) {
  const memory = createMemoryTree()
  const remote = withCache(createRemoteTree(client))

  // Seed local tree
  memory.set({ $path: '/local', $type: 'dir' } as NodeData)
  memory.set({ $path: '/local/react', $type: 'dir', mount: { $type: 't.mount.react' } } as NodeData)

  const local = withMounts(memory)

  // Writes: /local/* → memory, else → remote
  // Reads: merge both — /local visible alongside server nodes
  const tree = createFilterTree(local, remote, (node) => node.$path.startsWith('/local'))

  return { tree }
}
