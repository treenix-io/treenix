// Treenix Client Cache — reactive node store
// useSyncExternalStore-friendly: stable snapshots, targeted notifications
// IDB persistence: fire-and-forget writes, hydrate() on startup.
//
// State model: status-driven, not presence-driven. A path has a `pathStatus`
// that settles on every fetch (loading/ready/not_found/error). A parent has
// a `childPhase` driving loading/stale/loadingMore unambiguously.
// `childrenLoaded` is the authoritative "children list fetched" flag, kept
// separate from `parentIndex` (incidental node cache).

import type { NodeData } from '@treenx/core';
import * as idb from './idb';
import { stampNode } from '#symbols';

/** Shallow-freeze in dev mode to catch accidental cache mutation at the source */
const devFreeze: (node: NodeData) => void =
  import.meta.env?.DEV ? (node) => Object.freeze(node) : () => {};

type Sub = () => void;

const nodes = new Map<string, NodeData>();
// Explicit parent -> children index. This allows nodes to have their real $path
// while still appearing as children of virtual folders like query mounts.
const parentIndex = new Map<string, Set<string>>();
// Reverse index: child path -> set of parents that list it. Needed so an
// in-place update to a node living in N parents (natural + virtual query mounts)
// fans out childSubs to every parent, not just the natural one.
const nodeToParents = new Map<string, Set<string>>();
const pathSubs = new Map<string, Set<Sub>>();
const childSubs = new Map<string, Set<Sub>>();
const globalSubs = new Set<Sub>();
const childSnap = new Map<string, NodeData[]>();
let version = 0;

// lastUpdated: timestamp of last put() per path.
// Used for reconnect refresh ordering (most recently viewed first).
const lastUpdated = new Map<string, number>();
export const getLastUpdated = (path: string) => lastUpdated.get(path) ?? 0;

// ── Status-driven state (Hooks API Redesign) ──

// Per-path fetch status. A path becomes 'ready' / 'not_found' / 'error' when a
// fetch settles, NOT when cache.put() runs via side channels. This distinguishes
// "successful miss" from "still loading".
export type PathStatus = 'loading' | 'ready' | 'not_found' | 'error';
const pathStatus = new Map<string, PathStatus>();

// Per-parent fetch phase drives loading / stale / loadingMore unambiguously.
// Exactly one phase at a time. `not_found` intentionally omitted — server
// returns `{items:[], total:0}` for missing parents, indistinguishable via
// child fetch alone; consumers use `pathStatus` on the parent to distinguish.
export type ChildrenPhase = 'idle' | 'initial' | 'refetch' | 'append' | 'ready' | 'error';
const childPhase = new Map<string, ChildrenPhase>();

// First-caller-wins page size per parent. Released when subscriber ref-count
// drops to 0 so a later remount can re-lock with a different limit.
const childPageSize = new Map<string, number>();

// Ref-count of active useChildren mounts per parent. Drives childPageSize +
// loadedCount release on N→0.
const childSubscribers = new Map<string, number>();

// Authoritative "children collection loaded" flag per parent. Set ONLY by
// replaceChildren / appendChildren. NEVER set by plain cache.put(node), IDB
// hydrate, optimistic inserts, or SSE updates.
const childrenLoaded = new Set<string>();

// Count of children successfully loaded so far. Set to `result.items.length`
// by every successful initial/refetch (clamps to reality). Only appendChildren
// increments by the delta. Used by refetch() to reload the full loaded window.
const loadedCount = new Map<string, number>();

// Per-path / per-parent error from last failed fetch. Cleared on next success.
const pathErrors = new Map<string, Error>();
const childErrors = new Map<string, Error>();

// Error subscription channels — separate from data subs so consumers that
// only care about errors don't re-render on data changes (and vice versa).
const pathErrorSubs = new Map<string, Set<Sub>>();
const childErrorSubs = new Map<string, Set<Sub>>();

// Pagination metadata from last successful fetch. Absent key = unknown.
const childTotals = new Map<string, number>();
const childTruncated = new Map<string, boolean>();

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

function linkParent(path: string, parent: string) {
  let parents = nodeToParents.get(path);
  if (!parents) { parents = new Set(); nodeToParents.set(path, parents); }
  parents.add(parent);
}

