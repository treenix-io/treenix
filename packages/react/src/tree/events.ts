// Server event subscription — module-level, not tied to any React component.
// Listens to trpc.events SSE and updates the cache.

import type { NodeData } from '@treenx/core';
import { applyPatch, type Operation } from 'fast-json-patch';
import * as cache from './cache';
import { applyServerPatch, applyServerSet } from './rebase';
import { AUTH_EXPIRED_EVENT, clearToken, getToken, trpc } from './trpc';

type LoadChildren = (path: string) => Promise<void>;

interface EventsConfig {
  loadChildren: LoadChildren;
  getExpanded: () => Set<string>;
  getSelected: () => string | null;
}

// ── SSE connection events (consumed by App.tsx) ──

export const SSE_CONNECTED = 'sse-connected';
export const SSE_DISCONNECTED = 'sse-disconnected';

let unsub: (() => void) | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let lastConfig: EventsConfig | null = null;

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

export function startEvents(config: EventsConfig) {
  stopEvents();
  lastConfig = config;

  // Defer editor SSE until a session token exists. Once a token lands (login),
  // the caller's auth-state effect or the storage listener below wakes it.
  if (!getToken()) {
    waitForToken(() => { if (lastConfig) startEvents(lastConfig); });
    return;
  }

  const { loadChildren, getExpanded, getSelected } = config;

  const sub = trpc.events.subscribe(undefined as void, {
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
      if (event.type === 'reconnect') {
        if (!event.preserved) {
          cache.signalReconnect();
          for (const path of getExpanded()) loadChildren(path);
          const sel = getSelected();
          if (sel) {
            trpc.get.query({ path: sel, watch: true }).then(n => {
              if (n) cache.put(n);
            });
          }
        }
        return;
      }

      if (event.type === 'set') {
        const node = { $path: event.path, ...event.node } as NodeData;
        // Order: rmVps → put → addVps. Unlinking first prevents cache.put's
        // reverse-index fan-out from firing a vp about to be removed.
        if (event.rmVps) event.rmVps.forEach((vp: string) => cache.removeFromParent(event.path, vp));
        if (!applyServerSet(event.path, node)) cache.put(node);
        if (event.addVps) event.addVps.forEach((vp: string) => cache.addToParent(event.path, vp));
      } else if (event.type === 'patch') {
        // Same rm→put→add ordering as 'set' above.
        if (event.rmVps) event.rmVps.forEach((vp: string) => cache.removeFromParent(event.path, vp));
        if (event.patches && applyServerPatch(event.path, event.patches as Operation[])) {
          // rebase handled it
        } else {
          const existing = cache.get(event.path);
          if (existing && event.patches) {
            try {
              const patched = structuredClone(existing);
              applyPatch(patched, event.patches as Operation[]);
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
        if (event.addVps) event.addVps.forEach((vp: string) => cache.addToParent(event.path, vp));
      } else if (event.type === 'remove') {
        cache.remove(event.path);
        // Also clean up virtual parents (CDC queries)
        if (event.rmVps) event.rmVps.forEach((vp: string) => cache.removeFromParent(event.path, vp));
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
    if (lastConfig) startEvents(lastConfig);
  }, delayMs);
}

export function stopEvents() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (unsub) { unsub(); unsub = null; }
  if (tokenWaitTimer) { clearInterval(tokenWaitTimer); tokenWaitTimer = null; }
  if (tokenWaitListener && typeof window !== 'undefined') {
    window.removeEventListener('storage', tokenWaitListener);
    tokenWaitListener = null;
  }
}
