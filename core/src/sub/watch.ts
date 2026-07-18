// Treenix WatchManager — Layer 5
// Exact-path + prefix (children) watch/unwatch per user.
// Supports multiple connections per user (multi-tab).
// Grace period: on last disconnect, watches survive briefly for SSE auto-reconnect.

import { planHash } from '#tree/plan-hash';
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

/** Per-recipient route provenance (ns6p.4 §3.4, invariant 26): which of THIS
 *  user's own registrations matched at routing time. The ACL filter's
 *  drop-fallback may reveal ONLY these — a vp-only recipient must never learn
 *  the hidden source path. Frozen into the ring: replay pushes the SAME
 *  envelope, never recomputes routes (holds may have changed since). */
export type RouteEnvelope = { event: StampedEvent; heldPaths: string[]; heldVps: string[] };

export type WatchPush = (envelope: RouteEnvelope) => void;

/** connect() result (ns6p.4 §4.5): the continuity verdict plus the CURRENT
 *  {seq, epoch}, which the lane stamps onto its initial reset/reconnect frame
 *  so even a signal-only client holds an epoch-bearing resume cursor. */
export type ConnectVerdict = WatchCursor & { preserved: boolean };

export type WatchManagerOpts = {
  gracePeriodMs?: number;
  onUserRemoved?: (userId: string) => void;
  maxWatchesPerUser?: number;
  maxTotalWatches?: number;
  /** Per-user replay ring capacity (core-gk8.1). Default 1024. */
  ringSize?: number;
  /** TTL for registrations under a token whose lane never connected (ns6p.4
   *  invariant 25). Token-grace only starts after connect+disconnect — a
   *  client that registers and dies pre-connect would otherwise hold forever
   *  while another tab keeps the user alive. Default 5 min. */
  unboundTokenTtlMs?: number;
};

type QueryWatchRegistry = Pick<CdcRegistry, 'watchQuery' | 'unwatchQuery' | 'unwatchAllQueries'>;
type QueryWatchPlan = Omit<QueryWatchRegistration, 'vp' | 'userId'>;

/** `token` scopes watch ownership to one wire session/tab (core-anz4.12).
 *  Callers that don't scope share a single legacy hold — pre-token behavior. */
export type WatchOpts = { children?: boolean; autoWatch?: boolean; query?: QueryWatchPlan; token?: string };
export type UnwatchOpts = { children?: boolean; token?: string };

/** Undo-delta of one watch() call (ns6p.4 §3.2.3, invariant 15). Captured at
 *  registration time because unwatch() releases unconditionally — compensating
 *  a failed request without it would strip pre-existing holds and lose the
 *  query plan a re-registration replaced (F4-r1/r2).
 *  Provisional-holder seam (r4-m7): holds are booked under the caller's token;
 *  slice 4 layers a unique per-request provisional holder (`holdPrefix`) on
 *  this same bookkeeping — nothing persists past the request, so release is
 *  plain undo, no merge. */
export type WatchLease = {
  /** Holds this call CREATED for its token — pre-existing holds (any holder,
   *  including the same token) are not listed and never touched by undo(). */
  created: { path: string; kind: 'exact' | 'prefix' }[];
  /** Per vp: the same-plan registration this call refreshed, or null = fresh
   *  handle (coexists with any other plans on the vp, §4.2). */
  replaced: { vp: string; prev: QueryWatchRegistration | null }[];
  /** Roll back exactly this call: drop created holds (releasing registrations
   *  only when the last holder goes), restore overwritten holder flags, and
   *  re-register replaced query plans. Idempotent. */
  undo(): void;
};

