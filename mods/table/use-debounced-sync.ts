import { AnyType, getComponent, type NodeData } from '@treenx/core';
import { set } from '@treenx/react';

import { useCallback, useEffect, useRef, useState } from 'react';

const getField = (node: NodeData, key: string) => getComponent(node, AnyType, key) as Record<string, unknown> | undefined;


/**
 * Local state mirror with debounced persistence to tree.
 * Updates local state immediately for responsive UI,
 * then persists via set() after `delay` ms of inactivity.
 */
export function useDebouncedSync<T extends object>(
  node: NodeData,
  componentKey: string,
  defaults?: T,
  delay = 500,
): [T, (patch: Partial<T>) => void] {
  const init = () => ({ ...defaults, ...getField(node, componentKey) }) as T;
  const [local, setLocal] = useState<T>(init);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef(false);
  const latestLocal = useRef(local);
  latestLocal.current = local;

  // Sync from external updates when no local pending changes
  const nodeRef = useRef(node);
  useEffect(() => {
    if (nodeRef.current === node) return;
    nodeRef.current = node;
    if (!pendingRef.current) {
      setLocal(({ ...defaults, ...getField(node, componentKey) }) as T);
    }
  }, [node, componentKey]);

  const flush = useCallback(() => {
    const comp = getField(nodeRef.current, componentKey) ?? {};
    const updated = { ...nodeRef.current, [componentKey]: { ...comp, ...latestLocal.current } };
    set(updated as NodeData);
    pendingRef.current = false;
  }, [componentKey]);

  const update = useCallback((patch: Partial<T>) => {
    setLocal(prev => {
      const next = { ...prev, ...patch };
      latestLocal.current = next;
      return next;
    });
    pendingRef.current = true;

    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(flush, delay);
  }, [flush, delay]);

  // Flush on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        if (pendingRef.current) flush();
      }
    };
  }, [flush]);

  return [local, update];
}
