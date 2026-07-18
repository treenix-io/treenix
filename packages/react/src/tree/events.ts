// Server event subscription — module-level, not tied to any React component.
// Listens to trpc.events SSE and updates the cache.

import type { NodeData } from '@treenx/core';
import { applyOps, type PatchOp } from '@treenx/core/tree';
import * as cache from './cache';
import { applyServerPatch, applyServerSet, clear as clearRebase } from './rebase';
import { AUTH_EXPIRED_EVENT, clearToken, getToken, tabTokenInput, trpc } from './trpc';

type LoadChildren = (path: string) => Promise<void>;

interface EventsConfig {
  loadChildren?: LoadChildren;
  getExpanded?: () => Set<string>;
  getSelected?: () => string | null;
}

// ── SSE connection events (consumed by App.tsx) ──

export const SSE_CONNECTED = 'sse-connected';
export const SSE_DISCONNECTED = 'sse-disconnected';

let unsub: (() => void) | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let lastConfig: EventsConfig | null = null;

// Highest event seq processed — the resume watermark (core-gk8.1). A reconnect
// asks the server to replay from here; the ring delivers the gap or answers
// preserved:false and we full-refetch. Watermark (max-seen), not a counter:
// gaps are the server's problem to detect, not ours to count. Reset to 0 only
// on a fresh stream (new login), never on reconnect — see startEvents(resume).
let lastSeq = 0;

// Stream epoch (core-anz4.10) — stamped by the server WatchManager on every
// delivered event; names the seq space the watermark belongs to. Echoed with
// `since` so the server can refuse a cursor from a dead stream (fail closed).
// Never cleared on reconnect: a stale epoch is refused server-side, which is
// exactly the honest answer; only a fresh stream (new login) drops it.
// Not in the tRPC-inferred event type until the server wiring lands — decode
// structurally at the wire boundary.
let lastEpoch: string | null = null;

function epochOf(event: object): string | undefined {
  if ('epoch' in event && typeof event.epoch === 'string') return event.epoch;
  return undefined;
}

function seqOf(event: object): number | undefined {
  if ('seq' in event && typeof event.seq === 'number') return event.seq;
  return undefined;
}

// Coalesce dirty refetches per vp (gk8.12): a burst of writes into one query
// view triggers ONE listing refetch, not one per event.
const DIRTY_COALESCE_MS = 75;
const dirtyTimers = new Map<string, ReturnType<typeof setTimeout>>();
function refetchDirtyVp(vp: string, loadChildren: LoadChildren) {
  if (dirtyTimers.has(vp)) return;
  dirtyTimers.set(vp, setTimeout(() => {
    dirtyTimers.delete(vp);
    void loadChildren(vp);
  }, DIRTY_COALESCE_MS));
}

type FetchNode = (path: string) => Promise<NodeData | null | undefined>;

// Exact-path invalidation (ns6p.4 §3.4): the server dropped the payload for a
// path this client holds (ACL) — refetch through the normal read path. A
// denied/gone refetch must EVICT: the entry is known-stale and the reader may
// no longer see the node at all; keeping it freezes stale data forever.
// Coalesced like vp refetches. `fetchNode` is injected so tests can stub it.
const invalidatedTimers = new Map<string, ReturnType<typeof setTimeout>>();
export function refetchInvalidatedPath(path: string, fetchNode: FetchNode) {
  if (invalidatedTimers.has(path)) return;
  invalidatedTimers.set(path, setTimeout(() => {
    invalidatedTimers.delete(path);
    fetchNode(path).then(
      (n) => { if (n) cache.put(n); else cache.remove(path); },
      (err: unknown) => {
        console.error('[sse] refetch of invalidated %s failed — evicting:', path, err);
        cache.remove(path);
      },
    );
  }, DIRTY_COALESCE_MS));
}

const fetchInvalidatedNode: FetchNode = (path) => trpc.get.query({ path });

function isUnauthorized(err: unknown): boolean {
  const data = (err as { data?: { code?: string; httpStatus?: number } }).data;
  return data?.code === 'UNAUTHORIZED' || data?.httpStatus === 401;
}

