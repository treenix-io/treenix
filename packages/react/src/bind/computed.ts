// Computed store — separate reactive layer for $ref+$map resolved values
// Dual: valtio proxies for field-level React reactivity (useSnapshot),
// plus synchronous manual subs for bind engine and non-React consumers.
// Never persisted to IDB or server. No Meteor trap.

import { proxy, snapshot } from 'valtio/vanilla';

type Sub = () => void;

const proxies = new Map<string, Record<string, unknown>>();
const subs = new Map<string, Set<Sub>>();

function ensure(path: string): Record<string, unknown> {
  let p = proxies.get(path);
  if (!p) {
    p = proxy<Record<string, unknown>>({});
    proxies.set(path, p);
  }
  return p;
}

function fire(path: string): void {
  const s = subs.get(path);
  if (s) for (const cb of s) cb();
}

export function getComputed(path: string): Record<string, unknown> | undefined {
  const p = proxies.get(path);
  if (!p) return undefined;
  return snapshot(p) as Record<string, unknown>;
}

/** Get the raw valtio proxy — for useSnapshot in hooks */
export function getComputedProxy(path: string): Record<string, unknown> | undefined {
  return proxies.get(path);
}

export function setComputed(path: string, field: string, value: unknown): void {
  const p = ensure(path);
  if (Object.is(p[field], value)) return; // no-op if unchanged
  p[field] = value;
  fire(path); // synchronous for non-React consumers
}

export function clearComputed(path: string): void {
  const p = proxies.get(path);
  if (p) {
    for (const k of Object.keys(p)) delete p[k];
    proxies.delete(path);
  }
  fire(path);
}

export function subscribeComputed(path: string, cb: Sub): () => void {
  if (!subs.has(path)) subs.set(path, new Set());
  subs.get(path)!.add(cb);
  return () => {
    const s = subs.get(path);
    if (s) {
      s.delete(cb);
      if (!s.size) subs.delete(path);
    }
  };
}
