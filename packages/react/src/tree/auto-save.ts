// useSave: onChange partial → pending state → throttled cache.put → flush patch
// Phase 2-3 of mutation pipeline.

import { useCallback, useEffect, useMemo, useReducer, useRef, useSyncExternalStore } from 'react';
import { mergeIntoNode, mergeToOps, type OnChange, scopeOnChange } from '#tree/on-change';
import type { NodeData } from '@treenx/core';
import * as cache from '#tree/cache';
import { useDebounce } from '#lib/use-debounce';
import { trpc } from './trpc';

export { type OnChange, mergeToOps, mergeIntoNode, scopeOnChange } from '#tree/on-change';
export type { MutationOp } from '#tree/on-change';

// ── useSave hook ──

const DEFAULT_DELAY = 2000;
const DEFAULT_CACHE_THROTTLE = 500;

export type SaveOptions = {
  /** Auto-flush on change after delay (default: false) */
  autoSave?: boolean;
  /** Throttle delay in ms when autoSave is on (default 500) */
  delay?: number;
  /** Throttle ms for cache.put fanout to other path subscribers. 0 = sync. Default 500. */
  cacheThrottle?: number;
};

export type SaveHandle<T = NodeData> = {
  /** Merged draft: cached node + local pending diff. Pass into <Render>. */
  value: T | undefined;
  /** Partial update for the node's fields */
  onChange: (partial: OnChange) => void;
  /** Scoped onChange for a named component — prefixes all keys with `key.` */
  scope: (key: string) => (partial: OnChange) => void;
  /** Flush pending changes to server now */
  flush: () => Promise<void>;
  /** Discard pending changes, restore cache to pre-edit state */
  reset: () => void;
  /** Has unsaved changes (pending or inflight) */
  dirty: boolean;
  /** Node changed externally while dirty — $rev mismatch */
  stale: boolean;
};

export function useSave(path: string, options?: SaveOptions): SaveHandle {
  const autoSave = options?.autoSave ?? false;
  const delay = options?.delay ?? DEFAULT_DELAY;
  const cacheThrottle = options?.cacheThrottle ?? DEFAULT_CACHE_THROTTLE;

  // Reactive read from cache — re-renders when path's cache entry changes
  const node = useSyncExternalStore(
    useCallback((cb) => cache.subscribePath(path, cb), [path]),
    useCallback(() => cache.get(path), [path]),
  );

  const pending = useRef<Record<string, unknown> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inflight = useRef(false);
  const pathRef = useRef(path);
  pathRef.current = path;

  const [version, bump] = useReducer((v: number) => v + 1, 0);
  const editRevRef = useRef<unknown>(null);
  const baseRef = useRef<NodeData | null>(null);

  const clearTimer = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  const clearEdit = useCallback(() => {
    editRevRef.current = null;
    baseRef.current = null;
  }, []);

  // Debounced cache fanout — other path subscribers update after a typing pause
  useDebounce(() => {
    if (!pending.current) return;
    const cached = cache.get(pathRef.current);
    if (cached) cache.put(mergeIntoNode(cached, pending.current));
  }, cacheThrottle, [version]);

  // Reset on path change
  const prevPathRef = useRef(path);
  if (path !== prevPathRef.current) {
    prevPathRef.current = path;
    pending.current = null;
    clearTimer();
    inflight.current = false;
    clearEdit();
  }

  const flush = useCallback(async () => {
    const partial = pending.current;
    if (!partial || inflight.current) return;
    pending.current = null;
    clearTimer();

    const ops = mergeToOps(partial);
    if (ops.length === 0) {
      clearEdit();
      bump();
      return;
    }

    // Final cache commit — single put before server send (also triggers re-render via subscription)
    const cached = cache.get(pathRef.current);
    if (cached) cache.put(mergeIntoNode(cached, partial));

    inflight.current = true;
    try {
      await trpc.patch.mutate({ path: pathRef.current, ops });
    } catch (e) {
      console.error('[useSave] patch failed:', e);
    } finally {
      inflight.current = false;
      if (pending.current) {
        if (autoSave) timer.current = setTimeout(flush, delay);
      } else {
        clearEdit();
        bump();
      }
    }
  }, [autoSave, clearEdit, clearTimer, delay]);

  const onChange = useCallback((partial: OnChange) => {
    // Track dirty state — capture snapshot + $rev on first edit for reset/stale detection
    if (!pending.current) {
      const cached = cache.get(pathRef.current);
      baseRef.current = cached ? structuredClone(cached) : null;
      editRevRef.current = cached?.$rev ?? null;
      pending.current = {};
    }

    // Accumulate ops for flush — in-place mutation, no per-keystroke allocation
    Object.assign(pending.current, partial as Record<string, unknown>);
    bump();

    // Auto-save: start throttle timer
    if (autoSave && !timer.current) {
      timer.current = setTimeout(flush, delay);
    }
    // delay/autoSave captured transitively via flush — listing them here is redundant
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flush]);

  const scope = useCallback((key: string) => scopeOnChange(onChange, key), [onChange]);

  const reset = useCallback(() => {
    pending.current = null;
    clearTimer();
    if (baseRef.current) cache.put(baseRef.current);
    clearEdit();
    bump();
  }, [clearEdit, clearTimer]);

  // Flush on unmount
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
    const partial = pending.current;
    if (!partial) return;
    const ops = mergeToOps(partial);
    if (ops.length > 0) trpc.patch.mutate({ path: pathRef.current, ops }).catch(() => {});
  }, []);

  // Derived dirty — pending + inflight are the real sources of truth (bumps re-render)
  const dirty = !!pending.current || inflight.current;

  // Stale: $rev changed externally while we have pending edits
  const currentRev = node?.$rev;
  const stale = dirty && editRevRef.current != null && currentRev !== editRevRef.current;

  // Merged draft: cached node + local pending diff
  const value = useMemo(
    () => pending.current && node ? mergeIntoNode(node, pending.current) : node,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [node, version],
  );

  return useMemo(
    () => ({ value, onChange, scope, flush, reset, dirty, stale }),
    [value, onChange, scope, flush, reset, dirty, stale],
  );
}

