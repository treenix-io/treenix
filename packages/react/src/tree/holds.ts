// holds — tab-global watch-hold registry (ns6p.4 F5, invariant 2 co-holds).
//
// The server keeps ONE hold per (user, TAB_TOKEN, path). Client refcounts
// used to be siloed (source mounts, watch() generators) and UI sites released
// directly — a sidebar collapse could strip the hold an Inspector usePath()
// still relied on. Every consumer counts here; the unwatch mutation fires
// only when the tab-wide count hits zero.

// '#tree/trpc' (not relative) so Vite/tests dedupe to one module instance.
import { tabTokenInput, trpc } from '#tree/trpc';

const exactHolds = new Map<string, number>();
const childrenHolds = new Map<string, number>();

function acquire(map: Map<string, number>, path: string): void {
  map.set(path, (map.get(path) ?? 0) + 1);
}

/** true = the last hold dropped (or none was tracked) — release server-side. */
function release(map: Map<string, number>, path: string): boolean {
  const n = map.get(path);
  if (n === undefined) return true;
  if (n > 1) {
    map.set(path, n - 1);
    return false;
  }
  map.delete(path);
  return true;
}

function fireUnwatch(paths: string[]): void {
  if (!paths.length) return;
  // core-m77: a failure here means the server-side watch leaks — surface it.
  trpc.unwatch.mutate({ paths, ...tabTokenInput })
    .catch((e: unknown) => console.error('[holds] unwatch failed:', paths, e));
}

export function acquireHold(path: string): void {
  acquire(exactHolds, path);
}

export function acquireHolds(paths: string[]): void {
  for (const p of paths) acquire(exactHolds, p);
}

export function releaseHold(path: string): void {
  releaseHolds([path]);
}

/** Batched: one unwatch mutation for every path whose last hold dropped. */
export function releaseHolds(paths: string[]): void {
  fireUnwatch(paths.filter((p) => release(exactHolds, p)));
}

export function acquireChildrenHold(path: string): void {
  acquire(childrenHolds, path);
}

export function releaseChildrenHold(path: string): void {
  if (!release(childrenHolds, path)) return;
  trpc.unwatchChildren.mutate({ paths: [path], ...tabTokenInput })
    .catch((e: unknown) => console.error('[holds] unwatchChildren failed:', path, e));
}

/** Sweep server-side strays this tab never counted (autoWatch promotions of
 *  children born while a listing was live): unwatch only what NOBODY holds —
 *  a counted hold (e.g. an Inspector on a just-created child) survives. */
export function releaseUnheld(paths: string[]): void {
  fireUnwatch(paths.filter((p) => !exactHolds.has(p)));
}

/** Test hygiene. */
export function resetHolds(): void {
  exactHolds.clear();
  childrenHolds.clear();
}
