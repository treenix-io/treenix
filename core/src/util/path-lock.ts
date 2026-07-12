// Per-path async mutex factory — serializes concurrent async ops on the same key.
// Each createPathLock() returns an independent lock scope.
//
// Reentrant per async call chain (core-0fa): if the CURRENT chain already holds
// `path`, a nested acquire runs inline instead of awaiting its own gate. An
// action whose handler executes another action on the SAME node would otherwise
// self-deadlock — the outer holder is parked awaiting the inner, and the gate
// only releases when the outer finishes. Distinct chains still serialize.
//
// Ownership is gate-identity, not path membership (core-anz4.4): the held map
// remembers WHICH gate this chain owns, checked against the currently RUNNING
// owner. A chain that outlives its span (timed-out action resuming, escaped
// callback) carries a stale gate, fails the identity check, and queues like any
// independent writer instead of falsely running inline over the next owner.
//
// Deadlock prevention (core-anz4.4): a chain already holding locks may WAIT
// only in ascending path order — every wait cycle needs a descending wait
// somewhere, so ordered waits cannot cycle. A descending acquire is taken
// inline when free; contended → loud CONFLICT (caller retries), never parked.

import { AsyncLocalStorage } from 'node:async_hooks';
import { OpError } from '#errors';

export type PathLock = {
  <T>(path: string, fn: () => Promise<T>): Promise<T>;
  /** Run `fn` with a CLEARED held-path set (core-anz4.21). A body detached from
   *  its spawning span (a job, a subscription listener) inherits the spawner's
   *  held set via ALS; without this reset it would re-enter a same-path lock
   *  nobody holds and violate mutual exclusion. Compose at the detachment
   *  boundary. */
  detach<T>(fn: () => T): T;
};

export function createPathLock(): PathLock {
  const locks = new Map<string, Promise<void>>();   // path → queue TAIL gate
  const owners = new Map<string, Promise<void>>();  // path → RUNNING owner's gate
  const held = new AsyncLocalStorage<Map<string, Promise<void>>>();

  const lock = <T>(path: string, fn: () => Promise<T>): Promise<T> => {
    const current = held.getStore();

    // Reentrant only while OUR gate is the live owner — identity, not membership.
    const own = current?.get(path);
    if (own !== undefined && own === owners.get(path)) return fn();

    // Ordering rule: holding any GREATER path forbids waiting on this one.
    if (current?.size && locks.has(path)) {
      for (const h of current.keys()) {
        if (path < h) {
          return Promise.reject(new OpError('CONFLICT',
            `lock order: ${path} is contended while holding ${[...current.keys()].sort().join(', ')} — descending wait risks deadlock, retry`));
        }
      }
    }

    const prev = locks.get(path) ?? Promise.resolve();

    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    locks.set(path, gate);

    // Run fn with `path` owned by THIS gate so nested acquires go reentrant.
    const runOwned = () => {
      owners.set(path, gate);
      return held.run(new Map(current).set(path, gate), fn);
    };

    return prev.then(runOwned, runOwned).finally(() => {
      if (owners.get(path) === gate) owners.delete(path);
      if (locks.get(path) === gate) locks.delete(path);
      release();
    });
  };

  lock.detach = <T>(fn: () => T): T => held.run(new Map(), fn);
  return lock;
}
