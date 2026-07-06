// Client node handle — typed access to remote nodes.
// nc(path).get(Type).method() — actions, no fetch needed.
// nc(path).fetch(Type) — async fetch + typed proxy.
// nc(path).sub(Type, cb) — reactive subscription with typed data.
// kriz: why this file called handle?

import { type Class, type TypeProxy } from '#comp';
import { makeTypedProxy, type ExecuteFn } from '#comp/handle';
import type { NodeData } from '#core';
import type { TreenixClient } from './index';

// kriz: what type of return of this function?
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

    /** Subscribe — callback with typed proxy on each change. `onRemove` fires
     *  when the watched node is deleted; without it a consumer keeps serving
     *  the dead node's data forever (core-m77 C32). */
    async sub<T extends object>(
      cls: Class<T>,
      cb: (data: TypeProxy<T>) => void,
      opts?: { key?: string; onRemove?: () => void },
    ) {
      const key = opts?.key;
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
          }).catch(err => {
            // Keep serving `cached` — but a silent miss here means the
            // subscriber renders stale data with no signal; surface it.
            console.error('[nc.sub] re-fetch after patch failed:', path, err);
          });
        }
        if (event.type === 'remove') {
          cached = undefined;
          opts?.onRemove?.();
        }
      });

      cached = node;
      if (cached) notify();
      return { unsubscribe };
    },
  });
}
