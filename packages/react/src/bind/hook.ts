// React hooks for computed bindings

import * as cache from '#tree/cache';
import { set, usePath } from '#hooks';
import { isRef, type NodeData } from '@treenity/core';
import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { useSnapshot } from 'valtio';
import { proxy } from 'valtio/vanilla';
import { getComputed, getComputedProxy, subscribeComputed } from './computed';
import { evaluateRef, extractArgPaths, isCollectionRef } from './eval';

const EMPTY_PROXY = proxy<Record<string, unknown>>({});

/** Reactive access to computed binding values for a node */
export function useComputed(path: string): Record<string, unknown> {
  // Structural: detect proxy creation (first computed value for this path)
  useSyncExternalStore(
    useCallback((cb: () => void) => subscribeComputed(path, cb), [path]),
    useCallback(() => getComputed(path), [path]),
  );

  // Field-level: re-render only when accessed computed fields change
  const p = getComputedProxy(path);
  return useSnapshot(p ?? EMPTY_PROXY) as Record<string, unknown>;
}

/** Node with computed bindings merged — raw + computed overlay */
export function useResolvedNode(path: string): [NodeData | undefined, (next: NodeData) => Promise<void>] {
  const { data: node } = usePath(path);
  const computed = useComputed(path);

  if (!node) return [undefined, set];

  // Check if node has any $ref+$map bindings that need resolving
  const hasComputed = Object.keys(computed).length > 0;
  const hasBindings = Object.values(node).some(v => isRef(v) && (v as any).$map);
  if (!hasComputed && !hasBindings) return [node, set];

  const merged = { ...node } as Record<string, unknown>;

  // Apply computed values
  for (const [key, value] of Object.entries(computed)) {
    // Support dotted keys for sub-component fields (e.g. "mesh.width")
    if (key.includes('.')) {
      const [comp, field] = key.split('.');
      if (merged[comp] && typeof merged[comp] === 'object') {
        merged[comp] = { ...(merged[comp] as object), [field]: value };
      }
    } else {
      merged[key] = value;
    }
  }

  // Strip unresolved $ref+$map bindings — computed not ready yet, use 0 default
  // Without this, raw ref objects leak to consumers (e.g. Three.js rotation={[0, {$ref:...}, 0]} → NaN)
  for (const key of Object.keys(merged)) {
    if (key.startsWith('$')) continue;
    const v = merged[key];
    if (isRef(v) && (v as any).$map) {
      merged[key] = 0;
    }
    // Sub-component fields
    if (v && typeof v === 'object' && !isRef(v) && '$type' in (v as any)) {
      let changed = false;
      const comp = { ...(v as Record<string, unknown>) };
      for (const sk of Object.keys(comp)) {
        if (sk.startsWith('$')) continue;
        if (isRef(comp[sk]) && (comp[sk] as any).$map) {
          comp[sk] = 0;
          changed = true;
        }
      }
      if (changed) merged[key] = comp;
    }
  }

  return [merged as NodeData, set];
}

const evalCtx = {
  getNode: (p: string) => cache.get(p),
  getChildren: (p: string) => cache.getChildren(p),
};

/** Evaluate a $ref+$map expression reactively — no node needed */
export function useEvalRef(path: string, map: string): unknown {
  const ref = useMemo(() => ({ $ref: path, $map: map }), [path, map]);

  // Subscribe to all relevant paths: main source + @/path args
  const subscribe = useCallback((cb: () => void) => {
    const unsubs: (() => void)[] = [];

    unsubs.push(
      isCollectionRef(ref)
        ? cache.subscribeChildren(path, cb)
        : cache.subscribePath(path, cb),
    );

    for (const argPath of extractArgPaths(ref)) {
      unsubs.push(cache.subscribePath(argPath, cb));
    }

    return () => unsubs.forEach(u => u());
  }, [ref, path]);

  const getSnapshot = useCallback(() => {
    try { return evaluateRef(ref, evalCtx); }
    catch { return undefined; }
  }, [ref]);

  return useSyncExternalStore(subscribe, getSnapshot);
}