function unlinkParent(path: string, parent: string) {
  const parents = nodeToParents.get(path);
  if (!parents) return;
  parents.delete(parent);
  if (parents.size === 0) nodeToParents.delete(path);
}

/** Fire childSubs for every parent currently listing this path. */
function fireAllParents(path: string) {
  const parents = nodeToParents.get(path);
  if (!parents) return;
  for (const p of parents) {
    childSnap.delete(p);
    fire(childSubs, p);
  }
}

// ── Reads ──

export const get = (path: string) => nodes.get(path);
export const has = (path: string) => nodes.has(path);
export const size = () => nodes.size;
export const getVersion = () => version;

/** Authoritative "children collection has been fetched at least once" flag.
 *  Set ONLY by replaceChildren/appendChildren. Used by useChildren to decide
 *  cold (initial) vs warm (refetch) mount. A bare `usePath('/a/b')` or an
 *  IDB-hydrated child does NOT mark its parent's collection as loaded. */
export const hasChildrenCollectionLoaded = (parent: string): boolean =>
  childrenLoaded.has(parent);

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
    linkParent(path, parent);
    childSnap.delete(parent);
    fire(childSubs, parent);
    bump();
  }
}

export function removeFromParent(path: string, parent: string) {
  const children = parentIndex.get(parent);
  if (children && children.has(path)) {
    children.delete(path);
    unlinkParent(path, parent);
    childSnap.delete(parent);
    fire(childSubs, parent);
    bump();
  }
}

// ── Writes ──

export function put(node: NodeData, virtualParent?: string) {
  stampNode(node);
  nodes.set(node.$path, node);
  devFreeze(node);
  const p = virtualParent ?? parentOf(node.$path);
  if (p !== null) {
    if (!parentIndex.has(p)) parentIndex.set(p, new Set());
    parentIndex.get(p)!.add(node.$path);
    linkParent(node.$path, p);
  }
  // Optimistic cache-only writes flip status to 'ready' — the data IS present,
  // even if unconfirmed. Does NOT touch childrenLoaded: putting a child node
  // does not mark the parent's collection as authoritatively loaded.
  pathStatus.set(node.$path, 'ready');
  if (pathErrors.has(node.$path)) {
    pathErrors.delete(node.$path);
    fire(pathErrorSubs, node.$path);
  }
  fire(pathSubs, node.$path);
  // Fan-out to every parent currently listing this node (natural + any VPs).
  // In-place updates on a node visible in multiple parents notify all of them.
  fireAllParents(node.$path);
  bump();
  for (const h of putHooks) h(node.$path);

  const ts = Date.now();
  lastUpdated.set(node.$path, ts);
  idb.save({ path: node.$path, data: node, lastUpdated: ts, virtualParent }).catch(() => {});
}

/** Authoritative replace of a parent's children list — used by initial fetch,
 *  refetch, reconnect, path change. Unlinks every child currently in
 *  parentIndex[parent] that's NOT in `items`. Nodes stay in the `nodes` map
 *  as soft cache so direct `usePath(removedPath)` still sees them.
 *  Sets `loadedCount[parent] = items.length` (clamps — may shrink).
 *  Marks the parent as authoritatively loaded. Does NOT set phase — caller
 *  sets phase after the write settles. */
