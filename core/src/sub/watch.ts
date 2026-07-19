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

/** Per-recipient route provenance (inv.26): which of THIS user's registrations
 *  matched at routing time — the ACL drop-fallback may reveal ONLY these.
 *  Frozen into the ring: replay pushes the same envelope, never recomputes. */
export type RouteEnvelope = { event: StampedEvent; heldPaths: string[]; heldVps: string[] };

export type WatchPush = (envelope: RouteEnvelope) => void;

/** Continuity verdict + CURRENT {seq, epoch} for the lane's initial frame —
 *  even a signal-only client holds an epoch-bearing resume cursor (anz4.28e). */
export type ConnectVerdict = WatchCursor & { preserved: boolean };

export type WatchManagerOpts = {
  gracePeriodMs?: number;
  onUserRemoved?: (userId: string) => void;
  maxWatchesPerUser?: number;
  maxTotalWatches?: number;
  /** Per-user replay ring capacity (core-gk8.1). Default 1024. */
  ringSize?: number;
  /** TTL for registrations under a never-connected token (inv.25): token-grace
   *  starts only after connect+disconnect, so a client dying pre-connect would
   *  otherwise hold forever while another tab keeps the user alive. Default 5 min. */
  unboundTokenTtlMs?: number;
  /** Per-user cap on expired-token tombstones (F7). Default 256. */
  tokenTombstoneCap?: number;
};

type QueryWatchRegistry = Pick<CdcRegistry, 'watchQuery' | 'unwatchQuery' | 'unwatchAllQueries'>;
// holder excluded: the lease supplies its own token (F5) — a caller-provided one would lie.
type QueryWatchPlan = Omit<QueryWatchRegistration, 'vp' | 'userId' | 'holder'>;

/** `token` scopes watch ownership to one wire session/tab (core-anz4.12).
 *  Callers that don't scope share a single legacy hold — pre-token behavior. */
export type WatchOpts = { children?: boolean; autoWatch?: boolean; query?: QueryWatchPlan; token?: string };
export type UnwatchOpts = { children?: boolean; token?: string };

/** Undo-delta of one watch() call (inv.15), captured at registration time:
 *  unwatch() releases unconditionally, so compensating a failed request
 *  without it would strip pre-existing holds and lose replaced query plans
 *  (F4-r1/r2). holdPrefix (inv.27, r4-m7) layers on this same bookkeeping. */
