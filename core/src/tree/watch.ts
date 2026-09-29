// Treenix Tree Watch — Layer 1 protocol
// TreeEvent / TreeWatchScope / TreeWatchOpts + subscriptionToAsyncIterable helper.
// No VPs, no CDC: those live in #sub (L3) on NodeEvent = TreeEvent & Partial<VpDelta>.

import type { NodeData } from '#core';
import { KernelError } from '#errors';
import type { PatchOp } from './patch';

// seq/by — wire protocol revision (core-gk8.1, twp-spec §5.1):
//   seq — per-user monotonic cursor, stamped by WatchManager at delivery;
//         a watermark (ACL filtering may skip values), NOT a contiguity counter.
//   by  — opId of the client mutation that produced this event; lets the
//         optimistic layer confirm exactly its own writes (core-cnr.6).
export type TreeEvent =
  | { type: 'set';       path: string; node: Omit<NodeData, '$path'>; seq?: number; by?: string }
  | { type: 'patch';     path: string; patches: PatchOp[]; rev?: number; seq?: number; by?: string }
  | { type: 'remove';    path: string; seq?: number; by?: string }
  | { type: 'reconnect'; preserved: boolean };

export type TreeWatchScope =
  | { kind: 'all' }
  | { kind: 'path';     path: string }
  | { kind: 'children'; path: string };

export type TreeWatchOpts = {
  /** Abort closes the stream and runs cleanup. L5 transports MUST bind
   *  request-disconnect to this signal. */
  signal?: AbortSignal;
  /** Bounded queue size. Default 1024. Overflow emits one
   *  `reconnect{preserved:false}` and closes the stream. */
  buffer?: number;
};

const DEFAULT_BUFFER = 1024;

/**
 * Adapt a register/unregister-style listener API into an AsyncIterable<E>.
 *
 * Contract (matches the Tree.watch lifecycle spec):
 * - Lazy activation: `register()` is called on the FIRST `.next()`, never earlier.
 * - Cleanup runs unconditionally on `return()`, `throw()`, abort, or overflow:
 *   we call the unregister returned by `register()` and detach the abort listener.
 * - Pre-aborted signal short-circuits: first `.next()` resolves `{done:true}`
 *   without ever calling `register()`.
 * - Overflow (queue > buffer) replaces the pending queue with exactly one
 *   `overflowEvent`, then closes. No silent drops.
 * - Graceful shutdown: register receives a second `endStream` callback.
 *   Calling it stops accepting new events but lets the queue drain — the
 *   iterator yields any pending events and THEN returns `done`. Used by
 *   sources that get an "end-of-stream" signal (e.g. Mongo `invalidate`)
 *   and want the consumer to terminate the for-await loop naturally.
 * - `buffer <= 0` throws `INVALID` at iteration start.
 *
 * Generic `E` lets callers narrow the event type (e.g. NodeEvent in #sub).
 * The `overflowEvent` factory supplies a typed reconnect for the caller's E,
 * so the helper never reaches for `as any` to synthesize one.
 */
export function subscriptionToAsyncIterable<E>(
  register: (push: (e: E) => void, endStream: () => void) => () => void,
  overflowEvent: E,
  opts?: TreeWatchOpts,
): AsyncIterable<E> {
  const buffer = opts?.buffer ?? DEFAULT_BUFFER;
  const signal = opts?.signal;

  return {
    [Symbol.asyncIterator](): AsyncIterableIterator<E> {
      if (buffer <= 0) {
        throw new KernelError('INVALID', `subscriptionToAsyncIterable: buffer must be > 0, got ${buffer}`);
      }

      let registered = false;
      let closed = false;
      let endRequested = false;
      let unregister: (() => void) | null = null;
      const queue: E[] = [];
      let waiter: ((v: IteratorResult<E>) => void) | null = null;
      let abortListener: (() => void) | null = null;

      function detach() {
        if (unregister) {
          try { unregister(); }
          catch (err) { console.error('[subscriptionToAsyncIterable] unregister failed:', err); }
          unregister = null;
        }
        if (abortListener && signal) {
          signal.removeEventListener('abort', abortListener);
          abortListener = null;
        }
      }

      function shutdown() {
        if (closed) return;
        closed = true;
        detach();
        if (waiter) {
          const w = waiter; waiter = null;
          w({ value: undefined, done: true });
        }
      }

      function push(e: E) {
        if (closed || endRequested) return;

        if (queue.length >= buffer) {
          // Overflow — drop pending, replace with single overflowEvent, close
          queue.length = 0;
          queue.push(overflowEvent);
          closed = true;
          detach();
          if (waiter) {
            const w = waiter; waiter = null;
            w({ value: queue.shift()!, done: false });
          }
          return;
        }

        if (waiter) {
          const w = waiter; waiter = null;
          w({ value: e, done: false });
          return;
        }
        queue.push(e);
      }

      function endStream() {
        if (endRequested || closed) return;
        endRequested = true;
        // If a consumer is waiting AND the queue is empty, close now.
        // Otherwise the next .next() drains the queue and then closes.
        if (queue.length === 0 && waiter) shutdown();
      }

      const iterator: AsyncIterableIterator<E> = {
        async next(): Promise<IteratorResult<E>> {
          if (queue.length > 0) {
            return { value: queue.shift()!, done: false };
          }
          if (endRequested) {
            // Queue drained after graceful endStream() — close now.
            shutdown();
            return { value: undefined, done: true };
          }
          if (closed) {
            return { value: undefined, done: true };
          }
          if (signal?.aborted) {
            shutdown();
            return { value: undefined, done: true };
          }
          if (!registered) {
            registered = true;
            unregister = register(push, endStream);
            if (signal) {
              abortListener = () => shutdown();
              signal.addEventListener('abort', abortListener);
            }
            // register() may push, end or overflow synchronously: waiting now would miss it forever.
            if (closed) detach();
            if (queue.length > 0 || endRequested || closed) return iterator.next();
          }
          return new Promise<IteratorResult<E>>(resolve => {
            waiter = resolve;
          });
        },
        async return(): Promise<IteratorResult<E>> {
          shutdown();
          return { value: undefined, done: true };
        },
        async throw(err: unknown): Promise<IteratorResult<E>> {
          shutdown();
          throw err;
        },
        [Symbol.asyncIterator]() { return this; },
      };

      return iterator;
    },
  };
}
