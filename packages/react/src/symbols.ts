// Symbol-based component location metadata.
// Stamped on deserialization (cache.put). Non-enumerable so they're
// invisible to structuredClone, spread, and JSON/keys/entries.

import { isComponent, type NodeData } from '@treenx/core';

export const $key = Symbol.for('treenix.$key');
export const $node = Symbol.for('treenix.$node');

function hide(obj: object, sym: symbol, value: unknown): void {
  Object.defineProperty(obj, sym, { value, enumerable: false, writable: false, configurable: true });
}

export function stampNode(node: NodeData): void {
  if ((node as any)[$node] === node) return;

  hide(node, $key, '');
  hide(node, $node, node);

  for (const [k, v] of Object.entries(node)) {
    if (k.startsWith('$') || !isComponent(v)) continue;
    if ((v as any)[$node] !== undefined) continue; // shared frozen ref after merge
    hide(v, $key, k);
    hide(v, $node, node);
  }
}

// Stamp a synthetic component value (constructed at render time, not from cache)
// so views can resolve their owning node via $node / $key for useActions, viewCtx, etc.
export function stampComponent<T extends object>(value: T, node: NodeData, key = ''): T {
  if ((value as any)[$node] === node && (value as any)[$key] === key) return value;
  hide(value, $key, key);
  hide(value, $node, node);
  return value;
}
