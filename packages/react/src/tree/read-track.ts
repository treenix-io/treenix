// read-track — the ONE door for tracked client reads (ns6p.4 F1).
//
// Every read that lands in the shared cache must pass through trackedGet /
// trackedList: they own the per-resource request generations (invariant 17),
// the in-flight overlap machinery (invariants 18/19), rebase-aware ingest
// (inv. 28) and the absence rules. Round 1 wired sites through ingestNode
// only — ingest cannot order ABSENCE (a remove/evict leaves nothing to
// compare a stale response against), so any site outside the door could
// resurrect a removed node. No consumer writes read results to the cache
// directly anymore.

import type { NodeData } from '@treenx/core';
// '#tree/...' (not relative) so Vite/tests dedupe to one module instance.
import * as cache from '#tree/cache';
import { ingestNode } from '#tree/rebase';

// Coalesce window shared by every reconverge lane (gk8.12): a burst of
// overlapping events triggers ONE refetch. Lived in events.ts before the door.
export const DIRTY_COALESCE_MS = 75;

// ── Resource identity + generations (invariant 17) ──
// A read is identified by verb + path + normalized query — NOT parent path
// alone, so two queries over one parent don't share a generation counter.
// Module-level: EVERY consumer (source mounts, sidebar listings, watch()
// generators, invalidate refetches) competes in one latest-wins lane per
// resource — cross-consumer ordering is the point of the door.

function sortKeysDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeysDeep);
  if (v && typeof v === 'object') {
    const src = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) out[k] = sortKeysDeep(src[k]);
    return out;
  }
  return v;
}

export const resourceKey = (kind: 'get' | 'ls', path: string, query?: Record<string, unknown>): string =>
  `${kind}\u0000${path}\u0000${query ? JSON.stringify(sortKeysDeep(query)) : ''}`;

const readGens = new Map<string, number>();

function issueRead(key: string): number {
  const gen = (readGens.get(key) ?? 0) + 1;
  readGens.set(key, gen);
  return gen;
}

const isCurrentRead = (key: string, gen: number): boolean => readGens.get(key) === gen;

// A response that lost its generation is dropped — latest-issued wins, never
// last-settled. Silent in prod (the drop IS the correct behavior), loud in dev.
function dropStale(kind: string, path: string): void {
  if (import.meta.env?.DEV) {
    console.warn(`[read-track] stale ${kind} response for ${path} dropped (superseded read)`);
  }
}

// End a tracked read exactly once (a throw after settle falls into catch).
function readEnder(end: (applied: boolean) => boolean): (applied: boolean) => boolean {
  let ended = false;
  return (applied) => ended ? false : ((ended = true), end(applied));
}

export type TrackedOpts = {
  /** Mount-owned reconverge lane (refetch through the mount's own status
   *  flow). Default: the door's coalesced re-run of the same read. */
  onOverlap?: () => void;
  /** Latest-wins guard beyond the resource generation (mount disposal). */
  isCancelled?: () => boolean;
};

export type TrackedGetOutcome = {
  /** Response won its generation and was routed to the cache. */
  applied: boolean;
  /** An event overlapped this read — a reconverge refetch was scheduled. */
  overlapped: boolean;
  /** Read still owned the resource generation when it settled — errors of a
   *  superseded read must not clobber a fresher read's presentation state. */
  current: boolean;
  node: NodeData | null;
  /** Fetch rejection, surfaced instead of thrown so `current` can gate it. */
  error?: unknown;
};

export type PathFetch = (path: string) => Promise<NodeData | null | undefined>;

/** Tracked exact-path read. Applies through ingest, never regressing; consumes
 *  the overlap flag; enforces both absence rules:
 *  - absent-vs-create: an overlapped 'absent' never markPathMissing — refetch.
 *  - remove-vs-node: an overlapped node response onto an EVICTED path is not
 *    put (would resurrect the removed node) — refetch decides. */
export async function trackedGet(
  path: string,
  fetch: () => Promise<NodeData | null | undefined>,
  opts?: TrackedOpts,
): Promise<TrackedGetOutcome> {
  const key = resourceKey('get', path);
  const gen = issueRead(key);
  cache.beginPathRead(path);
  const end = readEnder((a) => cache.endPathRead(path, a));
  try {
    const n = (await fetch()) ?? null;
    const current = isCurrentRead(key, gen);
    const applied = current && !opts?.isCancelled?.();
    const overlapped = end(applied);
    if (!applied) {
      if (!opts?.isCancelled?.()) dropStale('get', path);
      return { applied, overlapped, current, node: n };
    }
    if (n) {
      if (!overlapped || cache.get(path) !== undefined) cache.put(ingestNode(n));
    } else if (!overlapped) {
      cache.markPathMissing(path);
    }
    if (overlapped) (opts?.onOverlap ?? (() => scheduleGetReconverge(path, fetch)))();
    return { applied, overlapped, current, node: n };
  } catch (error) {
    end(false);
    const current = isCurrentRead(key, gen);
    if (!current) dropStale('get', path);
    return { applied: false, overlapped: false, current, node: null, error };
  }
}