export function replaceChildren(parent: string, items: NodeData[]) {
  const nextSet = new Set<string>();
  for (const n of items) nextSet.add(n.$path);

  // Unlink stale children from parentIndex[parent] and nodeToParents[removed].
  const existing = parentIndex.get(parent);
  if (existing) {
    for (const oldPath of existing) {
      if (!nextSet.has(oldPath)) {
        existing.delete(oldPath);
        unlinkParent(oldPath, parent);
      }
    }
  } else {
    parentIndex.set(parent, new Set());
  }

  // Put new items + link to parent
  const bucket = parentIndex.get(parent)!;
  const ts = Date.now();
  const idbEntries: idb.IDBEntry[] = [];
  const dirty = new Set<string>([parent]);
  for (const n of items) {
    stampNode(n);
    nodes.set(n.$path, n);
    devFreeze(n);
    lastUpdated.set(n.$path, ts);
    pathStatus.set(n.$path, 'ready');
    if (pathErrors.has(n.$path)) {
      pathErrors.delete(n.$path);
      fire(pathErrorSubs, n.$path);
    }
    fire(pathSubs, n.$path);
    bucket.add(n.$path);
    linkParent(n.$path, parent);
    // Also notify any other parents (virtual mounts) that list this node.
    const parents = nodeToParents.get(n.$path);
    if (parents) for (const p of parents) dirty.add(p);
    idbEntries.push({ path: n.$path, data: n, lastUpdated: ts, virtualParent: parent });
  }

  // Authoritative tracking
  childrenLoaded.add(parent);
  loadedCount.set(parent, items.length);
  if (childErrors.has(parent)) {
    childErrors.delete(parent);
    fire(childErrorSubs, parent);
  }

  for (const p of dirty) {
    childSnap.delete(p);
    fire(childSubs, p);
  }
  bump();
  for (const h of putHooks) for (const n of items) h(n.$path);
  idb.saveMany(idbEntries).catch(() => {});
}

/** Additive page — loadMore only. Merges into existing parentIndex[parent]
 *  without removing anything. Dedupes by $path. Increments loadedCount by
 *  the number of genuinely new items (not duplicates). */
export function appendChildren(parent: string, items: NodeData[]) {
  if (!parentIndex.has(parent)) parentIndex.set(parent, new Set());
  const bucket = parentIndex.get(parent)!;

  const ts = Date.now();
  const idbEntries: idb.IDBEntry[] = [];
  const dirty = new Set<string>([parent]);
  let added = 0;
  for (const n of items) {
    stampNode(n);
    const isNew = !bucket.has(n.$path);
    nodes.set(n.$path, n);
    devFreeze(n);
    lastUpdated.set(n.$path, ts);
    pathStatus.set(n.$path, 'ready');
    if (pathErrors.has(n.$path)) {
      pathErrors.delete(n.$path);
      fire(pathErrorSubs, n.$path);
    }
    fire(pathSubs, n.$path);
    bucket.add(n.$path);
    linkParent(n.$path, parent);
    if (isNew) added++;
    const parents = nodeToParents.get(n.$path);
    if (parents) for (const p of parents) dirty.add(p);
    idbEntries.push({ path: n.$path, data: n, lastUpdated: ts, virtualParent: parent });
  }

  childrenLoaded.add(parent);
  loadedCount.set(parent, (loadedCount.get(parent) ?? 0) + added);
  if (childErrors.has(parent)) {
    childErrors.delete(parent);
    fire(childErrorSubs, parent);
  }

  for (const p of dirty) {
    childSnap.delete(p);
    fire(childSubs, p);
  }
  bump();
  for (const h of putHooks) for (const n of items) h(n.$path);
  idb.saveMany(idbEntries).catch(() => {});
}

export function remove(path: string, virtualParent?: string) {
  nodes.delete(path);
  lastUpdated.delete(path);

  // Snapshot parents before unlinking so we can fire them after.
  // A removed node must clear out of every parent that listed it —
  // leaving stale entries in other parentIndex buckets would dangle.
  const parents = nodeToParents.get(path);
  const toFire = new Set<string>();
  if (parents) {
    for (const p of parents) {
      parentIndex.get(p)?.delete(path);
      childSnap.delete(p);
      toFire.add(p);
    }
    nodeToParents.delete(path);
  }
  // Honor explicit virtualParent hint even if reverse index is empty
  // (legacy callers may remove before put).
  const p = virtualParent ?? parentOf(path);
  if (p !== null && !toFire.has(p)) {
    parentIndex.get(p)?.delete(path);
    childSnap.delete(p);
    toFire.add(p);
  }

  fire(pathSubs, path);
  for (const fp of toFire) fire(childSubs, fp);
  bump();
  idb.del(path).catch(() => {});
}

/** Atomic "server confirmed this path does not exist":
 *  1. Evict stale cached node + unlink from all parentIndex buckets
 *  2. Clear any prior path error
 *  3. Set pathStatus = 'not_found'
 *  4. Fire pathSubs + pathErrorSubs ONCE (batched)
 *  Used by usePath fetch effect on null tRPC response. Without this, a
 *  previously cached node that was later deleted server-side leaves `data`
 *  pointing at stale content while status says not_found — contradictory. */