export type WatchManager = {
  /** Attach push channel. `since` = resume cursor: last seq this client
   *  processed + the epoch it was issued under (core-anz4.10); events after it
   *  are replayed from the per-user ring through `push`.
   *  `preserved` is true ONLY when continuity holds (core-gk8.1): watch-sets
   *  alive, cursor epoch matches the live stream, AND the gap is covered
   *  (replayed, or nothing was missed). A bare-number cursor (no epoch — old
   *  client) can never prove continuity → false, fail closed. False means the
   *  client MUST full-refetch and re-register watches. The verdict also
   *  carries the current {seq, epoch} for the lane's initial frame (anz4.28e).
   *  `token` binds this lane to a watch-ownership token (core-anz4.12): the
   *  token's registrations are released when its last lane disconnects and
   *  outlives the grace period. */
  connect(connId: string, userId: string, push: WatchPush, since?: number | WatchCursor, token?: string): ConnectVerdict;
  disconnect(connId: string): void;
  /** Bind the instance-scoped query evaluator after withSubscriptions creates it. */
  bindQueryRegistry(registry: QueryWatchRegistry): void;
  watch(userId: string, paths: string[], opts?: WatchOpts): WatchLease;
  /** Request-scoped provisional prefix hold (ns6p.4 §3.2.6a, invariant 27):
   *  covers the [scan → item-watch] window of ls{watch} without a list watch.
   *  Booked under a unique INTERNAL holder — the tab token would collapse
   *  concurrent requests (A's release would strip B's coverage). Budget-counted;
   *  never TTL'd/tombstoned (the peer releases it in a request-scoped finally).
   *  Returns the idempotent release. */
  holdPrefix(userId: string, path: string): () => void;
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
const DEFAULT_UNBOUND_TOKEN_TTL_MS = 300_000;
// Bounded FIFO — enough to outlive any realistic set of dead tabs; an evicted
// tombstone degrades to user-entry-death semantics (fresh entry ⇒ preserved:false).
const TOKEN_TOMBSTONE_CAP = 256;

/** Shared hold for callers that don't scope ownership by connection token —
 *  they collapse into one holder, i.e. exactly the pre-anz4.12 semantics. */
const LEGACY_TOKEN = '';

/** Reserved holder namespace of provisional per-request prefixes (invariant
 *  27). Unreachable from outside: wire tokens reject `\0` (peer vToken) and
 *  connect() refuses it — a lane bound to a guessed holder id could otherwise
 *  release an in-flight request's window coverage via token-grace. */
const PROVISIONAL_NS = '\0prov:';

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
  const unboundTokenTtlMs = opts?.unboundTokenTtlMs ?? DEFAULT_UNBOUND_TOKEN_TTL_MS;
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
    /** Unbound-token TTL (invariant 25): armed by watch() for a token with no
     *  connected lane; first connect() of that token cancels it. */
    tokenTtl: Map<string, ReturnType<typeof setTimeout>>;
    /** Tokens whose TTL expired (fail-closed continuity break): a late
     *  connect() consumes the tombstone and answers preserved:false — events
     *  after expiry were unrouted, no cursor can cover them. FIFO-capped. */
    tokenTombstones: Set<string>;
    paths: Map<string, Map<string, boolean>>;
    prefixes: Map<string, Map<string, boolean>>;
    seq: number;
    epoch: string;
    /** Entries hold the full route envelope (F6-r3): resume replays what was
     *  ROUTED, under the holds of that moment — not today's holds. */
    ring: { seq: number; envelope: RouteEnvelope }[];
    missedOffline: boolean;
  };
  const users = new Map<string, UserEntry>();
  const graceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let queryRegistry: QueryWatchRegistry | undefined;
  let totalWatches = 0;
  let provisionalSeq = 0;

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
    for (const timer of user.tokenTtl.values()) clearTimeout(timer);
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

  function parentOf(path: string): string | null {
    const idx = path.lastIndexOf('/');
    if (idx < 0) return null;
    return idx === 0 ? '/' : path.slice(0, idx);
  }

  function pushToUser(uid: string, event: NodeEvent) {
    const user = users.get(uid);
    if (!user) return;
    // C26: deliver only the vps this user registered (the union leaks other
    // users' view paths) — and membership-sourced vps only when THIS user's
    // projection flipped (anz4.27). The audience map is routing-internal:
    // stripped here, so it never reaches the ring or the wire.
    if (event.invalidateVps || event.membershipAudience) {
      const aud = event.membershipAudience;
      const own = (event.invalidateVps ?? []).filter(
        vp => user.prefixes.has(vp) && (!aud?.has(vp) || aud.get(vp)!.has(uid)),
      );
      event = { ...event };
      delete event.membershipAudience;
      if (own.length) event.invalidateVps = own;
      else delete event.invalidateVps;
    }
    // Route provenance (ns6p.4 §3.4, invariant 26): capture which of THIS
    // recipient's own registrations matched — before autoWatch promotion and
    // C27 pruning mutate the holds. The drop-fallback downstream may reveal
    // only these, so an exact/prefix holder still gets a refetch signal while
    // a vp-only recipient never learns the source path.
    const heldPaths: string[] = [];
    const heldVps: string[] = [];
    if (event.type !== 'reconnect') {
      if (user.paths.has(event.path)) heldPaths.push(event.path);
      const parent = parentOf(event.path);
      if (parent !== null && user.prefixes.has(parent)) heldVps.push(parent);
      // Post-narrowing invalidateVps ⊆ user.prefixes — all safe to name.
      for (const vp of event.invalidateVps ?? []) {
        if (vp !== parent) heldVps.push(vp);
      }
    }
    const seq = ++user.seq;
    const envelope: RouteEnvelope = { event: { ...event, seq, epoch: user.epoch }, heldPaths, heldVps };
    user.ring.push({ seq, envelope });
    if (user.ring.length > ringSize) user.ring.shift();
    if (user.pushes.size === 0) user.missedOffline = true;
    for (const push of user.pushes.values()) push(envelope);
  }

  function ensureUser(userId: string) {
    let user = users.get(userId);
    if (!user) {
      user = {
        pushes: new Map(),
        laneToken: new Map(),
        tokenLanes: new Map(),
        tokenGrace: new Map(),
        tokenTtl: new Map(),
        tokenTombstones: new Set(),
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

  const manager: WatchManager = {
    connect(connId, userId, push, since, token) {
      // '' is the internal LEGACY_TOKEN shared hold — an external empty token
      // would alias it and its disconnect would release every legacy watch.
      if (token === '') throw new Error('watch connect: connection token must be non-empty');
      // \0-prefixed = provisional-holder namespace (invariant 27): a lane bound
      // to it would release an in-flight request's coverage on disconnect.
      if (token?.startsWith('\0')) throw new Error('watch connect: reserved token namespace');
      // Cancel grace timer — user reconnected in time
      const timer = graceTimers.get(userId);
      if (timer) {
        clearTimeout(timer);
        graceTimers.delete(userId);
      }

      const watchSetsAlive = users.has(userId);
      const user = ensureUser(userId);
      user.pushes.set(connId, push);

      let tokenExpired = false;
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
        const ttlTimer = user.tokenTtl.get(token);
        if (ttlTimer) {
          clearTimeout(ttlTimer);
          user.tokenTtl.delete(token);
        }
        // Consumed once: this connect fails closed; the client refetches and
        // re-registers, so a LATER connect of the token judges continuity anew.
        tokenExpired = user.tokenTombstones.delete(token);
      }

      if (!watchSetsAlive) return { preserved: false, seq: user.seq, epoch: user.epoch };

      // Continuity (core-gk8.1): preserved must mean "you missed nothing" —
      // replayed from the ring, or provably no events during the gap. The
      // cursor's epoch is compared FIRST (anz4.10): after an entry restart or
      // a continuity break the seq counter restarts/diverges, and a bare
      // `since >= seq` on the fresh counter would answer "covered" over a
      // real gap (the two-tab resume hole). No epoch → fail closed.
      let covered: boolean;
      if (since === undefined) {
        // No cursor = a client with no history claiming nothing. missedOffline
        // only flips while ZERO pushes are attached — with another tab live,
        // events between this tab's initial fetch and this connect went to the
        // other tab and left no trace, so "covered" would silently skip them.
        // Alone + nothing missed is the only honest yes (core-anz4.11 review).
        covered = !user.missedOffline && user.pushes.size === 1;
      } else {
        const cSeq = typeof since === 'number' ? since : since.seq;
        const cEpoch = typeof since === 'number' ? undefined : since.epoch;
        if (cEpoch !== user.epoch) {
          covered = false;
        } else if (cSeq === user.seq) {
          covered = true;
        } else if (cSeq < user.seq && user.ring.length > 0 && user.ring[0].seq <= cSeq + 1) {
          // Replay the STORED envelopes (invariant 26): routes were computed
          // when the event fired; recomputing here would leak/lose provenance
          // for holds that changed during the gap.
          for (const entry of user.ring) {
            if (entry.seq > cSeq) push(entry.envelope);
          }
          covered = true;
        } else {
          // Ring no longer covers the gap — or the cursor is AHEAD of the
          // stream (impossible for an honest same-epoch client): refetch loudly.
          covered = false;
        }
      }
      user.missedOffline = false;
      // Tombstone overrides any coverage proof (invariant 25): the token's
      // holdings were released at expiry, so events since then were unrouted.
      return { preserved: covered && !tokenExpired, seq: user.seq, epoch: user.epoch };
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
      const kind: 'exact' | 'prefix' = watchOpts?.children ? 'prefix' : 'exact';
      const target = watchOpts?.children ? user.prefixes : user.paths;

      // Budget counts unique registrations, not holders: adding a hold to an
      // existing registration is free (and idempotent — see holder note above).
      const fresh = new Set<string>();
      for (const p of paths) if (!target.has(p)) fresh.add(p);
      if (fresh.size > 0) checkLimits(user, fresh.size);

      // Lease bookkeeping (invariant 15): per path, THIS token's prior hold
      // flag — undefined = no hold (created by this call), boolean = the flag
      // this call overwrites. Captured before mutation; undo restores exactly it.
      const priorFlags = new Map<string, boolean | undefined>();
      const replaced: { vp: string; prev: QueryWatchRegistration | null }[] = [];
      // Handle identity (§4.2 coexistence): undo/rollback release only the
      // plan THIS lease registered, never a coexisting plan on the same vp.
      const queryHash = watchOpts?.query ? planHash(watchOpts.query.plan) : undefined;

      if (watchOpts?.children) {
        // Query membership registers FIRST — watchQuery validates (projector
        // present, visible predicates, depth) and can refuse; publishing the
        // prefix holders before a refusal would leak a live watch with no
        // query registration behind it. Partial multi-vp failure rolls back —
        // restoring any plan an earlier vp's registration replaced.
        if (watchOpts.query) {
          try {
            for (const vp of paths) {
              const prev = queryRegistry!.watchQuery({ vp, userId, ...watchOpts.query });
              replaced.push({ vp, prev });
            }
          } catch (e) {
            for (const r of replaced) {
              if (r.prev) queryRegistry!.watchQuery(r.prev);
              else queryRegistry!.unwatchQuery(r.vp, userId, queryHash);
            }
            throw e;
          }
        }
        for (const p of paths) {
          let holders = user.prefixes.get(p);
          // First capture wins — a duplicate path in one call must not record
          // its own just-written flag as "pre-existing".
          if (!priorFlags.has(p)) priorFlags.set(p, holders?.get(token));
          if (!holders) {
            holders = new Map();
            user.prefixes.set(p, holders);
          }
          holders.set(token, watchOpts.autoWatch ?? false);
          addTo(prefixToUsers, p, userId);
        }
      } else {
        for (const p of paths) {
          let holders = user.paths.get(p);
          if (!priorFlags.has(p)) priorFlags.set(p, holders?.get(token));
          if (!holders) {
            holders = new Map();
            user.paths.set(p, holders);
          }
          holders.set(token, true); // explicit — upgrades a prior auto hold
          addTo(pathToUsers, p, userId);
        }
      }
      totalWatches += fresh.size;

      // Registration committed — arm the unbound-token TTL (invariant 25):
      // only here, never mid-request, and never for LEGACY (legacy clients
      // rely on user-grace). Not re-armed per call — the clock starts at the
      // token's first laneless registration. Provisional holders (invariant 27)
      // never arm it: they die in the request's finally, and their tombstones
      // would churn real tabs' out of the FIFO cap.
      if (token !== LEGACY_TOKEN && !token.startsWith(PROVISIONAL_NS) && !user.tokenLanes.has(token) && !user.tokenTtl.has(token)) {
        const ttlTimer = setTimeout(() => {
          const u = users.get(userId);
          if (!u || u.tokenTtl.get(token) !== ttlTimer) return;
          u.tokenTtl.delete(token);
          releaseTokenHoldings(userId, token);
          // FIFO-bounded tombstone: a later connect() must fail closed.
          u.tokenTombstones.delete(token);
          u.tokenTombstones.add(token);
          if (u.tokenTombstones.size > TOKEN_TOMBSTONE_CAP) {
            const oldest = u.tokenTombstones.values().next().value;
            if (oldest !== undefined) u.tokenTombstones.delete(oldest);
          }
        }, unboundTokenTtlMs);
        // Minutes-long timer must never hold the process open (mock timers
        // and non-Node runtimes may not expose unref).
        if (typeof ttlTimer.unref === 'function') ttlTimer.unref();
        user.tokenTtl.set(token, ttlTimer);
      }

      let undone = false;
      const undo = () => {
        if (undone) return;
        undone = true;
        const u = users.get(userId);
        if (!u) return; // user entry died — everything already released
        const map = kind === 'prefix' ? u.prefixes : u.paths;
        const index = kind === 'prefix' ? prefixToUsers : pathToUsers;
        for (const [p, prior] of priorFlags) {
          const holders = map.get(p);
          if (!holders || !holders.has(token)) continue; // released elsewhere meanwhile
          if (prior !== undefined) {
            holders.set(token, prior); // pre-existing hold: restore its flag only
            continue;
          }
          holders.delete(token);
          if (holders.size > 0) continue;
          map.delete(p);
          removeFrom(index, p, userId);
          if (kind === 'prefix') queryRegistry?.unwatchQuery(p, userId);
          totalWatches--;
        }
        for (const r of replaced) {
          // Restore only while a prefix holder still backs the vp — otherwise
          // drop this lease's handle too (a plan with no watcher is a leak).
          if (r.prev && u.prefixes.has(r.vp)) queryRegistry?.watchQuery(r.prev);
          else queryRegistry?.unwatchQuery(r.vp, userId, queryHash);
        }
      };

      return {
        created: [...priorFlags].filter(([, v]) => v === undefined).map(([path]) => ({ path, kind })),
        replaced,
        undo,
      };
    },

    holdPrefix(userId, path) {
      // Unique holder per call: same-token holders.set would collapse two
      // concurrent requests on one parent — A's release would strip B's
      // coverage mid-scan (r3-F3). Undo is the exact release: the created
      // hold dies, a co-held registration merely loses one holder.
      const lease = manager.watch(userId, [path], { children: true, token: PROVISIONAL_NS + ++provisionalSeq });
      return lease.undo;
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
        const envelope: RouteEnvelope = { event, heldPaths: [], heldVps: [] };
        for (const user of users.values()) {
          for (const push of user.pushes.values()) push(envelope);
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
      const audience = event.membershipAudience;
      for (const vp of vps) {
        const vpWatchers = prefixToUsers.get(vp);
        if (!vpWatchers) continue;
        // anz4.27: membership vps route only to flipped users; no audience
        // entry = coarse source = broadcast (owner-approved §6.3).
        const flipped = audience?.get(vp);
        for (const uid of vpWatchers) {
          if (flipped && !flipped.has(uid)) continue;
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
  return manager;
}
