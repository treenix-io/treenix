// Binding engine — scans cache for $ref+$map fields, subscribes to sources,
// evaluates on change, writes to computed store.
// Supports $ref: "." (self) and @/path.field ref args in $map expressions.

import * as cache from '#tree/cache';
import { trpc } from '#tree/trpc';
import { isRef, type NodeData, type Ref } from '@treenx/core';
import { clearComputed, getComputed, setComputed } from './computed';
import { evaluateRef, extractArgPaths, hasOnce, isCollectionRef } from './eval';

type Unsub = () => void;

// Active bindings: targetPath → field → { ref, unsub }
const active = new Map<string, Map<string, { ref: Ref; unsub: Unsub }>>();

// Collection paths with active SSE watches
const watchedCollections = new Set<string>();
// Single-node paths already fetched
const fetchedNodes = new Set<string>();

const ctx = {
  getNode: (p: string) => cache.get(p),
  getChildren: (p: string) => cache.getChildren(p),
};

/** Fetch collection children from server into cache */
function fetchChildren(path: string): void {
  trpc.getChildren
    .query({ path, watch: true, watchNew: true })
    .then((r: any) => cache.replaceChildren(path, r.items as NodeData[]));
}

/** Ensure source data is in cache by fetching from server */
function ensureInCache(path: string, collection: boolean): void {
  if (collection) {
    if (!watchedCollections.has(path)) {
      watchedCollections.add(path);
      fetchChildren(path);
    }
  } else {
    if (fetchedNodes.has(path)) return;
    fetchedNodes.add(path);
    trpc.get.query({ path }).then((n: any) => {
      if (n) cache.put(n as NodeData);
    });
  }
}

function evaluate(targetPath: string, field: string, ref: Ref): void {
  // Resolve $ref: "." → actual target path before eval
  const resolved = ref.$ref === '.' ? { ...ref, $ref: targetPath } : ref;
  try {
    const value = evaluateRef(resolved, ctx);
    setComputed(targetPath, field, value);
  } catch (e) {
    console.warn(`[bind] eval error ${targetPath}.${field}:`, e);
  }
}

function registerBinding(targetPath: string, field: string, ref: Ref): void {
  const once = hasOnce(ref);
  const unsubs: Unsub[] = [];
  const cb = () => evaluate(targetPath, field, ref);

  const mainPath = ref.$ref === '.' ? targetPath : ref.$ref;
  const collection = isCollectionRef(ref);

  if (mainPath !== targetPath) {
    ensureInCache(mainPath, collection);
  }

  // `once` — evaluate once, no reactive subscription
  if (!once) {
    unsubs.push(
      collection
        ? cache.subscribeChildren(mainPath, cb)
        : cache.subscribePath(mainPath, cb),
    );

    for (const argPath of extractArgPaths(ref)) {
      unsubs.push(cache.subscribePath(argPath, cb));
      ensureInCache(argPath, false);
    }
  }

  if (!active.has(targetPath)) active.set(targetPath, new Map());
  active.get(targetPath)!.set(field, { ref, unsub: () => unsubs.forEach(u => u()) });

  evaluate(targetPath, field, ref);
}

function unregisterAll(targetPath: string): void {
  const bindings = active.get(targetPath);
  if (!bindings) return;
  for (const { unsub } of bindings.values()) unsub();
  active.delete(targetPath);
  clearComputed(targetPath);
}

/** Scan a single node for $ref+$map fields, register/update bindings */
function scanNode(node: NodeData): void {
  const path = node.$path;
  const newRefs = new Map<string, Ref>();

  // Scan node-level fields
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith('$')) continue;
    if (isRef(value) && value.$map) {
      newRefs.set(key, value as Ref);
    }
    // Scan sub-component fields
    if (typeof value === 'object' && value !== null && '$type' in value) {
      for (const [subKey, subVal] of Object.entries(value)) {
        if (subKey.startsWith('$')) continue;
        if (isRef(subVal) && (subVal as Ref).$map) {
          newRefs.set(`${key}.${subKey}`, subVal as Ref);
        }
      }
    }
  }

  const existing = active.get(path);

  // No bindings before or after — nothing to do
  if (!existing && newRefs.size === 0) return;

  // Remove stale bindings
  if (existing) {
    for (const [field, { unsub }] of existing) {
      if (!newRefs.has(field)) {
        unsub();
        existing.delete(field);
      }
    }
    if (existing.size === 0 && newRefs.size === 0) {
      active.delete(path);
      clearComputed(path);
      return;
    }
  }

  // Register new/updated bindings
  for (const [field, ref] of newRefs) {
    const prev = existing?.get(field);
    // Skip if same expression
    if (prev && prev.ref.$ref === ref.$ref && prev.ref.$map === ref.$map) continue;
    // Unregister old
    if (prev) prev.unsub();
    registerBinding(path, field, ref);
  }
}

function handleRemove(path: string): void {
  unregisterAll(path);
}

/** Start the binding engine. Returns cleanup function. */
export function startBindEngine(): () => void {
  // 1. Scan all existing nodes in cache
  for (const [, node] of cache.raw()) {
    scanNode(node);
  }

  // 2. Reactive: scan each node as it arrives/changes — instant, no polling
  const unsubPut = cache.onNodePut((path) => {
    const node = cache.get(path);
    if (node) scanNode(node);
  });

  // 3. Detect removed nodes — clean up stale bindings
  const unsubGlobal = cache.subscribeGlobal(() => {
    for (const path of active.keys()) {
      if (!cache.get(path)) handleRemove(path);
    }
  });

  // Dev debug — inspect binding engine state from console
  if (typeof window !== 'undefined') {
    (window as any).__bind = {
      active: () => Object.fromEntries([...active].map(([k, v]) => [k, [...v.keys()]])),
      watched: () => [...watchedCollections],
      fetched: () => [...fetchedNodes],
      computed: () => {
        const result: Record<string, unknown> = {};
        for (const p of active.keys()) result[p] = getComputed(p);
        return result;
      },
    };
  }

  return () => {
    unsubPut();
    unsubGlobal();
    for (const path of [...active.keys()]) unregisterAll(path);
    watchedCollections.clear();
    fetchedNodes.clear();
  };
}