/** useSave with autoSave enabled — throttled flush on every onChange */
export function useAutoSave(path: string, options?: Omit<SaveOptions, 'autoSave'>): SaveHandle {
  return useSave(path, { ...options, autoSave: true });
}

// ── usePathSave: multi-path saving for child nodes ──

export type PathHandle = {
  onChange: (partial: OnChange) => void;
  scope: (key: string) => (partial: OnChange) => void;
};

export type PathSaveHandle = {
  /** Direct partial update for any path */
  change: (path: string, partial: OnChange) => void;
  /** Cached handle for a specific path — stable reference */
  path: (path: string) => PathHandle;
  /** Flush all pending changes to server */
  flush: () => Promise<void>;
};

export function usePathSave(options?: { delay?: number; cacheThrottle?: number }): PathSaveHandle {
  const delay = options?.delay ?? DEFAULT_DELAY;
  const cacheThrottle = options?.cacheThrottle ?? DEFAULT_CACHE_THROTTLE;

  const pending = useRef(new Map<string, Record<string, unknown>>());
  const handleCache = useRef(new Map<string, PathHandle>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [version, bump] = useReducer((v: number) => v + 1, 0);

  const clearTimer = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  // Debounced cache fanout — all dirty paths committed to cache after a pause
  useDebounce(() => {
    for (const [p, partial] of pending.current) {
      const cached = cache.get(p);
      if (cached) cache.put(mergeIntoNode(cached, partial));
    }
  }, cacheThrottle, [version]);

  const flush = useCallback(async () => {
    clearTimer();
    const entries = [...pending.current];
    pending.current.clear();
    if (entries.length === 0) return;

    // Final commit per path before server send
    for (const [p, partial] of entries) {
      const cached = cache.get(p);
      if (cached) cache.put(mergeIntoNode(cached, partial));
    }

    await Promise.allSettled(entries.map(([path, partial]) => {
      const ops = mergeToOps(partial);
      return ops.length > 0 ? trpc.patch.mutate({ path, ops }) : Promise.resolve();
    }));
  }, [clearTimer]);

  const change = useCallback((path: string, partial: OnChange) => {
    // Accumulate per-path — in-place mutation, no per-event allocation when path already pending
    const next = pending.current.get(path) ?? {};
    Object.assign(next, partial as Record<string, unknown>);
    pending.current.set(path, next);
    bump();

    // Shared timer for all paths (delay=0 → no auto-flush)
    if (delay > 0 && !timer.current) {
      timer.current = setTimeout(flush, delay);
    }
  }, [flush, delay]);

  // Ref so cached handles always call latest change (no stale closures)
  const changeRef = useRef(change);
  changeRef.current = change;

  const getHandle = useCallback((childPath: string): PathHandle => {
    const cached = handleCache.current.get(childPath);
    if (cached) return cached;

    const handle: PathHandle = {
      onChange: (partial) => changeRef.current(childPath, partial),
      scope: (key) => scopeOnChange((partial) => changeRef.current(childPath, partial), key),
    };
    handleCache.current.set(childPath, handle);
    return handle;
  }, []);

  // Flush on unmount
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
    for (const [path, partial] of pending.current) {
      const ops = mergeToOps(partial);
      if (ops.length > 0) trpc.patch.mutate({ path, ops }).catch(() => {});
    }
    pending.current.clear();
    handleCache.current.clear();
  }, []);

  return useMemo(
    () => ({ change, path: getHandle, flush }),
    [change, getHandle, flush],
  );
}
