// Treenix WatchManager — Layer 5
// Exact-path + prefix (children) watch/unwatch per user.
// Supports multiple connections per user (multi-tab).
// Grace period: on last disconnect, watches survive briefly for SSE auto-reconnect.

import type { CdcRegistry, NodeEvent, QueryWatchRegistration } from './index';

export type WatchPush = (event: NodeEvent) => void;

export type WatchManagerOpts = {
  gracePeriodMs?: number;
  onUserRemoved?: (userId: string) => void;
  maxWatchesPerUser?: number;
  maxTotalWatches?: number;
  /** Per-user replay ring capacity (core-gk8.1). Default 1024. */
  ringSize?: number;
};

type QueryWatchRegistry = Pick<CdcRegistry, 'watchQuery' | 'unwatchQuery' | 'unwatchAllQueries'>;
type QueryWatchPlan = Omit<QueryWatchRegistration, 'vp' | 'userId'>;

export type WatchOpts = { children?: boolean; autoWatch?: boolean; query?: QueryWatchPlan };

export type WatchManager = {
  /** Attach push channel. `since` = last seq this client processed; events
   *  after it are replayed from the per-user ring through `push`.
   *  Returns true ONLY when continuity holds (core-gk8.1): watch-sets alive
   *  AND the gap is covered (replayed, or nothing was missed). False means
   *  the client MUST full-refetch and re-register watches. */
  connect(connId: string, userId: string, push: WatchPush, since?: number): boolean;
  disconnect(connId: string): void;
  /** Bind the instance-scoped query evaluator after withSubscriptions creates it. */
  bindQueryRegistry(registry: QueryWatchRegistry): void;
  watch(userId: string, paths: string[], opts?: WatchOpts): void;
  unwatch(userId: string, paths: string[], opts?: { children?: boolean }): void;
  notify(event: NodeEvent): void;
  /** Break continuity for EVERY tracked user — a delegated execute (federation)
   *  mutated remote state we cannot enumerate, so every client must refetch.
   *  Unlike notify(reconnect) — which only pushes to ACTIVE connections — this
   *  routes through the seq/ring machinery: active clients get the reset now,
   *  grace-period clients replay it from the ring, and users with no pushes
   *  get missedOffline so a legacy reconnect is answered `preserved:false`. */
  breakContinuity(): void;
  clientCount(): number;
};

const DEFAULT_GRACE_MS = 5_000;
const MAX_WATCHES_PER_USER = 10_000;
const MAX_TOTAL_WATCHES = 100_000;
const DEFAULT_RING_SIZE = 1024;

function addTo(map: Map<string, Set<string>>, key: string, uid: string) {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  set.add(uid);
}

function removeFrom(map: Map<string, Set<string>>, key: string, uid: string) {
  const set = map.get(key);
  if (!set) return;
  set.delete(uid);
  if (set.size === 0) map.delete(key);
}