export function markPathMissing(path: string) {
  nodes.delete(path);
  lastUpdated.delete(path);

  const parents = nodeToParents.get(path);
  const toFire = new Set<string>();
  if (parents) {
    for (const p of parents) {
      parentIndex.get(p)?.delete(path);
      childSnap.delete(p);
      toFire.add(p);
    }
    nodeToParents.delete(path);
  }

  if (pathErrors.has(path)) pathErrors.delete(path);
  pathStatus.set(path, 'not_found');

  // Batched notification — one fire per sub set.
  fire(pathSubs, path);
  fire(pathErrorSubs, path);
  for (const fp of toFire) fire(childSubs, fp);
  bump();
  idb.del(path).catch(() => {});
}

// ── Path status ──

export const getPathStatus = (path: string): PathStatus | undefined => pathStatus.get(path);

export function setPathStatus(path: string, status: PathStatus) {
  pathStatus.set(path, status);
  fire(pathSubs, path);
  fire(pathErrorSubs, path);
}

export const hasPathSettled = (path: string): boolean => {
  const s = pathStatus.get(path);
  return s === 'ready' || s === 'not_found' || s === 'error';
};

// ── Children phase ──

export const getChildrenPhase = (parent: string): ChildrenPhase =>
  childPhase.get(parent) ?? 'idle';

export function setChildrenPhase(parent: string, phase: ChildrenPhase) {
  childPhase.set(parent, phase);
  childSnap.delete(parent);
  fire(childSubs, parent);
}

// ── Errors ──

export const getPathError = (path: string): Error | null => pathErrors.get(path) ?? null;
export const getChildrenError = (parent: string): Error | null => childErrors.get(parent) ?? null;

export function setPathError(path: string, err: Error | null) {
  if (err) pathErrors.set(path, err);
  else pathErrors.delete(path);
  fire(pathErrorSubs, path);
}

export function setChildrenError(parent: string, err: Error | null) {
  if (err) childErrors.set(parent, err);
  else childErrors.delete(parent);
  fire(childErrorSubs, parent);
}

export const subscribePathError = (path: string, cb: Sub) => addSub(pathErrorSubs, path, cb);
export const subscribeChildrenError = (parent: string, cb: Sub) => addSub(childErrorSubs, parent, cb);

// ── Page size lock + subscriber ref-counting ──

/** First-wins page size lock per parent. Second caller with a different limit
 *  gets a dev-mode console.warn and the locked value is used.
 *  Returns the effective locked size. */
export function lockChildPageSize(parent: string, size: number): number {
  const existing = childPageSize.get(parent);
  if (existing !== undefined) {
    if (import.meta.env?.DEV && existing !== size) {
      console.warn(
        `[cache] childPageSize for ${parent} already locked to ${existing}, ignoring ${size}`,
      );
    }
    return existing;
  }
  childPageSize.set(parent, size);
  return size;
}

export const getChildPageSize = (parent: string): number | undefined => childPageSize.get(parent);

export function retainChildSubscriber(parent: string) {
  childSubscribers.set(parent, (childSubscribers.get(parent) ?? 0) + 1);
}

/** Decrement subscriber count. On N→0, clear childPageSize + loadedCount so a
 *  later remount can re-lock freely. childrenLoaded + soft cache are preserved
 *  intentionally (placeholderData for next remount — React Query semantics). */
export function releaseChildSubscriber(parent: string) {
  const n = (childSubscribers.get(parent) ?? 0) - 1;
  if (n <= 0) {
    childSubscribers.delete(parent);
    childPageSize.delete(parent);
    loadedCount.delete(parent);
  } else {
    childSubscribers.set(parent, n);
  }
}

export const getLoadedCount = (parent: string): number => loadedCount.get(parent) ?? 0;

// ── Pagination metadata ──

export function setChildrenTotal(parent: string, total: number) {
  childTotals.set(parent, total);
  fire(childSubs, parent);
}

export const getChildrenTotal = (parent: string): number | null =>
  childTotals.has(parent) ? childTotals.get(parent)! : null;