export type TrackedListOutcome = {
  applied: boolean;
  overlapped: boolean;
  current: boolean;
  error?: unknown;
};

export type ListWindow = {
  items: NodeData[];
  total?: number;
  truncated?: boolean;
  nextCursor?: string;
};

/** Tracked listing read. Items are ingest-mapped BEFORE `apply` runs, so no
 *  consumer can write raw wire images; `apply` runs only for the winning
 *  response. Membership overlap (create/remove mid-read, invariant 19)
 *  schedules the reconverge lane. */
export async function trackedList<R extends { items: NodeData[] }>(
  parent: string,
  query: Record<string, unknown> | undefined,
  fetch: () => Promise<R>,
  apply: (result: R) => void,
  opts?: TrackedOpts,
): Promise<TrackedListOutcome> {
  const key = resourceKey('ls', parent, query);
  const gen = issueRead(key);
  cache.beginChildrenRead(parent);
  const end = readEnder((a) => cache.endChildrenRead(parent, a));
  try {
    const result = await fetch();
    const current = isCurrentRead(key, gen);
    const applied = current && !opts?.isCancelled?.();
    const overlapped = end(applied);
    if (!applied) {
      if (!opts?.isCancelled?.()) dropStale('ls', parent);
      return { applied, overlapped, current };
    }
    result.items = result.items.map(ingestNode);
    apply(result);
    if (overlapped) (opts?.onOverlap ?? (() => scheduleListReconverge(key, parent, query, fetch, apply)))();
    return { applied, overlapped, current };
  } catch (error) {
    end(false);
    const current = isCurrentRead(key, gen);
    if (!current) dropStale('ls', parent);
    return { applied: false, overlapped: false, current, error };
  }
}

/** Standard settle of a full listing window — shared by every replace-window
 *  consumer so a window won by ANY of them leaves phase/metadata consistent
 *  (a consumer that only wrote membership would strand a superseded mount's
 *  phase at 'initial'). Items must already be ingest-mapped (trackedList). */
export function applyListingWindow(parent: string, result: ListWindow): void {
  cache.replaceChildren(parent, result.items);
  if (result.total !== undefined) cache.setChildrenTotal(parent, result.total);
  cache.setChildrenTruncated(parent, !!result.truncated);
  cache.setChildrenNextCursor(parent, result.nextCursor ?? null);
  cache.setChildrenError(parent, null);
  cache.setChildrenPhase(parent, 'ready');
}

/** Evict with ordering (F2): record the overlap FIRST so an in-flight read of
 *  this path refetches instead of resurrecting the evicted node with its
 *  stale response. */
export function evictTracked(path: string): void {
  cache.flagPathReadOverlap(path);
  cache.remove(path);
}

// ── Default reconverge lanes (coalesced re-run of the same read) ──
// Consumers without their own refetch flow (sidebar listings, watch()
// initial gets, one-shot refreshes) reconverge here.

const getReconverge = new Map<string, ReturnType<typeof setTimeout>>();
const listReconverge = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleGetReconverge(path: string, fetch: () => Promise<NodeData | null | undefined>): void {
  if (getReconverge.has(path)) return;
  getReconverge.set(path, setTimeout(() => {
    getReconverge.delete(path);
    void trackedGet(path, fetch).then((o) => {
      if (o.error !== undefined && o.current) console.error('[read-track] reconverge get failed:', path, o.error);
    });
  }, DIRTY_COALESCE_MS));
}

function scheduleListReconverge<R extends { items: NodeData[] }>(
  key: string, parent: string, query: Record<string, unknown> | undefined,
  fetch: () => Promise<R>, apply: (result: R) => void,
): void {
  if (listReconverge.has(key)) return;
  listReconverge.set(key, setTimeout(() => {
    listReconverge.delete(key);
    void trackedList(parent, query, fetch, apply).then((o) => {
      if (o.error !== undefined && o.current) console.error('[read-track] reconverge ls failed:', parent, o.error);
    });
  }, DIRTY_COALESCE_MS));
}

/** Cancel pending default reconverges (SSE teardown + test hygiene) — a
 *  non-preserved reconnect refetches everything anyway. */
export function cancelReadReconverges(): void {
  for (const t of getReconverge.values()) clearTimeout(t);
  getReconverge.clear();
  for (const t of listReconverge.values()) clearTimeout(t);
  listReconverge.clear();
}
