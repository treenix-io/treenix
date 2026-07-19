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

// r3-F2: in-flight unwatch per path. A registering request issued while an
// unwatch of the same key rides the wire can reach the server first — the
// late unwatch then kills the fresh registration. Registering call sites
// acquire EAGERLY (the count keeps co-consumer releases from firing at all)
// and await the gate, serializing the re-registration after the unwatch.
const exactUnwatchInflight = new Map<string, Promise<void>>();
const childrenUnwatchInflight = new Map<string, Promise<void>>();

function trackUnwatch(map: Map<string, Promise<void>>, paths: string[], mutation: Promise<unknown>): void {
  const settled = mutation.then(() => undefined, () => undefined);
  for (const p of paths) {
    const prev = map.get(p);
    const gate = prev ? prev.then(() => settled) : settled;
    map.set(p, gate);
    void gate.then(() => { if (map.get(p) === gate) map.delete(p); });
  }
}

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
  const mutation = trpc.unwatch.mutate({ paths, ...tabTokenInput });
  mutation.catch((e: unknown) => console.error('[holds] unwatch failed:', paths, e));
  trackUnwatch(exactUnwatchInflight, paths, mutation);
}

export function acquireHold(path: string): void {
  acquire(exactHolds, path);
}

/** Eager acquire for a registering exact get/resolve (r3-F2): counts NOW — a
 *  co-consumer's release-to-zero mid-request can no longer strip the server
 *  hold the request is creating — and resolves once any in-flight unwatch of
 *  the path has settled, so the caller issues the re-registration strictly
 *  after it. On request failure the caller releases (a co-consumer release
 *  absorbed by this count must still reach the server). */
export function acquireHoldForRegistration(path: string): Promise<void> {
  acquire(exactHolds, path);
  return exactUnwatchInflight.get(path) ?? Promise.resolve();
}

/** Children-hold twin of acquireHoldForRegistration (rapid collapse→expand). */
export function acquireChildrenHoldForRegistration(path: string): Promise<void> {
  acquire(childrenHolds, path);
  return childrenUnwatchInflight.get(path) ?? Promise.resolve();
}

// r4-F1: gate visibility for registering sites that must NOT pay an
// unconditional microtask (source mounts — their synchronous begin*Read is
// load-bearing for overlap ordering) and for response-derived acquires
// (resolve target — the path is only known when the response arrives).
// undefined = no unwatch on the wire, the registration may issue NOW.

export function inflightUnwatch(path: string): Promise<void> | undefined {
  return exactUnwatchInflight.get(path);
}

export function inflightChildrenUnwatch(path: string): Promise<void> | undefined {
  return childrenUnwatchInflight.get(path);
}

/** True while any consumer counts an exact hold on the path (r4-F1: the
 *  response-derived re-register lane skips paths every consumer abandoned). */
export function isHeld(path: string): boolean {
  return exactHolds.has(path);
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
  releaseChildrenHolds([path]);
}

/** Batched children twin of releaseHolds (r4-F2: sidebar unmount sweep). */
export function releaseChildrenHolds(paths: string[]): void {
  const last = paths.filter((p) => release(childrenHolds, p));
  if (!last.length) return;
  const mutation = trpc.unwatchChildren.mutate({ paths: last, ...tabTokenInput });
  mutation.catch((e: unknown) => console.error('[holds] unwatchChildren failed:', last, e));
  trackUnwatch(childrenUnwatchInflight, last, mutation);
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
  exactUnwatchInflight.clear();
  childrenUnwatchInflight.clear();
}
