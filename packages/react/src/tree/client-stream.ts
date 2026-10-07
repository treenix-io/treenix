import { type ClientObserver, treeClient } from '#tree/tree-client';

export interface ClientIterator<T> extends AsyncIterableIterator<T> {
  return(value?: unknown): Promise<IteratorResult<T>>;
  throw(reason: unknown): Promise<IteratorResult<T>>;
}

export function clientIterator<T>(register: (observer: ClientObserver<T>) => string, latest = false): ClientIterator<T> {
  const queue: T[] = [];
  let notify: (() => void) | undefined;
  let started = false;
  let done = false;
  let failed = false;
  let error: unknown;
  let id: string | undefined;

  const wake = () => {
    notify?.();
    notify = undefined;
  };
  const close = () => {
    done = true;
    if (id !== undefined) treeClient.cancel(id);
    wake();
  };

  return {
    [Symbol.asyncIterator]() { return this; },
    async next(): Promise<IteratorResult<T>> {
      if (!started && !done) {
        started = true;
        id = register({
          next(value) {
            if (!done) {
              if (latest) queue.length = 0;
              queue.push(value);
              wake();
            }
          },
          complete() { done = true; wake(); },
          error(reason) { failed = true; error = reason; close(); },
        });
        // A subscription may terminate synchronously before returning its id.
        if (done) treeClient.cancel(id);
      }
      while (!queue.length && !done) await new Promise<void>(resolve => { notify = resolve; });
      if (failed) throw error;
      if (queue.length) return { value: queue.shift()!, done: false };
      return { value: undefined, done: true };
    },
    async return(): Promise<IteratorResult<T>> {
      queue.length = 0;
      close();
      return { value: undefined, done: true };
    },
    async throw(reason: unknown): Promise<IteratorResult<T>> {
      queue.length = 0;
      close();
      throw reason;
    },
  };
}
