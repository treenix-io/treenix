// Remote Tree — Tree adapter over tRPC client.
// Maps the 4 Tree methods to tRPC query/mutation calls.
// Enables client to use the same combinators as server:
//   withSubscriptions(withCache(createRemoteTree(trpc)))

import type { NodeData } from '@treenity/core';
import type { Tree } from '@treenity/core/tree';
import { defaultPatch } from '@treenity/core/tree/patch';
import type { trpc } from './trpc';

type TrpcClient = typeof trpc;

function debugPath(path: string, op: string) {
  if (path.includes('//')) {
    console.error(`[remote-tree] double slash in ${op}: ${JSON.stringify(path)}`, new Error('stack'));
  }
}

export function createRemoteTree(client: TrpcClient): Tree {
  const get = (path: string) => {
    debugPath(path, 'get');
    return client.get.query({ path }) as Promise<NodeData | undefined>;
  };
  const set = (node: NodeData) => {
    debugPath(node.$path, 'set');
    return client.set.mutate({ node: node as Record<string, unknown> }).then(() => {});
  };

  return {
    get,
    getChildren: (path, opts) => {
      debugPath(path, 'getChildren');
      return client.getChildren.query({ path, ...opts });
    },
    set,
    remove: (path) => {
      debugPath(path, 'remove');
      return client.remove.mutate({ path }).then(() => true);
    },
    // TODO: add tRPC patch endpoint for single-RPC atomic patch
    patch: (path, ops) => defaultPatch(get, set, path, ops),
  };
}
