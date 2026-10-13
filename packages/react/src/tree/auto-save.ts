// Editor drafts stay local until the selected source commits their partial changes.

import { useCallback, useEffect, useMemo, useReducer, useRef, useSyncExternalStore } from 'react';
import { foldPartial, mergeIntoNode, mergeToOps, type OnChange, scopeOnChange } from '#tree/on-change';
import type { NodeData } from '@treenx/core';
import { KernelError } from '@treenx/core/errors';
import { READ_ONLY_EFFECTS, useTreeEffects, type TreeEffects } from '#tree/effects';
import { useTreeSource } from '#tree/tree-source-context';
import type { PresentationNode } from '#tree/presentation';

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

export type SaveHandle<T = NodeData> = {
  /** Merged draft: cached node + local pending diff. Pass into <Render>. */
  value: T | undefined;
  /** Partial update for the node's fields */
  onChange: (partial: OnChange) => void;
  /** Scoped onChange for a named component — prefixes all keys with `key.` */
  scope: (key: string) => (partial: OnChange) => void;
  /** Flush pending changes to server now. Rejects on server failure — pending
   *  edits are restored (dirty stays true), callers must not report success. */
  flush: () => Promise<void>;
  /** Await any in-flight patch to settle (resolve OR reject) WITHOUT sending
   *  parked pending. Used before a full-node set() so an already-dispatched
   *  auto-save patch can't land after — and overwrite — the set (core-anz4.17). */
  settle: () => Promise<void>;
  /** Discard pending changes, restore cache to pre-edit state */
  reset: () => void;
  /** Drop pending edits WITHOUT touching the cache — for when another channel
   *  already persisted them (e.g. a full-node set() carrying the merged draft).
   *  reset() here would roll the cache back over the freshly-saved state. */
  discard: () => void;
  /** Has unsaved changes (pending or inflight) */
  dirty: boolean;
  /** Node changed externally while dirty — $rev mismatch */
  stale: boolean;
};

interface SaveOwner<T extends PresentationNode> {
  readonly effects: TreeEffects;
  readonly read: (path: string) => T | undefined;
  readonly subscribe: (path: string, changed: () => void) => () => void;
  readonly mount?: (path: string) => { dispose(): void };
}

/** Owns local editor drafts through the selected source and its mutation capability. */
export function useSave(path: string, options?: SaveOptions): SaveHandle<PresentationNode> {
  const source = useTreeSource();
  const owner = useMemo<SaveOwner<PresentationNode>>(() => ({
    effects: source.effects ?? READ_ONLY_EFFECTS,
    read: selected => source.getPathSnapshot(selected).data,
    subscribe: (selected, changed) => source.subscribePath(selected, changed),
    mount: selected => source.mountPath(selected),
  }), [source]);
  return useOwnedSave(path, options, owner);
}

