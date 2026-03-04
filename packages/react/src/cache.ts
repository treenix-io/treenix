// Treenity Client Cache — reactive node store
// useSyncExternalStore-friendly: stable snapshots, targeted notifications
// IDB persistence: fire-and-forget writes, hydrate() on startup.

import type { NodeData } from '@treenity/core/core';
import * as idb from './idb';

type Sub = () => void;

const nodes = new Map<string, NodeData>();
// Explicit parent -> children index. This allows nodes to have their real $path
// while still appearing as children of virtual folders like query mounts.
const parentIndex = new Map<string, Set<string>>();
const pathSubs = new Map<string, Set<Sub>>();
const childSubs = new Map<string, Set<Sub>>();
const globalSubs = new Set<Sub>();
const childSnap = new Map<string, NodeData[]>();
let version = 0;

// lastUpdated: timestamp of last put() per path.
// Used for reconnect refresh ordering (most recently viewed first).
const lastUpdated = new Map<string, number>();
export const getLastUpdated = (path: string) => lastUpdated.get(path) ?? 0;

function addSub(map: Map<string, Set<Sub>>, key: string, cb: Sub): () => void {
  if (!map.has(key)) map.set(key, new Set());
  map.get(key)!.add(cb);
  return () => {
    const s = map.get(key);
    if (s) {
      s.delete(cb);
      if (!s.size) map.delete(key);
    }
  };
}

function fire(map: Map<string, Set<Sub>>, key: string) {
  const s = map.get(key);
  if (s) for (const cb of s) cb();
}

function bump() {
  version++;
  for (const cb of globalSubs) cb();
}

function parentOf(p: string): string | null {
  if (p === '/') return null;
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}

// ── Reads ──

export const get = (path: string) => nodes.get(path);
export const has = (path: string) => nodes.has(path);
export const size = () => nodes.size;
export const getVersion = () => version;

export function getChildren(parent: string): NodeData[] {
  let snap = childSnap.get(parent);
  if (snap) return snap;
  
  const out: NodeData[] = [];
  const children = parentIndex.get(parent);
  
  if (children) {
    for (const p of children) {
      const n = nodes.get(p);
      if (n) out.push(n);
    }
  } else {
    // Fallback: If not indexed explicitly, find children by string prefix 
    const prefix = parent === '/' ? '/' : parent + '/';
    for (const [p, n] of nodes) {
      if (p === parent || !p.startsWith(prefix)) continue;
      const rest = parent === '/' ? p.slice(1) : p.slice(prefix.length);
      if (rest && !rest.includes('/')) out.push(n);
    }
  }
  
  out.sort((a, b) => a.$path.localeCompare(b.$path));
  childSnap.set(parent, out);
  return out;
}

// ── Parent Index Management ──

export function addToParent(path: string, parent: string) {
  if (!parentIndex.has(parent)) parentIndex.set(parent, new Set());
  if (!parentIndex.get(parent)!.has(path)) {
    parentIndex.get(parent)!.add(path);
    childSnap.delete(parent);
    fire(childSubs, parent);
    bump();
  }
}

export function removeFromParent(path: string, parent: string) {
  const children = parentIndex.get(parent);
  if (children && children.has(path)) {
    children.delete(path);
    childSnap.delete(parent);
    fire(childSubs, parent);
    bump();
  }
}

// ── Writes ──

export function put(node: NodeData, virtualParent?: string) {
  nodes.set(node.$path, node);
  const p = virtualParent ?? parentOf(node.$path);
  if (p !== null) {
    if (!parentIndex.has(p)) parentIndex.set(p, new Set());
    parentIndex.get(p)!.add(node.$path);
    childSnap.delete(p);
  }
  fire(pathSubs, node.$path);
  if (p !== null) fire(childSubs, p);
  bump();
  for (const h of putHooks) h(node.$path);

  const ts = Date.now();
  lastUpdated.set(node.$path, ts);
  idb.save({ path: node.$path, data: node, lastUpdated: ts, virtualParent }).catch(() => {});
}

