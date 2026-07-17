// Treenix WatchManager — Layer 5
// Exact-path + prefix (children) watch/unwatch per user.
// Supports multiple connections per user (multi-tab).
// Grace period: on last disconnect, watches survive briefly for SSE auto-reconnect.

import type { CdcRegistry, NodeEvent, QueryWatchRegistration } from './index';

/** Resume cursor as round-tripped over the wire (core-anz4.10). `epoch` names
 *  the seq space it was issued under: minted when a user entry is created and
 *  re-minted on every continuity break. A cursor from a different epoch can
 *  never be "covered" — its seq values are from a dead stream. */
export type WatchCursor = { seq: number; epoch: string };

/** Event as delivered to a connection: stamped with the per-user resume cursor
 *  (seq watermark + current epoch). Clients track max(seq) and the last epoch
 *  seen, and echo both on resume. */
export type StampedEvent = NodeEvent & { seq?: number; epoch?: string };

export type WatchPush = (event: StampedEvent) => void;

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

/** `token` scopes watch ownership to one wire session/tab (core-anz4.12).
 *  Callers that don't scope share a single legacy hold — pre-token behavior. */
export type WatchOpts = { children?: boolean; autoWatch?: boolean; query?: QueryWatchPlan; token?: string };
export type UnwatchOpts = { children?: boolean; token?: string };

export type WatchManager = {
  /** Attach push channel. `since` = resume cursor: last seq this client
   *  processed + the epoch it was issued under (core-anz4.10); events after it
   *  are replayed from the per-user ring through `push`.
   *  Returns true ONLY when continuity holds (core-gk8.1): watch-sets alive,
   *  cursor epoch matches the live stream, AND the gap is covered (replayed,
   *  or nothing was missed). A bare-number cursor (no epoch — old client)
   *  can never prove continuity → false, fail closed. False means the client
   *  MUST full-refetch and re-register watches.
   *  `token` binds this lane to a watch-ownership token (core-anz4.12): the
   *  token's registrations are released when its last lane disconnects and
   *  outlives the grace period. */
  connect(connId: string, userId: string, push: WatchPush, since?: number | WatchCursor, token?: string): boolean;
  disconnect(connId: string): void;
  /** Bind the instance-scoped query evaluator after withSubscriptions creates it. */
  bindQueryRegistry(registry: QueryWatchRegistry): void;
  watch(userId: string, paths: string[], opts?: WatchOpts): void;
  unwatch(userId: string, paths: string[], opts?: UnwatchOpts): void;
  notify(event: NodeEvent): void;
  /** Break continuity for EVERY tracked user — a delegated execute (federation)
   *  mutated remote state we cannot enumerate, so every client must refetch.
   *  Routes through the seq/ring machinery AND re-mints every user's stream
   *  epoch (anz4.10/11): active clients get the reset now (stamped with the
   *  new epoch, so they can resume covered later), grace-period clients fail
   *  the epoch compare on resume, and users with no pushes get missedOffline
   *  so a legacy reconnect is answered `preserved:false`. */
  breakContinuity(): void;
  clientCount(): number;
};

const DEFAULT_GRACE_MS = 5_000;
const MAX_WATCHES_PER_USER = 10_000;
const MAX_TOTAL_WATCHES = 100_000;
const DEFAULT_RING_SIZE = 1024;

/** Shared hold for callers that don't scope ownership by connection token —
 *  they collapse into one holder, i.e. exactly the pre-anz4.12 semantics. */
const LEGACY_TOKEN = '';

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