export type WatchLease = {
  /** Holds this call CREATED for its token — pre-existing holds (any holder)
   *  are not listed and never touched by undo(). */
  created: { path: string; kind: 'exact' | 'prefix' }[];
  /** Per vp: the same-plan registration this call refreshed, or null = fresh
   *  handle (coexists with any other plans on the vp, §4.2). */
  replaced: { vp: string; prev: QueryWatchRegistration | null }[];
  /** Roll back exactly this call: drop created holds (a registration dies only
   *  with its last holder), restore flags, re-register replaced plans. Idempotent. */
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
   *  client MUST full-refetch and re-register watches.
   *  `token` binds this lane to a watch-ownership token (core-anz4.12): the
   *  token's registrations are released when its last lane disconnects and
   *  outlives the grace period. */
  connect(connId: string, userId: string, push: WatchPush, since?: number | WatchCursor, token?: string): ConnectVerdict;
  disconnect(connId: string): void;
  /** Bind the instance-scoped query evaluator after withSubscriptions creates it. */
  bindQueryRegistry(registry: QueryWatchRegistry): void;
  watch(userId: string, paths: string[], opts?: WatchOpts): WatchLease;
  /** Request-scoped provisional prefix hold (inv.27): covers the [scan →
   *  item-watch] window of ls{watch}. Booked under a unique INTERNAL holder —
   *  a tab token would collapse concurrent requests. Budget-counted; never
   *  TTL'd (the peer releases it in a request finally). Idempotent release. */
  holdPrefix(userId: string, path: string): () => void;
  /** Bracket-open of one tokened request (inv.25 F3): pairs with the
   *  armUnboundTtl the request boundary calls — the TTL countdown may start
   *  only when the LAST overlapping same-token request completes, or the
   *  first boundary would arm while a concurrent request still reads under
   *  the coverage. */
  beginTokenRequest(userId: string, token: string): void;
  /** Start the unbound-token TTL countdown (inv.25) for a token that
   *  registered while laneless — called at the REQUEST boundary (F7: arming
   *  inside watch() could expire mid-read). Decrements the in-flight bracket
   *  and arms only at zero. No-op for tokens that didn't register, have a
   *  lane, or already run a TTL; first connect() disarms. */
  armUnboundTtl(userId: string, token: string): void;
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
// Bounded FIFO; eviction breaks the USER's continuity (F7) — forgetting the
// fail-closed proof would let a late connect judge preserved:true from
// surviving user state.
const DEFAULT_TOKEN_TOMBSTONE_CAP = 256;

/** Shared hold for callers that don't scope ownership by connection token —
 *  they collapse into one holder, i.e. exactly the pre-anz4.12 semantics. */
const LEGACY_TOKEN = '';

/** Reserved holder namespace of per-request provisional prefixes (inv.27).
 *  Unreachable from outside: vToken and connect() reject `\0` — a guessed
 *  holder id could otherwise release an in-flight request's coverage. */
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
  const tombstoneCap = opts?.tokenTombstoneCap ?? DEFAULT_TOKEN_TOMBSTONE_CAP;
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
    /** Unbound-token TTL (invariant 25): armed at the REQUEST boundary via
     *  armUnboundTtl (F7 — arming inside watch() could expire mid-read);
     *  first connect() of that token cancels it. */
    tokenTtl: Map<string, ReturnType<typeof setTimeout>>;
    /** Laneless tokens that registered this request — armUnboundTtl consumes
     *  the flag when the request completes (F7). */
    ttlPending: Set<string>;
    /** Tokens whose TTL expired: a late connect() consumes the tombstone and
     *  answers preserved:false — events after expiry were unrouted. Capped;
     *  eviction breaks the user's continuity instead of forgetting (F7). */
    tokenTombstones: Set<string>;
    paths: Map<string, Map<string, boolean>>;
    prefixes: Map<string, Map<string, boolean>>;
    seq: number;
    epoch: string;
    /** Full envelopes (F6-r3): resume replays what was ROUTED under the holds of that moment. */
    ring: { seq: number; envelope: RouteEnvelope }[];
    missedOffline: boolean;
    /** r3-F4: durable tombstone-cap eviction proof. missedOffline dies at the
     *  FIRST reconnect of ANY lane, but the evicted token may NEVER have
     *  connected (no cursor for the epoch re-mint to refuse) — this flag
     *  refuses cursorless coverage for the entry's lifetime (dies in removeUser). */
    tombstoneOverflowed: boolean;
  };
  const users = new Map<string, UserEntry>();
  const graceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // In-flight tokened requests per (user, token) — F3/inv.25. Outside the user
  // entry: a request may begin before any watch() creates one, and the map
  // self-cleans at the last boundary. '\0' is safe — vToken rejects it.
  const tokenInflight = new Map<string, number>();
  const inflightKey = (userId: string, token: string) => userId + '\0' + token;
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
      if (!holders.delete(token)) continue;
      if (holders.size > 0) {
        // F5: behind a co-holder the token's plan handles would stay live
        // forever, and the co-holder's later release would nuke plans it
        // never registered — release only THIS token's holds.
        queryRegistry?.unwatchQuery(p, userId, undefined, token);
        continue;
      }
      user.prefixes.delete(p);
      removeFrom(prefixToUsers, p, userId);
      queryRegistry?.unwatchQuery(p, userId);
      totalWatches--;
    }
  }

  // Root is its own parent here ('/' → '/') — notify()'s prefix-routing
  // contract; core dirname ('/' → null) would drop root-event provenance.
  function parentOf(path: string): string | null {
    const idx = path.lastIndexOf('/');
    if (idx < 0) return null;
    return idx === 0 ? '/' : path.slice(0, idx);
  }

  function pushToUser(uid: string, event: NodeEvent) {
    const user = users.get(uid);
    if (!user) return;
    // C26 + anz4.27: deliver only this user's own vps, membership-sourced ones
    // only when THIS user flipped. Audience is routing-internal — stripped
    // here, never reaching the ring or the wire.
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
    // inv.26: capture the recipient's matched registrations BEFORE autoWatch
    // promotion / C27 pruning mutate the holds — the drop-fallback downstream
    // may reveal only these.
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
        ttlPending: new Set(),
        tokenTombstones: new Set(),
        paths: new Map(),
        prefixes: new Map(),
        seq: 0,
        epoch: mintEpoch(),
        ring: [],
        missedOffline: false,
        tombstoneOverflowed: false,
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

  /** Continuity break for one user: re-mint the epoch FIRST, then ring-route
   *  the reset — the pushed reconnect is stamped under the NEW epoch, so live
   *  clients adopt it and can resume covered later, while every pre-break
   *  cursor now fails the epoch compare regardless of seq (anz4.10/11). */
  function breakUser(uid: string, user: UserEntry) {
    user.epoch = mintEpoch();
    pushToUser(uid, { type: 'reconnect', preserved: false });
  }

  function breakAll() {
    for (const [uid, user] of users) breakUser(uid, user);
  }

  /** Arm one unbound-token TTL window (inv.25). Fire checks the request
   *  bracket (r3-F3): a same-token request that began after arming still reads
   *  under the token's register-first coverage — releasing mid-read would
   *  strip holds its response relies on. Defer a full fresh window instead;
   *  the fire after the last boundary (bracket at zero, no lane) releases. */
  function armTokenTtl(userId: string, token: string) {
    const user = users.get(userId);
    if (!user) return;
    const ttlTimer = setTimeout(() => {
      const u = users.get(userId);
      if (!u || u.tokenTtl.get(token) !== ttlTimer) return;
      u.tokenTtl.delete(token);
      if ((tokenInflight.get(inflightKey(userId, token)) ?? 0) > 0) {
        armTokenTtl(userId, token);
        return;
      }
      u.ttlPending.delete(token);
      releaseTokenHoldings(userId, token);
      // Fail-closed tombstone: a later connect() must answer preserved:false.
      u.tokenTombstones.delete(token);
      u.tokenTombstones.add(token);
      if (u.tokenTombstones.size > tombstoneCap) {
        // F7/inv.25: eviction must not FORGET the proof — breaking this
        // user's continuity re-mints the epoch, so every pre-break cursor
        // (the evicted token's included) fails closed anyway.
        const oldest = u.tokenTombstones.values().next().value;
        if (oldest !== undefined) u.tokenTombstones.delete(oldest);
        breakUser(userId, u);
        // F4: the evicted token may NEVER have connected — it has no cursor
        // for the epoch re-mint to refuse, and the cursorless-alone rule
        // reads missedOffline. Leave the proof there, or a later lone
        // connect of the evicted token would judge preserved:true over
        // registrations that died at expiry.
        u.missedOffline = true;
        // r3-F4: durable twin of the line above — missedOffline is consumed
        // by the next connect of ANY lane; this one dies only with the entry.
        u.tombstoneOverflowed = true;
      }
    }, unboundTokenTtlMs);
    // Never hold the process open (mock timers / non-Node may lack unref).
    if (typeof ttlTimer.unref === 'function') ttlTimer.unref();
    user.tokenTtl.set(token, ttlTimer);
  }

  const manager: WatchManager = {
    connect(connId, userId, push, since, token) {
      // '' is the internal LEGACY_TOKEN shared hold — an external empty token
      // would alias it and its disconnect would release every legacy watch.
      if (token === '') throw new Error('watch connect: connection token must be non-empty');
      // \0 = provisional namespace (inv.27): such a lane would release an
      // in-flight request's coverage on disconnect.
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
        // A lane arrived before the request-boundary arm (F7) — nothing to TTL.
        user.ttlPending.delete(token);
        // Consumed once: this connect fails closed; a LATER connect of the
        // token judges continuity anew (client refetched and re-registered).
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
        // r3-F4: tombstoneOverflowed adds the durable eviction proof — an
        // earlier reconnect consumed missedOffline, but an evicted
        // never-connected token still judges here; cursor-bearing connects
        // below keep their explicit epoch/ring proof.
        covered = !user.missedOffline && !user.tombstoneOverflowed && user.pushes.size === 1;
      } else {
        const cSeq = typeof since === 'number' ? since : since.seq;
        const cEpoch = typeof since === 'number' ? undefined : since.epoch;
        if (cEpoch !== user.epoch) {
          covered = false;
        } else if (cSeq === user.seq) {
          covered = true;
        } else if (cSeq < user.seq && user.ring.length > 0 && user.ring[0].seq <= cSeq + 1) {
          // inv.26: replay the STORED envelopes — holds may have changed during the gap.
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
      // inv.25: tombstone overrides coverage — events since expiry were unrouted.
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

      // inv.15: per path, THIS token's prior hold flag — undefined = created by
      // this call. Captured before mutation; undo restores exactly it.
      const priorFlags = new Map<string, boolean | undefined>();
      const replaced: { vp: string; prev: QueryWatchRegistration | null }[] = [];
      // F5: vps where THIS call added the token as plan holder — undo strips
      // exactly those (a hold an earlier lease established must survive).
      const planHolderAdded = new Set<string>();
      // §4.2 coexistence: undo releases only the plan THIS lease registered.
      const queryHash = watchOpts?.query ? planHash(watchOpts.query.plan) : undefined;
      // Compensation of the plan-holds this call took: restore replaced deps,
      // then drop only the newly-added holder (handle dies with its last one).
      const undoPlans = (u: UserEntry | undefined) => {
        for (const r of replaced) {
          // Restore only while a prefix holder still backs the vp — a plan with
          // no watcher is a leak. (u = undefined: pre-publish rollback, prefix
          // holds were never taken, restore unconditionally.)
          if (r.prev && (!u || u.prefixes.has(r.vp))) queryRegistry!.watchQuery(r.prev);
          if (planHolderAdded.has(r.vp)) queryRegistry!.unwatchQuery(r.vp, userId, queryHash, token);
        }
      };

      // Query membership registers FIRST — watchQuery validates and can refuse;
      // publishing prefix holders before a refusal would leak a live watch with
      // no query registration behind it. Partial multi-vp failure rolls back,
      // restoring any plan an earlier vp's registration replaced.
      if (watchOpts?.children && watchOpts.query) {
        try {
          for (const vp of paths) {
            const { prev, holderAdded } = queryRegistry!.watchQuery({ vp, userId, ...watchOpts.query, holder: token });
            replaced.push({ vp, prev });
            if (holderAdded) planHolderAdded.add(vp);
          }
        } catch (e) {
          undoPlans(undefined);
          throw e;
        }
      }

      const index = kind === 'prefix' ? prefixToUsers : pathToUsers;
      for (const p of paths) {
        let holders = target.get(p);
        // First capture wins — a duplicate path in one call must not record
        // its own just-written flag as "pre-existing".
        if (!priorFlags.has(p)) priorFlags.set(p, holders?.get(token));
        if (!holders) {
          holders = new Map();
          target.set(p, holders);
        }
        // exact = explicit (upgrades a prior auto hold); prefix carries the autoWatch flag
        holders.set(token, kind === 'prefix' ? (watchOpts?.autoWatch ?? false) : true);
        addTo(index, p, userId);
      }
      totalWatches += fresh.size;

      // Flag for the unbound-token TTL (inv.25) — armed by armUnboundTtl at
      // the REQUEST boundary (F7: arming here could expire mid-read and strip
      // coverage the response still relies on). Only real tabs: LEGACY relies
      // on user-grace; provisional holders (inv.27) die in the request finally.
      if (token !== LEGACY_TOKEN && !token.startsWith(PROVISIONAL_NS) && !user.tokenLanes.has(token)) {
        user.ttlPending.add(token);
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
        undoPlans(u);
      };

      return {
        created: [...priorFlags].filter(([, v]) => v === undefined).map(([path]) => ({ path, kind })),
        replaced,
        undo,
      };
    },

    holdPrefix(userId, path) {
      // Unique holder per call (r3-F3): a same-token hold would collapse two
      // concurrent requests on one parent. lease.undo is the exact release.
      const lease = manager.watch(userId, [path], { children: true, token: PROVISIONAL_NS + ++provisionalSeq });
      return lease.undo;
    },

    beginTokenRequest(userId, token) {
      const k = inflightKey(userId, token);
      tokenInflight.set(k, (tokenInflight.get(k) ?? 0) + 1);
    },

    armUnboundTtl(userId, token) {
      // F3: earlier boundaries of overlapping same-token requests only
      // decrement — ttlPending survives them, and only the LAST request out
      // may arm. An unbracketed call (no begin — legacy/direct) arms as before.
      const k = inflightKey(userId, token);
      const inflight = tokenInflight.get(k);
      if (inflight !== undefined) {
        if (inflight > 1) {
          tokenInflight.set(k, inflight - 1);
          return;
        }
        tokenInflight.delete(k);
      }
      const user = users.get(userId);
      // Consumed flag = the token registered while laneless during this
      // request (watch() sets it); anything else is a no-op.
      if (!user || !user.ttlPending.delete(token)) return;
      if (user.tokenLanes.has(token) || user.tokenTtl.has(token)) return;
      armTokenTtl(userId, token);
    },

    unwatch(userId, paths, unwatchOpts) {
      const user = users.get(userId);
      if (!user) return;
      const token = unwatchOpts?.token ?? LEGACY_TOKEN;
      const children = unwatchOpts?.children ?? false;
      const map = children ? user.prefixes : user.paths;
      const index = children ? prefixToUsers : pathToUsers;

      let removed = 0;
      for (const p of paths) {
        const holders = map.get(p);
        if (!holders || !holders.delete(token)) continue;
        if (holders.size > 0) {
          // Co-held by another token — the registration stays (anz4.12), but
          // THIS token's plan handles release with its prefix hold (F5).
          if (children) queryRegistry?.unwatchQuery(p, userId, undefined, token);
          continue;
        }
        map.delete(p);
        removeFrom(index, p, userId);
        if (children) queryRegistry?.unwatchQuery(p, userId);
        removed++;
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
      const parent = parentOf(event.path);
      if (parent === null) return;
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
