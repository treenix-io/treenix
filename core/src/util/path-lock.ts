// Per-path async mutex factory — serializes concurrent async ops on the same key.
// Each createPathLock() returns an independent lock scope.
//
// Reentrant per async call chain (core-0fa): if the CURRENT chain already holds
// `path`, a nested acquire runs inline instead of awaiting its own gate. An
// action whose handler executes another action on the SAME node would otherwise
// self-deadlock — the outer holder is parked awaiting the inner, and the gate
// only releases when the outer finishes. Distinct chains still serialize.

import { AsyncLocalStorage } from 'node:async_hooks';

export type PathLock = {
  <T>(path: string, fn: () => Promise<T>): Promise<T>;
  /** Run `fn` with a CLEARED held-path set (core-anz4.21). A body detached from
   *  its spawning span (a job) inherits the spawner's held set via ALS; without
   *  this reset it would re-enter a same-path lock nobody holds and violate
   *  mutual exclusion. Compose at the detachment boundary. */
  detach<T>(fn: () => Promise<T>): Promise<T>;
};

export function createPathLock(): PathLock {
  const locks = new Map<string, Promise<void>>();
  const held = new AsyncLocalStorage<Set<string>>();

  const lock = <T>(path: string, fn: () => Promise<T>): Promise<T> => {
    const current = held.getStore();
    // Reentrant: this chain already owns `path` — run inline. The outer holder
    // is parked awaiting us, so there is no concurrent mutation to guard.
    if (current?.has(path)) return fn();

    const prev = locks.get(path) ?? Promise.resolve();

    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    locks.set(path, gate);

    // Run fn with `path` marked held so nested same-path acquires go reentrant.
    const runOwned = () => held.run(new Set(current).add(path), fn);

    return prev.then(runOwned, runOwned).finally(() => {
      if (locks.get(path) === gate) locks.delete(path);
      release();
    });
  };

  lock.detach = <T>(fn: () => Promise<T>): Promise<T> => held.run(new Set(), fn);
  return lock;
}