export function setChildrenTruncated(parent: string, truncated: boolean) {
  childTruncated.set(parent, truncated);
  fire(childSubs, parent);
}

export const getChildrenTruncated = (parent: string): boolean | null =>
  childTruncated.has(parent) ? childTruncated.get(parent)! : null;

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

/** SSE reconnect handler. Called only on non-preserved reconnects, so all
 *  cached fetch state must be invalidated — hooks will re-issue fetches on
 *  the gen bump. Active childSubscribers (mounted hooks) are NOT touched. */
export function signalReconnect() {
  sseGen++;
  pathStatus.clear();
  childPhase.clear();
  pathErrors.clear();
  childErrors.clear();
  childTotals.clear();
  childTruncated.clear();
  childPageSize.clear();
  loadedCount.clear();
  childrenLoaded.clear();
  for (const cb of genSubs) cb();
}

// ── Bulk ──

export function clear() {
  nodes.clear();
  parentIndex.clear();
  nodeToParents.clear();
  childSnap.clear();
  lastUpdated.clear();
  pathStatus.clear();
  childPhase.clear();
  pathErrors.clear();
  childErrors.clear();
  childTotals.clear();
  childTruncated.clear();
  childPageSize.clear();
  childSubscribers.clear();
  childrenLoaded.clear();
  loadedCount.clear();
  bump();
  idb.clearAll().catch(() => {});
}

type ServerHydrationState = {
  paths?: Record<string, NodeData | null>;
  children?: Record<string, NodeData[]>;
  childMeta?: Record<string, { total?: number; truncated?: boolean }>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const isNodeData = (value: unknown): value is NodeData =>
  isRecord(value) && typeof value.$path === 'string';

/** Populate the client cache from the SSR snapshot before hydrateRoot().
 *  This keeps the first client render aligned with the server DOM. */
export function hydrateFromServerSnapshot(state: unknown): void {
  if (!isRecord(state)) return;
  const snapshot = state as ServerHydrationState;

  if (isRecord(snapshot.paths)) {
    for (const [path, node] of Object.entries(snapshot.paths)) {
      if (node === null) {
        markPathMissing(path);
      } else if (isNodeData(node)) {
        put(node);
      }
    }
  }

  if (isRecord(snapshot.children)) {
    for (const [parent, items] of Object.entries(snapshot.children)) {
      if (!Array.isArray(items)) continue;
      const nodes = items.filter(isNodeData);
      replaceChildren(parent, nodes);
      const meta = snapshot.childMeta?.[parent];
      setChildrenTotal(parent, typeof meta?.total === 'number' ? meta.total : nodes.length);
      setChildrenTruncated(parent, !!meta?.truncated);
      setChildrenPhase(parent, 'ready');
    }
  }
}

// Populate cache from IDB on startup — no IDB writes triggered.
// Call before first render for instant stale paint.
// NOTE: hydrate does NOT populate childrenLoaded — IDB entries are incidental
// cache, not authoritative collections. Pagination metadata (total/truncated/
// loadedCount) cannot be reconstructed from IDB, so treating a hydrated node
// as "children already fetched" would lie. A hook mount that finds
// childrenLoaded.has(parent) === true (from a prior in-session fetch still
// cached) starts phase as 'refetch' → placeholderData semantics. Cold restart:
// always cold fetch.
export async function hydrate(): Promise<void> {
  // SSR / Node has no IndexedDB — silently no-op so server-side imports
  // (e.g. Router on entry-server) don't crash at module load.
  if (typeof indexedDB === 'undefined') return;
  try {
    const entries = await idb.loadAll();
    for (const { data, lastUpdated: ts, virtualParent } of entries) {
      stampNode(data);
      nodes.set(data.$path, data);
      devFreeze(data);
      lastUpdated.set(data.$path, ts);
      // Data IS present, though possibly stale — status 'ready' is honest.
      pathStatus.set(data.$path, 'ready');
      const p = virtualParent ?? parentOf(data.$path);
      if (p !== null) {
        if (!parentIndex.has(p)) parentIndex.set(p, new Set());
        parentIndex.get(p)!.add(data.$path);
        linkParent(data.$path, p);
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
