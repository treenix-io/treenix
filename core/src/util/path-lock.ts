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
//
// Prefix spans (core-anz4.5): subtree(path, fn) = the exact lock on `path`
// PLUS a registered prefix — for the span, this chain is the only runner
// anywhere under `path`. Composition with the two invariants above:
//   • an acquire under an OWN active span (gate-identity checked) runs inline —
//     the span already IS the subtree's mutual exclusion; parking would
//     deadlock on our own gate;
//   • an acquire under a FOREIGN span waits on the span's gate, with the
//     ordered-wait rule applied to the PREFIX path (the lowest wait target):
//     a chain holding anything greater — e.g. an exact lock inside that very
//     subtree — rejects CONFLICT instead of parking, which is exactly the
//     edge that would otherwise close a writer↔span wait cycle.
// Hot path pays one `prefixes.size` integer check while no span is active.

import { AsyncLocalStorage } from 'node:async_hooks';
import { KernelError } from '#errors';

export type PathLock = {
  <T>(path: string, fn: () => Promise<T>): Promise<T>;
  /** Run `fn` with a CLEARED held-path set (core-anz4.21). A body detached from
   *  its spawning span (a job, a subscription listener) inherits the spawner's
   *  held set via ALS; without this reset it would re-enter a same-path lock
   *  nobody holds and violate mutual exclusion. Compose at the detachment
   *  boundary. */
  detach<T>(fn: () => T): T;
  /** Exclusive subtree span (core-anz4.5): exact lock on `path`, then a prefix
   *  registration + drain of in-flight holders below `path`. While the span
   *  runs, no other chain acquires anything under `path`. Spanning several
   *  prefixes → take them in sorted order (same rule as lockPaths). */
  subtree<T>(path: string, fn: () => Promise<T>): Promise<T>;
};

export function createPathLock(): PathLock {
  const locks = new Map<string, Promise<void>>();    // path → queue TAIL gate
  const owners = new Map<string, Promise<void>>();   // path → RUNNING owner's gate
  const prefixes = new Map<string, Promise<void>>(); // path → subtree SPAN's gate
  const held = new AsyncLocalStorage<Map<string, Promise<void>>>();

  const isUnder = (p: string, prefix: string) =>
    prefix === '/' ? p !== '/' : p.length > prefix.length && p.startsWith(prefix + '/');

  const lock = <T>(path: string, fn: () => Promise<T>): Promise<T> => {
    const current = held.getStore();

    // Reentrant only while OUR gate is the live owner — identity, not membership.
    const own = current?.get(path);
    if (own !== undefined && own === owners.get(path)) return fn();

    // Subtree spans: an OWN covering span subsumes this acquire (inline);
    // FOREIGN covering spans become extra wait targets chained into prev.
    let spanGates: Promise<void>[] | null = null;
    let waitFloor = path; // lowest path this acquire would wait on
    if (prefixes.size) {
      let ownedSpan = false;
      for (const [prefix, gate] of prefixes) {
        if (!isUnder(path, prefix)) continue;
        if (current?.get(prefix) === gate) { ownedSpan = true; break; }
        (spanGates ??= []).push(gate);
        if (prefix < waitFloor) waitFloor = prefix;
      }
      if (ownedSpan) return fn();
    }

    // Ordering rule: holding any path GREATER than the lowest wait target
    // (the contended path itself, or a foreign span's prefix) forbids waiting.
    if (current?.size && (spanGates || locks.has(path))) {
      for (const h of current.keys()) {
        if (waitFloor < h) {
          return Promise.reject(new KernelError('CONFLICT',
            `lock order: ${waitFloor} is contended while holding ${[...current.keys()].sort().join(', ')} — descending wait risks deadlock, retry`));
        }
      }
    }

    const tail = locks.get(path) ?? Promise.resolve();
    const prev: Promise<unknown> = spanGates ? Promise.all([tail, ...spanGates]) : tail;

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

  lock.subtree = <T>(path: string, fn: () => Promise<T>): Promise<T> =>
    lock(path, () => {
      const gate = owners.get(path);
      const current = held.getStore();
      // Inline acquisition (own covering span / stale identity): the subtree
      // is already exclusively this chain's — no nested registration needed.
      if (gate === undefined || current?.get(path) !== gate) return fn();

      prefixes.set(path, gate);
      const run = (async () => {
        // Snapshot in-flight holders below `path` in the SAME sync block as
        // the registration: anything already in `locks` is drained here;
        // anything later chains behind the span gate inside lock().
        const drains: Promise<void>[] = [];
        for (const [p, tail] of locks) {
          if (!isUnder(p, path)) continue;
          if (current.get(p) === owners.get(p)) continue; // own enclosing hold
          for (const h of current.keys()) {
            // Drain waits obey the ordered-wait rule too — fail loud, no park.
            if (p < h) {
              throw new KernelError('CONFLICT',
                `lock order: subtree ${path} must drain ${p} while holding ${h} — descending wait risks deadlock, retry`);
            }
          }
          drains.push(tail);
        }
        if (drains.length) await Promise.all(drains);
        return fn();
      })();
      return run.finally(() => {
        if (prefixes.get(path) === gate) prefixes.delete(path);
      });
    });

  return lock;
}
