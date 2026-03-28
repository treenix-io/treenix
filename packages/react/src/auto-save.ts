// Auto-save: onChange partial → throttled tree.patch()
// Phase 2 of mutation pipeline.

import { useCallback, useEffect, useRef } from 'react';
import { mergeToOps, type OnChange } from '#on-change';
import { trpc } from './trpc';

export { type OnChange, mergeToOps, mergeIntoNode, scopeOnChange } from '#on-change';
export type { MutationOp } from '#on-change';

// ── useAutoSave hook ──

const FLUSH_DELAY = 500;

export function useAutoSave<T extends Record<string, unknown>>(path: string) {
  const pending = useRef<Record<string, unknown> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inflight = useRef(false);
  const pathRef = useRef(path);
  pathRef.current = path;

  const flush = useCallback(async () => {
    if (!pending.current || inflight.current) return;

    const ops = mergeToOps(pending.current);
    pending.current = null;
    timer.current = null;

    if (ops.length === 0) return;

    inflight.current = true;
    try {
      await trpc.patch.mutate({ path: pathRef.current, ops });
    } catch (e) {
      console.error('[auto-save] patch failed:', e);
    } finally {
      inflight.current = false;
      if (pending.current) {
        timer.current = setTimeout(flush, FLUSH_DELAY);
      }
    }
  }, []);

  const onChange = useCallback((partial: OnChange<T>) => {
    if (!partial || typeof partial !== 'object') return;

    pending.current = pending.current
      ? { ...pending.current, ...(partial as Record<string, unknown>) }
      : { ...(partial as Record<string, unknown>) };

    if (!timer.current) {
      timer.current = setTimeout(flush, FLUSH_DELAY);
    }
  }, [flush]);

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

  return onChange;
}