export function createWatchManager(opts?: WatchManagerOpts): WatchManager {
  const gracePeriodMs = opts?.gracePeriodMs ?? DEFAULT_GRACE_MS;
  const maxPerUser = opts?.maxWatchesPerUser ?? MAX_WATCHES_PER_USER;
  const maxTotal = opts?.maxTotalWatches ?? MAX_TOTAL_WATCHES;
  const ringSize = opts?.ringSize ?? DEFAULT_RING_SIZE;
  const pathToUsers = new Map<string, Set<string>>();
  const prefixToUsers = new Map<string, Set<string>>();
  // seq/ring/missedOffline — replay machinery (core-gk8.1). seq is per-user
  // monotonic; the ring keeps the last `ringSize` routed events for resume.
  // missedOffline marks events stamped while no connection was attached —
  // a legacy reconnect (no `since`) can then be answered honestly.
  // paths value: true = auto-promoted by autoWatch (pruned on remove),
  // false = explicit watch(). Explicit survives remove — "watch this path"
  // includes seeing a later recreate; auto-watches must not, or a churning
  // directory grows user.paths until every watch() call throws (C27).
  type UserEntry = {
    pushes: Map<string, WatchPush>;
    paths: Map<string, boolean>;
    prefixes: Map<string, boolean>;
    seq: number;
    ring: { seq: number; event: NodeEvent }[];
    missedOffline: boolean;
  };
  const users = new Map<string, UserEntry>();
  const graceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let queryRegistry: QueryWatchRegistry | undefined;
  let totalWatches = 0;

  function userWatchCount(user: { paths: Map<string, boolean>; prefixes: Map<string, boolean> }): number {
    return user.paths.size + user.prefixes.size;
  }

  function checkLimits(user: { paths: Map<string, boolean>; prefixes: Map<string, boolean> }, adding: number) {
    if (userWatchCount(user) + adding > maxPerUser) {
      throw new Error(`Watch limit exceeded: max ${maxPerUser} watches per user`);
    }
    if (totalWatches + adding > maxTotal) {
      throw new Error(`Server watch limit exceeded`);
    }
  }

  function removeUser(userId: string) {
    const user = users.get(userId);
    if (!user) return;
    totalWatches -= userWatchCount(user);
    for (const p of user.paths.keys()) removeFrom(pathToUsers, p, userId);
    for (const p of user.prefixes.keys()) removeFrom(prefixToUsers, p, userId);
    queryRegistry?.unwatchAllQueries(userId);
    users.delete(userId);
    opts?.onUserRemoved?.(userId);
  }

  function pushToUser(uid: string, event: NodeEvent) {
    const user = users.get(uid);
    if (!user) return;
    // C26: event.invalidateVps is the union across ALL active queries — sent
    // whole it leaks other users' view paths. Deliver only the vps this user
    // registered (registration happens through their own ACL-gated read).
    if (event.invalidateVps) {
      const own = event.invalidateVps.filter(vp => user.prefixes.has(vp));
      if (own.length !== event.invalidateVps.length) {
        event = { ...event };
        if (own.length) event.invalidateVps = own;
        else delete event.invalidateVps;
      }
    }
    const safeEvent = { ...event, seq: ++user.seq };
    user.ring.push({ seq: safeEvent.seq, event: safeEvent });
    if (user.ring.length > ringSize) user.ring.shift();
    if (user.pushes.size === 0) user.missedOffline = true;
    for (const push of user.pushes.values()) push(safeEvent);
  }

  function ensureUser(userId: string) {
    let user = users.get(userId);
    if (!user) {
      user = { pushes: new Map(), paths: new Map(), prefixes: new Map(), seq: 0, ring: [], missedOffline: false };
      users.set(userId, user);
    }
    return user;
  }

  return {
    connect(connId, userId, push, since) {
      // Cancel grace timer — user reconnected in time
      const timer = graceTimers.get(userId);
      if (timer) {
        clearTimeout(timer);
        graceTimers.delete(userId);
      }

      const watchSetsAlive = users.has(userId);
      const user = ensureUser(userId);
      user.pushes.set(connId, push);
      if (!watchSetsAlive) return false;

      // Continuity (core-gk8.1): preserved must mean "you missed nothing" —
      // replayed from the ring, or provably no events during the gap. The old
      // watch-sets-survived-grace answer silently dropped grace-window events.
      let covered: boolean;
      if (since === undefined) {
        covered = !user.missedOffline;
      } else if (since >= user.seq) {
        covered = true;
      } else if (user.ring.length > 0 && user.ring[0].seq <= since + 1) {
        for (const entry of user.ring) {
          if (entry.seq > since) push(entry.event);
        }
        covered = true;
      } else {
        covered = false; // ring no longer covers the gap — refetch loudly
      }
      user.missedOffline = false;
      return covered;
    },

    disconnect(connId) {
      for (const [userId, user] of users) {
        if (!user.pushes.has(connId)) continue;
        user.pushes.delete(connId);

        if (user.pushes.size === 0) {
          // Start grace period — don't nuke watches yet
          const timer = setTimeout(() => {
            graceTimers.delete(userId);
            const u = users.get(userId);
            if (u && u.pushes.size === 0) removeUser(userId);
          }, gracePeriodMs);
          graceTimers.set(userId, timer);
        }
        return;
      }
    },

    bindQueryRegistry(registry) {
      queryRegistry = registry;
    },

    watch(userId, paths, watchOpts) {
      const user = ensureUser(userId);

      // Count only new additions (skip duplicates)
      let newCount = 0;
      if (watchOpts?.children) {
        for (const p of paths) if (!user.prefixes.has(p)) newCount++;
      } else {
        for (const p of paths) if (!user.paths.has(p)) newCount++;
      }

      if (newCount > 0) checkLimits(user, newCount);

      if (watchOpts?.children) {
        for (const p of paths) {
          user.prefixes.set(p, watchOpts.autoWatch ?? false);
          addTo(prefixToUsers, p, userId);
        }
        if (watchOpts.query) {
          for (const vp of paths) queryRegistry!.watchQuery({ vp, userId, ...watchOpts.query });
        }
      } else {
        for (const p of paths) {
          user.paths.set(p, false); // explicit — overrides a prior auto flag
          addTo(pathToUsers, p, userId);
        }
      }
      totalWatches += newCount;
    },

    unwatch(userId, paths, unwatchOpts) {
      const user = users.get(userId);
      if (!user) return;

      let removed = 0;
      if (unwatchOpts?.children) {
        for (const p of paths) {
          if (user.prefixes.has(p)) { user.prefixes.delete(p); removed++; }
          removeFrom(prefixToUsers, p, userId);
          queryRegistry?.unwatchQuery(p, userId);
        }
      } else {
        for (const p of paths) {
          if (user.paths.has(p)) { user.paths.delete(p); removed++; }
          removeFrom(pathToUsers, p, userId);
        }
      }
      totalWatches -= removed;
    },

    notify(event) {
      if (event.type === 'reconnect') {
        // Broadcast to every connection — source can't tell which paths
        // each user holds in cache.
        for (const user of users.values()) {
          for (const push of user.pushes.values()) push(event);
        }
        return;
      }
      const notified = new Set<string>();

      // Exact match
      const exact = pathToUsers.get(event.path);
      if (exact)
        for (const uid of exact) {
          notified.add(uid);
          pushToUser(uid, event);
        }

      // Prefix match: direct parent only (mirrors getChildren depth=1)
      const idx = event.path.lastIndexOf('/');
      if (idx < 0) return;
      const parent = idx === 0 ? '/' : event.path.slice(0, idx);
      const watchers = prefixToUsers.get(parent);
      if (watchers)
        for (const uid of watchers) {
          if (notified.has(uid)) continue;
          notified.add(uid);
          const user = users.get(uid);
          if (!user) continue;
          pushToUser(uid, event);
          // autoWatch: subscribe to exact path for future updates (respects limit).
          // Never on remove — that would watch a dead node forever (C27).
          if (event.type !== 'remove' && user.prefixes.get(parent) && !user.paths.has(event.path) && userWatchCount(user) < maxPerUser && totalWatches < maxTotal) {
            user.paths.set(event.path, true);
            addTo(pathToUsers, event.path, uid);
            totalWatches++;
          }
        }

      // Virtual Parent match — the coarse dirty signal (gk8.12). The event
      // carries invalidateVps; vp prefix-watchers receive it (and refetch),
      // with the same autoWatch promotion as plain parents.
      const vps = 'invalidateVps' in event && event.invalidateVps ? event.invalidateVps : [];
      for (const vp of vps) {
        const vpWatchers = prefixToUsers.get(vp);
        if (!vpWatchers) continue;
        for (const uid of vpWatchers) {
          if (notified.has(uid)) continue;
          notified.add(uid);
          const user = users.get(uid);
          if (!user) continue;
          pushToUser(uid, event);
          if (event.type !== 'remove' && user.prefixes.get(vp) && !user.paths.has(event.path) && userWatchCount(user) < maxPerUser && totalWatches < maxTotal) {
            user.paths.set(event.path, true);
            addTo(pathToUsers, event.path, uid);
            totalWatches++;
          }
        }
      }

      // C27: the removed node's auto-watches are done — prune AFTER delivery,
      // so the remove itself still reaches exact watchers. Explicit watches
      // (false flag) stay: they must see a recreate.
      if (event.type === 'remove') {
        const holders = pathToUsers.get(event.path);
        if (holders) {
          for (const uid of [...holders]) {
            const user = users.get(uid);
            if (user?.paths.get(event.path)) {
              user.paths.delete(event.path);
              removeFrom(pathToUsers, event.path, uid);
              totalWatches--;
            }
          }
        }
      }
    },

    breakContinuity() {
      for (const uid of users.keys()) {
        pushToUser(uid, { type: 'reconnect', preserved: false });
      }
    },

    clientCount() {
      let count = 0;
      for (const user of users.values()) count += user.pushes.size;
      return count;
    },
  };
}
