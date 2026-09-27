// PathNotifier — the ONE path→consumer index behind cdc.subscribe and
// SubscribedTree.watch (ns6p.4 §4.1, closes core-ywo). Scopes are EXPLICIT
// because the two registries it replaced disagreed on "prefix" (invariant 20):
//   exact    — event.path === path
//   children — direct children only, never the path itself (L3 children contract)
//   subtree  — the path itself + every descendant (CDC prefix contract)
// User-lane routing (WatchManager) stays a dispatch consumer, not a scope here:
// its vp lane routes by event-carried invalidateVps (no path key), and holder
// maps / C26 / C27 / provenance need per-user state at push time.

import { dirname } from '#core/path';

export type NotifyScope = 'exact' | 'children' | 'subtree';

export type PathNotifier<E> = {
  register(path: string, scope: NotifyScope, consumer: (event: E) => void): () => void;
  /** Fan an event routed at `path` to every matching consumer. A consumer
   *  error is logged and isolated: notify runs AFTER the commit, so letting
   *  it propagate reported a committed write as failed (callers retried
   *  non-idempotent ops) and starved every later consumer of the event. */
  notify(path: string, event: E): void;
};

export function createPathNotifier<E>(): PathNotifier<E> {
  type Consumer = (event: E) => void;
  const byScope: Record<NotifyScope, Map<string, Set<Consumer>>> = {
    exact: new Map(),
    children: new Map(),
    subtree: new Map(),
  };

  return {
    register(path, scope, consumer) {
      const map = byScope[scope];
      let set = map.get(path);
      if (!set) map.set(path, set = new Set());
      set.add(consumer);
      return () => {
        const subs = map.get(path);
        if (!subs) return;
        subs.delete(consumer);
        if (subs.size === 0) map.delete(path);
      };
    },

    notify(path, event) {
      const deliver = (set: Set<Consumer> | undefined) => {
        if (!set) return;
        for (const fn of set) {
          try { fn(event); }
          catch (err) { console.error(`[notifier] consumer failed on ${path}:`, err); }
        }
      };

      deliver(byScope.exact.get(path));

      const parent = dirname(path);
      if (parent !== null) deliver(byScope.children.get(parent));

      // subtree: ancestor walk (self first) — O(depth), not O(#registrations).
      for (let p: string | null = path; p !== null; p = dirname(p)) deliver(byScope.subtree.get(p));
    },
  };
}
