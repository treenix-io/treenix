// useSave: onChange partial → optimistic cache.put → throttled/manual tree.patch()
// Phase 2-3 of mutation pipeline.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { mergeIntoNode, mergeToOps, type OnChange, scopeOnChange } from '#tree/on-change';
import type { NodeData } from '@treenx/core';
import * as cache from '#tree/cache';
import { trpc } from './trpc';

export { type OnChange, mergeToOps, mergeIntoNode, scopeOnChange } from '#tree/on-change';
export type { MutationOp } from '#tree/on-change';

// ── useSave hook ──

const DEFAULT_DELAY = 2000;

export type SaveOptions = {
  /** Auto-flush on change after delay (default: false) */
  autoSave?: boolean;
  /** Throttle delay in ms when autoSave is on (default 500) */
  delay?: number;
};

export type SaveHandle = {
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

  const pending = useRef<Record<string, unknown> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inflight = useRef(false);
  const pathRef = useRef(path);
  pathRef.current = path;

  const [dirty, setDirty] = useState(false);
  const editRevRef = useRef<unknown>(null);
  const baseRef = useRef<NodeData | null>(null);

  // Reset on path change
  const prevPathRef = useRef(path);
  if (path !== prevPathRef.current) {
    prevPathRef.current = path;
    pending.current = null;
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    inflight.current = false;
    editRevRef.current = null;
    baseRef.current = null;
    if (dirty) setDirty(false);
  }

  const flush = useCallback(async () => {
    if (!pending.current || inflight.current) return;

    const ops = mergeToOps(pending.current);
    pending.current = null;
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }

    if (ops.length === 0) {
      setDirty(false);
      editRevRef.current = null;
      baseRef.current = null;
      return;
    }

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
        setDirty(false);
        editRevRef.current = null;
        baseRef.current = null;
      }
    }
  }, [delay, autoSave]);

  const onChange = useCallback((partial: OnChange) => {
    if (!partial || typeof partial !== 'object') return;

    // Optimistic cache update — instant UI feedback
    const node = cache.get(pathRef.current);
    if (node) cache.put(mergeIntoNode(node, partial as Record<string, unknown>));

    // Track dirty state — capture snapshot + $rev on first edit
    if (!pending.current) {
      baseRef.current = node ? structuredClone(node) : null;
      editRevRef.current = node?.$rev ?? null;
      setDirty(true);
    }

    // Accumulate ops for flush
    pending.current = pending.current
      ? { ...pending.current, ...(partial as Record<string, unknown>) }
      : { ...(partial as Record<string, unknown>) };

    // Auto-save: start throttle timer
    if (autoSave && !timer.current) {
      timer.current = setTimeout(flush, delay);
    }
  }, [flush, delay, autoSave]);

  const scope = useCallback((key: string) => scopeOnChange(onChange, key), [onChange]);

  const reset = useCallback(() => {
    pending.current = null;
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    if (baseRef.current) cache.put(baseRef.current);
    baseRef.current = null;
    editRevRef.current = null;
    setDirty(false);
  }, []);

  // Flush on unmount
  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
      if (pending.current) {
        const ops = mergeToOps(pending.current);
        if (ops.length > 0) {
          trpc.patch.mutate({ path: pathRef.current, ops }).catch(() => {});
        }
      }
    };
  }, []);

  // Stale: $rev changed externally while we have pending edits
  const currentRev = cache.get(path)?.$rev;
  const stale = dirty && editRevRef.current != null && currentRev !== editRevRef.current;

  return useMemo(
    () => ({ onChange, scope, flush, reset, dirty, stale }),
    [onChange, scope, flush, reset, dirty, stale],
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

export function usePathSave(options?: { delay?: number }): PathSaveHandle {
  const delay = options?.delay ?? DEFAULT_DELAY;

  const pending = useRef(new Map<string, Record<string, unknown>>());
  const handleCache = useRef(new Map<string, PathHandle>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(async () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }

    const entries = [...pending.current.entries()];
    pending.current.clear();

    if (entries.length === 0) return;

    await Promise.allSettled(
      entries.map(([path, partial]) => {
        const ops = mergeToOps(partial);
        return ops.length > 0
          ? trpc.patch.mutate({ path, ops })
          : Promise.resolve();
      }),
    );
  }, []);

  const change = useCallback((path: string, partial: OnChange) => {
    if (!partial || typeof partial !== 'object') return;

    // Optimistic cache update
    const node = cache.get(path);
    if (node) cache.put(mergeIntoNode(node, partial as Record<string, unknown>));

    // Accumulate per-path
    const prev = pending.current.get(path);
    pending.current.set(path, prev
      ? { ...prev, ...(partial as Record<string, unknown>) }
      : { ...(partial as Record<string, unknown>) },
    );

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
  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
      for (const [path, partial] of pending.current.entries()) {
        const ops = mergeToOps(partial);
        if (ops.length > 0) trpc.patch.mutate({ path, ops }).catch(() => {});
      }
      pending.current.clear();
      handleCache.current.clear();
    };
  }, []);

  return useMemo(
    () => ({ change, path: getHandle, flush }),
    [change, getHandle, flush],
  );
}
