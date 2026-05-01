// Server event subscription — module-level, not tied to any React component.
// Listens to trpc.events SSE and updates the cache.

import type { NodeData } from '@treenx/core';
import { applyPatch, type Operation } from 'fast-json-patch';
import * as cache from './cache';
import { applyServerPatch, applyServerSet } from './rebase';
import { trpc } from './trpc';

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

export function startEvents(config: EventsConfig) {
  stopEvents();
  lastConfig = config;

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
              if (n) cache.put(n as NodeData);
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
                if (n) cache.put(n as NodeData);
              });
            }
          } else {
            trpc.get.query({ path: event.path }).then((n) => {
              if (n) cache.put(n as NodeData);
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
    if (lastConfig) startEvents(lastConfig);
  }, delayMs);
}

export function stopEvents() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (unsub) { unsub(); unsub = null; }
}
