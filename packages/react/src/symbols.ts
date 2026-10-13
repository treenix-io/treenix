// Symbol-based component location metadata.
// Stamped on deserialization (cache.put). Non-enumerable so they're
// invisible to structuredClone, spread, and JSON/keys/entries.

import { isComponent, type NodeData } from '@treenx/core';

export const $key = Symbol.for('treenix.$key');
export const $node = Symbol.for('treenix.$node');

export interface ComponentLocation {
  readonly [$node]?: NodeData;
  readonly [$key]?: string;
}

/** Read metadata owned by the component stamper, including an unstamped value. */
export function componentLocation(value: object & ComponentLocation): ComponentLocation {
  return value;
}

function hide(obj: object, sym: symbol, value: unknown): void {
  Object.defineProperty(obj, sym, { value, enumerable: false, writable: false, configurable: true });
}

export function stampNode(node: NodeData): void {
  if (componentLocation(node)[$node] === node) return;

  hide(node, $key, '');
  hide(node, $node, node);

  for (const [k, v] of Object.entries(node)) {
    if (k.startsWith('$') || !isComponent(v)) continue;
    if (componentLocation(v)[$node] !== undefined) continue; // shared frozen ref after merge
    hide(v, $key, k);
    hide(v, $node, node);
  }
}

// Stamp a synthetic component value (constructed at render time, not from cache)
// so views can resolve their owning node via $node / $key for useActions, viewCtx, etc.
export function stampComponent<T extends object>(value: T, node: NodeData, key = ''): T {
  if (
    componentLocation(value)[$node] === node &&
    componentLocation(value)[$key] === key
  ) {
    return value;
  }
  hide(value, $key, key);
  hide(value, $node, node);
  return value;
}