export function putMany(items: NodeData[], virtualParent?: string) {
  const dirty = new Set<string>();
  if (virtualParent) {
    if (!parentIndex.has(virtualParent)) parentIndex.set(virtualParent, new Set());
    dirty.add(virtualParent);
  }
  const ts = Date.now();
  const idbEntries: idb.IDBEntry[] = [];
  for (const n of items) {
    nodes.set(n.$path, n);
    lastUpdated.set(n.$path, ts);
    fire(pathSubs, n.$path);
    const p = virtualParent ?? parentOf(n.$path);
    if (p !== null) {
      if (!parentIndex.has(p)) parentIndex.set(p, new Set());
      parentIndex.get(p)!.add(n.$path);
      dirty.add(p);
      childSnap.delete(p);
    }
    idbEntries.push({ path: n.$path, data: n, lastUpdated: ts, virtualParent });
  }
  for (const p of dirty) {
    childSnap.delete(p);
    fire(childSubs, p);
  }
  if (items.length || dirty.size) bump();
  idb.saveMany(idbEntries).catch(() => {});
}

export function remove(path: string, virtualParent?: string) {
  nodes.delete(path);
  lastUpdated.delete(path);
  const p = virtualParent ?? parentOf(path);
  if (p !== null) {
    parentIndex.get(p)?.delete(path);
    childSnap.delete(p);
  }
  fire(pathSubs, path);
  if (p !== null) fire(childSubs, p);
  bump();
  idb.del(path).catch(() => {});
}

// ── Subscriptions ──

export const subscribePath = (path: string, cb: Sub) => addSub(pathSubs, path, cb);
export const subscribeChildren = (parent: string, cb: Sub) => addSub(childSubs, parent, cb);
export const subscribeGlobal = (cb: Sub): (() => void) => {
  globalSubs.add(cb);
  return () => globalSubs.delete(cb);
};

// ── Per-put hook (used by bind engine) ──
const putHooks = new Set<(path: string) => void>();
export function onNodePut(cb: (path: string) => void): () => void {
  putHooks.add(cb);
  return () => putHooks.delete(cb);
}

// ── Extra accessors ──
export function notifyPath(path: string) { fire(pathSubs, path); }
export function getSnapshot(path: string): NodeData | undefined {
  const node = nodes.get(path);
  if (!node) return undefined;
  return structuredClone(node);
}

// ── SSE Reconnect ──
// Generation counter — bumped when SSE reconnects with preserved=false.
// useChildren depends on this to re-fetch and re-register watches.
let sseGen = 0;
const genSubs = new Set<Sub>();
export const getSSEGen = () => sseGen;
export function subscribeSSEGen(cb: Sub) {
  genSubs.add(cb);
  return () => genSubs.delete(cb);
}
export function signalReconnect() {
  sseGen++;
  for (const cb of genSubs) cb();
}

// ── Bulk ──

export function clear() {
  nodes.clear();
  parentIndex.clear();
  childSnap.clear();
  lastUpdated.clear();
  bump();
  idb.clearAll().catch(() => {});
}

// Populate cache from IDB on startup — no IDB writes triggered.
// Call before first render for instant stale paint.
export async function hydrate(): Promise<void> {
  try {
    const entries = await idb.loadAll();
    for (const { data, lastUpdated: ts, virtualParent } of entries) {
      nodes.set(data.$path, data);
      lastUpdated.set(data.$path, ts);
      const p = virtualParent ?? parentOf(data.$path);
      if (p !== null) {
        if (!parentIndex.has(p)) parentIndex.set(p, new Set());
        parentIndex.get(p)!.add(data.$path);
        childSnap.delete(p);
      }
    }
    if (entries.length) bump();
  } catch {
    // IDB unavailable (private browsing, etc.) — continue without persistence
  }
}

// Expose raw Map for Tree component (read-only contract)
export const raw = () => nodes;
