// Client node handle — typed access to remote nodes.
// nc(path).get(Type).method() — actions, no fetch needed.
// nc(path).fetch(Type) — async fetch + typed proxy.
// nc(path).sub(Type, cb) — reactive subscription with typed data.
// kriz: why this file called handle?

import { type Class, type TypeProxy } from '#comp';
import { makeTypedProxy, type ExecuteInput, type ExecuteFn, type StreamFn } from '#comp/handle';
import { getComponentField } from '#core';
import { KernelError } from '#errors';
import type { Node, Rev } from '#kernel/types';
import type { TwpClient } from './twp';

/** Keep the existing typed get/fetch/sub API over canonical native requests. */
export function createNodeClient(client: TwpClient) {
  return (path: string) => {
    let absolutePath = path;

    async function read(): Promise<Node> {
      await client.ready;
      const copy = (await client.read({ node: path })).copies[0];
      if ('error' in copy) throw new KernelError(copy.error.code, copy.error.message);
      absolutePath = copy.node.$path;
      return copy.node;
    }

    /** Class-based access resolves the actual component; covered copies avoid a second network read. */
    async function request(input: ExecuteInput) {
      await client.ready;
      const copy = client.cache.at(absolutePath);
      if (copy !== undefined && 'error' in copy)
        throw new KernelError(copy.error.code, copy.error.message);
      const node = copy === undefined ? await read() : copy.node;
      const component = getComponentField(node, input.type ?? node.$type, input.key);
      if (component === undefined) throw new KernelError('NOT_FOUND', 'Typed component is absent');
      return client.act({
        path: node.$path,
        action: input.action,
        args: input.data === undefined ? {} : input.data,
        ...(component[1] === '' ? {} : { component: component[1] }),
      });
    }

    const execute: ExecuteFn = async (input) => (await (await request(input)).outcome).value;
    const stream: StreamFn = async function* (input) {
      const pending = await request(input);
      let settled = false;
      void pending.outcome.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      try {
        yield* pending.chunks;
        await pending.outcome;
      } finally {
        if (!settled && client.failure() === undefined) client.cancel(pending.id);
      }
    };

    return {
      /** Create typed action methods without asking callers to fetch the node first. */
      get<T extends object>(cls: Class<T>, key?: string): TypeProxy<T> {
        return makeTypedProxy<T>(undefined, cls, path, execute, stream, key);
      },

      /** Retain canonical fields and metadata in the typed presentation. */
      async fetch<T extends object>(cls: Class<T>, key?: string): Promise<TypeProxy<T>> {
        return makeTypedProxy<T>(await read(), cls, path, execute, stream, key);
      },

      /** Deliver native snapshots once per revision and expose removal or refusal to the caller. */
      async sub<T extends object>(
        cls: Class<T>,
        cb: (data: TypeProxy<T>) => void,
        opts?: { key?: string; onRemove?: () => void; onError?: (error: KernelError) => void },
      ) {
        await client.ready;
        let subscription: ReturnType<TwpClient['sub']> | undefined;
        let revision: Rev | undefined;
        let identity: string | undefined;
        let disposed = false;

        function refused(error: KernelError): void {
          if (disposed || (error.code === 'CANCELLED' && client.failure() === error)) return;
          if (opts?.onError === undefined) throw error;
          opts.onError(error);
        }

        function changed(): void {
          if (subscription === undefined || disposed) return;
          const list = client.cache.list(subscription.id);
          if (list === undefined || list.phase === 'loading') return;
          if (list.ids.length === 0) {
            if (identity !== undefined) opts?.onRemove?.();
            revision = undefined;
            identity = undefined;
            return;
          }
          const copy = client.cache.ordered(list.ids, [])[0];
          if ('error' in copy) {
            refused(new KernelError(copy.error.code, copy.error.message));
            return;
          }
          const node = copy.node;
          if (node.$id === identity && node.$rev === revision) return;
          absolutePath = node.$path;
          identity = node.$id;
          revision = node.$rev;
          cb(makeTypedProxy<T>(node, cls, path, execute, stream, opts?.key));
        }

        subscription = client.sub({ node: path }, changed, refused);
        try {
          await subscription.ready;
          changed();
        } catch (error) {
          disposed = true;
          subscription.close();
          throw error;
        }
        const owned = subscription;
        return {
          unsubscribe() {
            disposed = true;
            owned.close();
          },
        };
      },
    };
  };
}