// Wait until a session token appears, then call `cb` once. Listens to localStorage 'storage'
// events (cross-tab) AND polls every 500ms (same-tab — login fires no storage event in the
// originating window). De-noops itself once it fires.
let tokenWaitTimer: ReturnType<typeof setInterval> | null = null;
let tokenWaitListener: ((e: StorageEvent) => void) | null = null;
function waitForToken(cb: () => void) {
  if (tokenWaitTimer || tokenWaitListener) return; // already waiting
  const fire = () => {
    if (!getToken()) return;
    if (tokenWaitTimer) { clearInterval(tokenWaitTimer); tokenWaitTimer = null; }
    if (tokenWaitListener && typeof window !== 'undefined') {
      window.removeEventListener('storage', tokenWaitListener);
      tokenWaitListener = null;
    }
    cb();
  };
  tokenWaitTimer = setInterval(fire, 500);
  if (typeof window !== 'undefined') {
    tokenWaitListener = (e: StorageEvent) => { if (e.key === 'treenix_token') fire(); };
    window.addEventListener('storage', tokenWaitListener);
  }
}

export function startEvents(config: EventsConfig = {}, resume = false) {
  stopEvents();
  lastConfig = config;

  // A fresh stream (mount / login) starts a new per-user seq space — a stale
  // watermark from a prior session must not ask the server to replay it, and
  // its overlays are equally dead (same continuity-break as preserved:false).
  if (!resume) {
    lastSeq = 0;
    lastEpoch = null;
    clearRebase();
  }

  // Defer SSE until a session token exists. Once a token lands (login),
  // the caller's auth-state effect or the storage listener below wakes it.
  if (!getToken()) {
    waitForToken(() => { if (lastConfig) startEvents(lastConfig); });
    return;
  }

  const { loadChildren, getExpanded, getSelected } = config;

  // Resume cursor + tab token ride the input. epoch/token cross as spreads
  // (spreads bypass excess-property checks against the inferred input type);
  // the server's zod strips them until the anz4.10/4.12 wiring lands — after
  // it, the epoch makes resumes provably continuous and the token keys watch
  // ownership to this tab.
  const sub = trpc.events.subscribe(
    {
      ...(lastSeq > 0 || lastEpoch !== null ? { since: lastSeq } : {}),
      ...(lastEpoch !== null ? { epoch: lastEpoch } : {}),
      ...tabTokenInput,
    },
    {
    onStarted() {
      window.dispatchEvent(new Event(SSE_CONNECTED));
    },
    onConnectionStateChange(state: { state: string }) {
      if (state.state === 'connecting') {
        window.dispatchEvent(new Event(SSE_DISCONNECTED));
      } else if (state.state === 'pending') {
        // 'pending' = connected and waiting for data — SSE is alive
        window.dispatchEvent(new Event(SSE_CONNECTED));
      }
    },
    onError(err: unknown) {
      if (isUnauthorized(err)) {
        clearToken();
        window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
        return;
      }
      console.error('[sse] subscription error (non-retryable):', err);
      window.dispatchEvent(new Event(SSE_DISCONNECTED));
      // tRPC exhausted retries — back off briefly before re-subscribing
      scheduleResubscribe(RESUBSCRIBE_BACKOFF_MS);
    },
    onStopped() {
      // Server closed the stream cleanly — re-subscribe immediately, no banner.
      // Banner only appears if the reconnect itself takes long enough for
      // onConnectionStateChange('connecting') to outlast useSseStatus grace.
      scheduleResubscribe(0);
    },
    onData(event) {
      // Adopt the stream epoch from any stamped event — live events always
      // carry the CURRENT epoch, so a ring-routed break teaches the new one.
      const epoch = epochOf(event);
      if (epoch !== undefined) lastEpoch = epoch;

      if (event.type === 'reconnect') {
        if (!event.preserved) {
          // Continuity lost = reset (twp-spec §5.3): the server's seq space may
          // be new (process restart) or the epoch re-minted (external break).
          // A ring-routed break arrives stamped — adopt its seq as the new
          // watermark ("current as of the break, refetching now") so the next
          // resume can be covered; an unstamped verdict rebuilds from 0 (the
          // stale-epoch cursor is refused server-side either way).
          lastSeq = seqOf(event) ?? 0;
          // Overlays only mean something within a continuous stream: an ack may
          // have been in the dropped gap, and an unacked op never drains —
          // consumeAck matches by id (core-jvfv). In-flight writes either landed
          // (the refetch below shows them) or failed (rollback fired); a survivor
          // would replay stale confirmed over fresh data on the next event.
          clearRebase();
          cache.signalReconnect();
          if (loadChildren) {
            for (const path of getExpanded?.() ?? []) loadChildren(path);
          }
          const sel = getSelected?.();
          if (sel) {
            // Re-registration after a continuity break must carry the tab token
            // too — a tokenless re-watch would land on the shared LEGACY hold.
            trpc.get.query({ path: sel, watch: true, ...tabTokenInput }).then(n => {
              if (n) cache.put(n);
            });
          }
        }
        return;
      }

      // Pathless coarse invalidate (core-dm1): the mutated node is unreadable to
      // us now (ACL revocation) so no set/patch arrives, but named query views
      // still shifted — refetch each through the normal ACL-filtered read path.
      // `paths` (ns6p.4 §3.4) names exact registrations we hold whose payload
      // was dropped — refetch the node itself; FORBIDDEN/gone evicts.
      if (event.type === 'invalidate') {
        if (typeof event.seq === 'number' && event.seq > lastSeq) lastSeq = event.seq;
        if (loadChildren) for (const vp of event.vps) refetchDirtyVp(vp, loadChildren);
        for (const p of event.paths ?? []) refetchInvalidatedPath(p, fetchInvalidatedNode);
        return;
      }

      // Advance the resume watermark. Data events (set/patch/remove) carry seq;
      // reconnect (returned above) does not.
      if (typeof event.seq === 'number' && event.seq > lastSeq) lastSeq = event.seq;

      if (event.type === 'set') {
        const node = { $path: event.path, ...event.node } as NodeData;
        if (!applyServerSet(event.path, node, event.by)) cache.put(node);
        // invalidateVps — the coarse dirty signal (gk8.12): each named query
        // view may have shifted; refetch its listing through the normal
        // ACL-filtered read path. Precise add/rm deltas no longer exist.
        if (event.invalidateVps && loadChildren) {
          for (const vp of event.invalidateVps as string[]) refetchDirtyVp(vp, loadChildren);
        }
      } else if (event.type === 'patch') {
        // tRPC infers the wire type with `unknown[]` for tuples that contain
        // `unknown` values — server emits real PatchOp tuples, narrow here.
        const patches = event.patches as PatchOp[] | undefined;
        const rev = (event as { rev?: unknown }).rev;
        if (patches && applyServerPatch(event.path, patches, typeof rev === 'number' ? rev : undefined, event.by)) {
          // rebase handled it
        } else {
          const existing = cache.get(event.path);
          if (existing && patches) {
            try {
              const patched = structuredClone(existing);
              applyOps(patched, patches);
              // Non-rebase fallback: server's new $rev must land in cache too,
              // otherwise next optimistic write sends pre-patch $rev → OCC storm.
              if (typeof rev === 'number' && Number.isFinite(rev)) patched.$rev = rev;
              cache.put(patched);
            } catch (e) {
              console.error('Failed to apply patches, fetching full node:', e);
              trpc.get.query({ path: event.path }).then((n) => {
                if (n) cache.put(n);
              });
            }
          } else {
            trpc.get.query({ path: event.path }).then((n) => {
              if (n) cache.put(n);
            });
          }
        }
        if (event.invalidateVps && loadChildren) {
          for (const vp of event.invalidateVps as string[]) refetchDirtyVp(vp, loadChildren);
        }
      } else if (event.type === 'remove') {
        cache.remove(event.path);
        if (event.invalidateVps && loadChildren) {
          for (const vp of event.invalidateVps as string[]) refetchDirtyVp(vp, loadChildren);
        }
      }
    },
  });

  unsub = () => sub.unsubscribe();
}

// Back off briefly after a non-retryable error so an unreachable server can't
// turn into a tight reconnect loop. Clean closes (onStopped) pass 0 — instant.
const RESUBSCRIBE_BACKOFF_MS = 1_000;

function scheduleResubscribe(delayMs: number) {
  if (reconnectTimer || !lastConfig) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    // If token disappeared (logout), don't loop — wait until token returns.
    if (!getToken()) {
      if (lastConfig) waitForToken(() => { if (lastConfig) startEvents(lastConfig); });
      return;
    }
    if (lastConfig) startEvents(lastConfig, true);
  }, delayMs);
}

export function stopEvents() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  for (const t of dirtyTimers.values()) clearTimeout(t);
  dirtyTimers.clear();
  for (const t of invalidatedTimers.values()) clearTimeout(t);
  invalidatedTimers.clear();
  if (unsub) { unsub(); unsub = null; }
  if (tokenWaitTimer) { clearInterval(tokenWaitTimer); tokenWaitTimer = null; }
  if (tokenWaitListener && typeof window !== 'undefined') {
    window.removeEventListener('storage', tokenWaitListener);
    tokenWaitListener = null;
  }
}