/** Shares draft buffering while each caller supplies its actual read and mutation owner. */
function useOwnedSave<T extends PresentationNode>(path: string, options: SaveOptions | undefined, owner: SaveOwner<T>): SaveHandle<T> {
  const effects = owner.effects;
  const readNode = owner.read;
  const autoSave = options?.autoSave ?? false;
  const delay = options?.delay ?? DEFAULT_DELAY;

  // The selected source publishes the committed node independently of the local draft.
  const node = useSyncExternalStore(
    useCallback((cb) => owner.subscribe(path, cb), [path, owner]),
    useCallback(() => readNode(path), [path, readNode]),
    useCallback(() => readNode(path), [path, readNode]),
  );
  useEffect(() => {
    const handle = owner.mount?.(path);
    return () => handle?.dispose();
  }, [path, owner]);

  const pending = useRef<Record<string, unknown> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inflight = useRef(false);
  const submitted = useRef<Record<string, unknown> | null>(null);
  // In-progress flush promise — a second flush() chains on it instead of
  // resolving early (verify-index 27).
  const inflightRef = useRef<Promise<void> | null>(null);
  const pathRef = useRef(path);
  pathRef.current = path;
  // Bumped on every tracked-path change. A run captures it at start; a run whose
  // generation no longer matches is stale and must touch none of the new path's
  // state on completion (core-anz4.17 r2).
  const genRef = useRef(0);

  const [version, bump] = useReducer((v: number) => v + 1, 0);
  const editRevRef = useRef<unknown>(null);

  const clearTimer = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  const clearEdit = useCallback(() => {
    editRevRef.current = null;
  }, []);

  // Reset on path change
  const prevPathRef = useRef(path);
  const prevEffectsRef = useRef(effects);
  const prevOwnerRef = useRef(owner);
  const mountedOwner = useRef(true);
  useEffect(() => {
    mountedOwner.current = true;
    return () => { if (owner === prevOwnerRef.current) mountedOwner.current = false; };
  }, [owner]);
  if (path !== prevPathRef.current || owner !== prevOwnerRef.current) {
    prevPathRef.current = path;
    prevEffectsRef.current = effects;
    prevOwnerRef.current = owner;
    genRef.current++;
    pending.current = null;
    clearTimer();
    inflight.current = false;
    submitted.current = null;
    inflightRef.current = null;
    clearEdit();
  }
  const ownerGeneration = genRef.current;
  /** Refuses callbacks retained by an editor whose selected owner or path has changed. */
  function assertOwner(): void {
    if (owner !== prevOwnerRef.current || path !== pathRef.current || !mountedOwner.current || ownerGeneration !== genRef.current)
      throw new KernelError('CANCELLED', 'Save owner changed');
  }

  const flush = useCallback(async (): Promise<void> => {
    assertOwner();
    // A flush called while another is inflight must await THAT request's real
    // outcome (rejecting if it rejects), then flush whatever accumulated —
    // resolving early made callers toast 'Saved' for an unfinished commit
    // (verify-index 27).
    if (inflightRef.current) {
      const callGen = genRef.current;
      await inflightRef.current;
      // Path changed while we waited on the prior run — this caller belongs to
      // the OLD path; firing flush() now would send the NEW path's pending under
      // a stale caller (core-anz4.17).
      if (genRef.current !== callGen) return;
      if (pending.current) return flush();
      return;
    }

    const partial = pending.current;
    if (!partial) return;
    pending.current = null;
    clearTimer();

    const ops = mergeToOps(partial);
    if (ops.length === 0) {
      clearEdit();
      bump();
      return;
    }

    inflight.current = true;
    submitted.current = partial;
    const gen = genRef.current;
    const run = (async () => {
      try {
        await effects.patchNode(pathRef.current, partial);
      } catch (e) {
        // Failed write: restore pending so the edits are NOT lost (dirty stays
        // true) and rethrow — a swallowed reject made 'flush then toast' callers
        // report 'Saved' for a commit that never landed (cnr.5 C21). No auto-
        // retry: the next onChange or explicit flush re-attempts.
        // Skip when stale: the path changed under us, so this partial belongs to
        // the OLD path and must not resurrect into the new path's pending (r2).
        console.error('[useSave] patch failed:', e);
        if (genRef.current === gen) pending.current = foldPartial(partial, pending.current ?? {});
        throw e;
      } finally {
        // A new run owns inflight after a path change — only the current run clears it.
        if (genRef.current === gen) {
          inflight.current = false;
          submitted.current = null;
        }
      }
      // Stale run: the new path owns pending/timer/edit tracking now — touch none.
      if (genRef.current !== gen) return;
      if (pending.current) {
        // Edits accumulated during the round-trip — schedule the next flush.
        if (autoSave) timer.current = setTimeout(() => { flush().catch(() => {}); }, delay);
      } else {
        clearEdit();
      }
    })();
    inflightRef.current = run;
    try {
      await run;
    } finally {
      // Only clear if we still own the slot — a path change (or a later flush)
      // may have replaced it. A stale settle nulling a successor's promise let
      // settle()/flush() lose the real in-flight request (core-anz4.17).
      if (inflightRef.current === run) inflightRef.current = null;
      // version feeds the debounce dependency — a stale run must not bump it, or
      // it resets the new path's timer (core-anz4.17).
      if (genRef.current === gen) bump();
    }
  }, [autoSave, clearEdit, clearTimer, delay, effects, path, owner, ownerGeneration]);

  const settle = useCallback(async (): Promise<void> => {
    assertOwner();
    const running = inflightRef.current;
    // allSettled: wait for the real outcome without re-throwing here — the
    // flush() that owns this promise already surfaces/logs any rejection.
    if (running) await Promise.allSettled([running]);
  }, [owner, path, ownerGeneration]);

  const onChange = useCallback((partial: OnChange) => {
    assertOwner();
    // Folded first: an invalid partial throws INVALID to the caller before any edit state changes.
    const next = foldPartial(pending.current ?? {}, partial);

    // Track dirty state — capture snapshot + $rev on first edit for reset/stale detection
    if (!pending.current) {
      const cached = readNode(pathRef.current);
      editRevRef.current = cached?.$rev ?? null;
    }

    pending.current = next;
    bump();

    // Auto-save: start throttle timer. flush rethrows on failure (already
    // logged inside) — catch here so a background flush can't become an
    // unhandled rejection; pending stays restored for the next attempt.
    if (autoSave && !timer.current) {
      timer.current = setTimeout(() => { flush().catch(() => {}); }, delay);
    }
    // delay/autoSave captured transitively via flush — listing them here is redundant
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flush, readNode]);

  const scope = useCallback((key: string) => scopeOnChange(onChange, key), [onChange]);

  const reset = useCallback(() => {
    assertOwner();
    pending.current = null;
    clearTimer();
    clearEdit();
    bump();
  }, [clearEdit, clearTimer, effects, path, owner, ownerGeneration]);

  const discard = useCallback(() => {
    assertOwner();
    pending.current = null;
    clearTimer();
    clearEdit();
    bump();
  }, [clearEdit, clearTimer, effects, path, owner, ownerGeneration]);

  // Flush on unmount
  useEffect(() => () => {
    if (owner !== prevOwnerRef.current) return;
    if (timer.current) clearTimeout(timer.current);
    const partial = pending.current;
    if (!partial) return;
    const ops = mergeToOps(partial);
    if (ops.length > 0) {
      effects.patchNode(pathRef.current, partial)
        .catch(e => console.error('[useSave] unmount flush failed:', e));
    }
  }, [effects, owner]);

  // Derived dirty — pending + inflight are the real sources of truth (bumps re-render)
  const dirty = !!pending.current || inflight.current;

  // Stale: $rev changed while we hold pending edits. Counting rev bumps cannot
  // tell an own SSE echo from a foreign write, and opId/`by` is consumed by the
  // rebase layer before it reaches here — so an own committed write shows stale
  // briefly until its echo lands (accepted cosmetic, core-anz4.17).
  const currentRev = node?.$rev;
  const stale = dirty && editRevRef.current != null && currentRev !== editRevRef.current;

  // Keep submitted edits visible until their owning request settles or the selected path changes.
  const value = useMemo(
    () => {
      const partial = submitted.current === null ? pending.current
        : pending.current === null ? submitted.current : foldPartial(submitted.current, pending.current);
      return partial !== null && node !== undefined ? mergeIntoNode(node, partial) : node;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [node, version],
  );

  return useMemo(
    () => ({ value, onChange, scope, flush, settle, reset, discard, dirty, stale }),
    [value, onChange, scope, flush, settle, reset, discard, dirty, stale],
  );
}

/** useSave with autoSave enabled — throttled flush on every onChange */
export function useAutoSave(path: string, options?: Omit<SaveOptions, 'autoSave'>): SaveHandle<PresentationNode> {
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
  /** Flush all pending changes to server. Rejects when a patch fails — with its error, or an AggregateError
   *  when several do; the failed paths' edits stay pending. */
  flush: () => Promise<void>;
};

export function usePathSave(options?: { delay?: number }): PathSaveHandle {
  const effects = useTreeEffects();
  const ownerRef = useRef(effects);
  const generation = useRef(0);
  const delay = options?.delay ?? DEFAULT_DELAY;

  const pending = useRef(new Map<string, Record<string, unknown>>());
  const inflight = useRef<Promise<void> | null>(null);
  const handleCache = useRef(new Map<string, PathHandle>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  if (ownerRef.current !== effects) {
    ownerRef.current = effects;
    generation.current++;
    pending.current.clear(); handleCache.current.clear(); clearTimer();
    inflight.current = null;
  }
  const ownerGeneration = generation.current;

  const flush = useCallback(async () => {
    if (ownerRef.current !== effects || generation.current !== ownerGeneration) throw new KernelError('CANCELLED', 'Save owner was replaced');
    if (inflight.current) {
      await inflight.current;
      if (pending.current.size > 0) return flush();
      return;
    }
    clearTimer();
    const epoch = generation.current;
    const entries = [...pending.current];
    pending.current.clear();
    if (entries.length === 0) return;

    const run = (async () => {
      const settled = await Promise.allSettled(entries.map(([path, partial]) => {
        const ops = mergeToOps(partial);
        return ops.length === 0 ? Promise.resolve() : effects.patchNode(path, partial);
      }));

      // A failed path keeps its edits pending under the ones made since, so the next change or flush resends them.
      const failures: unknown[] = [];
      settled.forEach((r, i) => {
        if (r.status === 'fulfilled') return;
        const [path, partial] = entries[i];
        if (generation.current === epoch) pending.current.set(path, foldPartial(partial, pending.current.get(path) ?? {}));
        failures.push(r.reason);
      });

      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, 'usePathSave: patches failed');
    })();
    inflight.current = run;
    try {
      await run;
    } finally {
      if (inflight.current === run) inflight.current = null;
    }
  }, [clearTimer, effects, ownerGeneration]);

  const change = useCallback((path: string, partial: OnChange) => {
    if (ownerRef.current !== effects || generation.current !== ownerGeneration) throw new KernelError('CANCELLED', 'Save owner was replaced');
    pending.current.set(path, foldPartial(pending.current.get(path) ?? {}, partial));

    // Shared timer for all paths (delay=0 → no auto-flush). A timed flush has no caller to reject to;
    // its failed edits are pending again.
    if (delay > 0 && !timer.current) {
      timer.current = setTimeout(() => {
        flush().catch((e: unknown) => console.error('[usePathSave] save failed; edits stay pending:', e));
      }, delay);
    }
  }, [flush, delay, effects, ownerGeneration]);

  // Ref so cached handles always call latest change (no stale closures)
  const changeRef = useRef(change);
  changeRef.current = change;

  const getHandle = useCallback((childPath: string): PathHandle => {
    if (ownerRef.current !== effects || generation.current !== ownerGeneration) throw new KernelError('CANCELLED', 'Save owner was replaced');
    const cached = handleCache.current.get(childPath);
    if (cached) return cached;

    const ownedChange = (partial: OnChange) => {
      if (ownerRef.current !== effects || generation.current !== ownerGeneration) throw new KernelError('CANCELLED', 'Save owner was replaced');
      changeRef.current(childPath, partial);
    };
    const handle: PathHandle = {
      onChange: ownedChange,
      scope: (key) => scopeOnChange(ownedChange, key),
    };
    handleCache.current.set(childPath, handle);
    return handle;
  }, [effects, ownerGeneration]);

  // Flush on unmount
  useEffect(() => () => {
    if (ownerRef.current !== effects || generation.current !== ownerGeneration) return;
    if (timer.current) clearTimeout(timer.current);
    for (const [path, partial] of pending.current) {
      const ops = mergeToOps(partial);
      if (ops.length > 0) {
        const saving = effects.patchNode(path, partial);
        saving
          .catch(e => console.error(`[usePathSave] unmount flush failed for ${path}:`, e));
      }
    }
    pending.current.clear();
    handleCache.current.clear();
  }, [effects, ownerGeneration]);

  return useMemo(
    () => ({ change, path: getHandle, flush }),
    [change, getHandle, flush],
  );
}
