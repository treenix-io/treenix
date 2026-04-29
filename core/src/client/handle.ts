// Client node handle — typed access to remote nodes.
// nc(path).get(Type).method() — actions, no fetch needed.
// nc(path).fetch(Type) — async fetch + typed proxy.
// nc(path).sub(Type, cb) — reactive subscription with typed data.

import { type Class, type TypeProxy } from '#comp';
import { makeTypedProxy, type ExecuteFn } from '#comp/handle';
import type { NodeData } from '#core';
import type { TreenixClient } from './index';

export function createNodeClient(client: TreenixClient) {
  const execute: ExecuteFn = (input) =>
    client.execute(input.path, input.action, input.data, { type: input.type, key: input.key });

  return (path: string) => ({
    /** Typed actions proxy — calls execute over network, no fetch needed */
    get<T extends object>(cls: Class<T>, key?: string): TypeProxy<T> {
      return makeTypedProxy<T>(undefined, cls, path, execute, undefined, key);
    },

    /** Fetch node + typed proxy (data fields + action methods) */
    async fetch<T extends object>(cls: Class<T>, key?: string): Promise<TypeProxy<T>> {
      const node = await client.tree.get(path);
      return makeTypedProxy<T>(node, cls, path, execute, undefined, key);
    },

    /** Subscribe — callback with typed proxy on each change */
    async sub<T extends object>(cls: Class<T>, cb: (data: TypeProxy<T>) => void, key?: string) {
      let cached: NodeData | undefined;

      function notify() {
        cb(makeTypedProxy<T>(cached, cls, path, execute, undefined, key));
      }

      const { node, unsubscribe } = await client.watchPath(path, (event) => {
        if (event.type === 'set') {
          cached = { $path: event.path, ...event.node } as NodeData;
          notify();
        }
        if (event.type === 'patch' && cached) {
          // Re-fetch on patch (optimize with applyPatch later)
          client.tree.get(path).then(fresh => {
            if (fresh) { cached = fresh; notify(); }
          });
        }
      });

      cached = node as NodeData | undefined;
      if (cached) notify();
      return { unsubscribe };
    },
  });
}