function mintEpoch(): string {
  // Unique across process restarts and entry re-creations — a plain counter
  // would collide after a restart and falsely "cover" a stale cursor.
  return Date.now().toString(36) + '.' + Math.random().toString(36).slice(2, 10);
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
  //
  // Registrations are held per TOKEN (core-anz4.12). Holder map values:
  //   paths:    token → explicit? — false = auto-promoted by autoWatch, pruned
  //             on remove; true = explicit watch(). Explicit survives remove —
  //             "watch this path" includes seeing a later recreate; auto-holds
  //             must not, or a churning directory grows user.paths until every
  //             watch() call throws (C27).
  //   prefixes: token → autoWatch? — whether THIS holder asked for child
  //             promotion.
  // A registration (and its budget slot) dies only when its LAST holder
  // releases — a co-holder's unwatch/disconnect can no longer strip another
  // tab's watch, and re-watching a held path is a Map.set no-op, so refetch
  // loops cannot move the count (the previous refcount attempt leaked there).
  type UserEntry = {
    pushes: Map<string, WatchPush>;
    laneToken: Map<string, string>;
    tokenLanes: Map<string, Set<string>>;
    tokenGrace: Map<string, ReturnType<typeof setTimeout>>;
    paths: Map<string, Map<string, boolean>>;
    prefixes: Map<string, Map<string, boolean>>;
    seq: number;
    epoch: string;
    ring: { seq: number; event: StampedEvent }[];
    missedOffline: boolean;
  };
  const users = new Map<string, UserEntry>();
  const graceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let queryRegistry: QueryWatchRegistry | undefined;
  let totalWatches = 0;

  function userWatchCount(user: UserEntry): number {
    return user.paths.size + user.prefixes.size;
  }

  function checkLimits(user: UserEntry, adding: number) {
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
    for (const timer of user.tokenGrace.values()) clearTimeout(timer);
    totalWatches -= userWatchCount(user);
    for (const p of user.paths.keys()) removeFrom(pathToUsers, p, userId);
    for (const p of user.prefixes.keys()) removeFrom(prefixToUsers, p, userId);
    queryRegistry?.unwatchAllQueries(userId);
    users.delete(userId);
    opts?.onUserRemoved?.(userId);
  }

  /** Drop every registration held by `token`; a co-held registration merely
   *  loses one holder. Idempotent: a second call finds no holds. */
  function releaseTokenHoldings(userId: string, token: string) {
    const user = users.get(userId);
    if (!user) return;
    for (const [p, holders] of user.paths) {
      if (!holders.delete(token) || holders.size > 0) continue;
      user.paths.delete(p);
      removeFrom(pathToUsers, p, userId);
      totalWatches--;
    }
    for (const [p, holders] of user.prefixes) {
      if (!holders.delete(token) || holders.size > 0) continue;
      user.prefixes.delete(p);
      removeFrom(prefixToUsers, p, userId);
      queryRegistry?.unwatchQuery(p, userId);
      totalWatches--;
    }
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
    const seq = ++user.seq;
    const safeEvent: StampedEvent = { ...event, seq, epoch: user.epoch };
    user.ring.push({ seq, event: safeEvent });
    if (user.ring.length > ringSize) user.ring.shift();
    if (user.pushes.size === 0) user.missedOffline = true;
    for (const push of user.pushes.values()) push(safeEvent);
  }

  function ensureUser(userId: string) {
    let user = users.get(userId);
    if (!user) {
      user = {
        pushes: new Map(),
        laneToken: new Map(),
        tokenLanes: new Map(),
        tokenGrace: new Map(),
        paths: new Map(),
        prefixes: new Map(),
        seq: 0,
        epoch: mintEpoch(),
        ring: [],
        missedOffline: false,
      };
      users.set(userId, user);
    }
    return user;
  }

  // autoWatch: subscribe to exact path for future updates (respects limits).
  // Never on remove — that would watch a dead node forever (C27). Promotion
  // is per token: only prefix holders that asked autoWatch gain an auto hold
  // on the child, so releasing that token releases only its promotions.
  function promoteAuto(user: UserEntry, uid: string, prefix: string, path: string) {
    const prefHolders = user.prefixes.get(prefix);
    if (!prefHolders) return;
    let holders = user.paths.get(path);
    for (const [token, auto] of prefHolders) {
      if (!auto || holders?.has(token)) continue;
      if (!holders) {
        if (userWatchCount(user) >= maxPerUser || totalWatches >= maxTotal) return;
        holders = new Map();
        user.paths.set(path, holders);
        addTo(pathToUsers, path, uid);
        totalWatches++;
      }
      holders.set(token, false); // auto hold — pruned on remove (C27)
    }
  }

  /** Continuity break: re-mint every epoch FIRST, then ring-route the reset —
   *  the pushed reconnect is stamped under the NEW epoch, so live clients
   *  adopt it and can resume covered later, while every pre-break cursor now
   *  fails the epoch compare regardless of seq (anz4.10/11). */
  function breakAll() {
    for (const [uid, user] of users) {
      user.epoch = mintEpoch();
      pushToUser(uid, { type: 'reconnect', preserved: false });
    }
  }

  return {
    connect(connId, userId, push, since, token) {
      // Cancel grace timer — user reconnected in time
      const timer = graceTimers.get(userId);
      if (timer) {
        clearTimeout(timer);
        graceTimers.delete(userId);
      }

      const watchSetsAlive = users.has(userId);
      const user = ensureUser(userId);
      user.pushes.set(connId, push);

      if (token !== undefined) {
        user.laneToken.set(connId, token);
        let lanes = user.tokenLanes.get(token);
        if (!lanes) {
          lanes = new Set();
          user.tokenLanes.set(token, lanes);
        }
        lanes.add(connId);
        const tokenTimer = user.tokenGrace.get(token);
        if (tokenTimer) {
          clearTimeout(tokenTimer);
          user.tokenGrace.delete(token);
        }
      }

      if (!watchSetsAlive) return false;

      // Continuity (core-gk8.1): preserved must mean "you missed nothing" —
      // replayed from the ring, or provably no events during the gap. The
      // cursor's epoch is compared FIRST (anz4.10): after an entry restart or
      // a continuity break the seq counter restarts/diverges, and a bare
      // `since >= seq` on the fresh counter would answer "covered" over a
      // real gap (the two-tab resume hole). No epoch → fail closed.
      let covered: boolean;
      if (since === undefined) {
        // No cursor = a client with no history claiming nothing; missedOffline
        // is the only honest signal available. Clients with any history send a
        // full cursor and go through the epoch gate.
        covered = !user.missedOffline;
      } else {
        const cSeq = typeof since === 'number' ? since : since.seq;
        const cEpoch = typeof since === 'number' ? undefined : since.epoch;
        if (cEpoch !== user.epoch) {
          covered = false;
        } else if (cSeq === user.seq) {
          covered = true;
        } else if (cSeq < user.seq && user.ring.length > 0 && user.ring[0].seq <= cSeq + 1) {
          for (const entry of user.ring) {
            if (entry.seq > cSeq) push(entry.event);
          }
          covered = true;
        } else {
          // Ring no longer covers the gap — or the cursor is AHEAD of the
          // stream (impossible for an honest same-epoch client): refetch loudly.
          covered = false;
        }
      }
      user.missedOffline = false;
      return covered;
    },

    disconnect(connId) {
      for (const [userId, user] of users) {
        if (!user.pushes.has(connId)) continue;
        user.pushes.delete(connId);

        const token = user.laneToken.get(connId);
        if (token !== undefined) {
          user.laneToken.delete(connId);
          const lanes = user.tokenLanes.get(token);
          if (lanes) {
            lanes.delete(connId);
            if (lanes.size === 0) {
              user.tokenLanes.delete(token);
              // Token grace mirrors the user grace: a transport blip must not
              // strip the tab's watches, but a tab that never returns must not
              // leak them past its last co-holder (anz4.12). Released at most
              // once — the timer removes itself before releasing.
              const tokenTimer = setTimeout(() => {
                const u = users.get(userId);
                if (!u || u.tokenGrace.get(token) !== tokenTimer) return;
                u.tokenGrace.delete(token);
                releaseTokenHoldings(userId, token);
              }, gracePeriodMs);
              user.tokenGrace.set(token, tokenTimer);
            }
          }
        }

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
      const token = watchOpts?.token ?? LEGACY_TOKEN;
      const target = watchOpts?.children ? user.prefixes : user.paths;

      // Budget counts unique registrations, not holders: adding a hold to an
      // existing registration is free (and idempotent — see holder note above).
      const fresh = new Set<string>();
      for (const p of paths) if (!target.has(p)) fresh.add(p);
      if (fresh.size > 0) checkLimits(user, fresh.size);

      if (watchOpts?.children) {
        for (const p of paths) {
          let holders = user.prefixes.get(p);
          if (!holders) {
            holders = new Map();
            user.prefixes.set(p, holders);
          }
          holders.set(token, watchOpts.autoWatch ?? false);
          addTo(prefixToUsers, p, userId);
        }
        if (watchOpts.query) {
          for (const vp of paths) queryRegistry!.watchQuery({ vp, userId, ...watchOpts.query });
        }
      } else {
        for (const p of paths) {
          let holders = user.paths.get(p);
          if (!holders) {
            holders = new Map();
            user.paths.set(p, holders);
          }
          holders.set(token, true); // explicit — upgrades a prior auto hold
          addTo(pathToUsers, p, userId);
        }
      }
      totalWatches += fresh.size;
    },

    unwatch(userId, paths, unwatchOpts) {
      const user = users.get(userId);
      if (!user) return;
      const token = unwatchOpts?.token ?? LEGACY_TOKEN;

      let removed = 0;
      if (unwatchOpts?.children) {
        for (const p of paths) {
          const holders = user.prefixes.get(p);
          if (!holders || !holders.delete(token)) continue;
          if (holders.size > 0) continue; // co-held by another token — keep (anz4.12)
          user.prefixes.delete(p);
          removeFrom(prefixToUsers, p, userId);
          queryRegistry?.unwatchQuery(p, userId);
          removed++;
        }
      } else {
        for (const p of paths) {
          const holders = user.paths.get(p);
          if (!holders || !holders.delete(token)) continue;
          if (holders.size > 0) continue;
          user.paths.delete(p);
          removeFrom(pathToUsers, p, userId);
          removed++;
        }
      }
      totalWatches -= removed;
    },

    notify(event) {
      if (event.type === 'reconnect') {
        if (!event.preserved) {
          // An external source (Mongo change stream, fs watcher) lost
          // continuity (anz4.11): unknown external writes never entered any
          // ring, so resume coverage is void for everyone — same global break
          // as a delegated execute.
          breakAll();
          return;
        }
        // Continuity held — informational broadcast to every connection;
        // source can't tell which paths each user holds in cache.
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
          if (event.type !== 'remove') promoteAuto(user, uid, parent, event.path);
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
          if (event.type !== 'remove') promoteAuto(user, uid, vp, event.path);
        }
      }

      // C27: the removed node's auto-holds are done — prune AFTER delivery,
      // so the remove itself still reaches exact watchers. Explicit holds
      // stay: they must see a recreate.
      if (event.type === 'remove') {
        const holdersUsers = pathToUsers.get(event.path);
        if (holdersUsers) {
          for (const uid of [...holdersUsers]) {
            const user = users.get(uid);
            if (!user) continue;
            const holders = user.paths.get(event.path);
            if (!holders) continue;
            for (const [token, explicit] of holders) {
              if (!explicit) holders.delete(token);
            }
            if (holders.size === 0) {
              user.paths.delete(event.path);
              removeFrom(pathToUsers, event.path, uid);
              totalWatches--;
            }
          }
        }
      }
    },

    breakContinuity() {
      breakAll();
    },

    clientCount() {
      let count = 0;
      for (const user of users.values()) count += user.pushes.size;
      return count;
    },
  };
}
