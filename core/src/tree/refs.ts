// Ref bookkeeping of the storage policy: the derived $refs index and the move tombstone.

import { type ComponentData, isComponent, type NodeData } from '#core';
import { KernelError } from '#errors';
import { isRecord } from '#util/is-record';

/** One outgoing ref: `f` locates the ref field; standalone entries carry none and may carry data `d`. */
export type RefEntry = { t: string; f?: string; d?: ComponentData };

function isRefEntry(value: unknown): value is RefEntry {
  if (!isRecord(value) || typeof value.t !== 'string') return false;
  return (value.f === undefined || typeof value.f === 'string') && (value.d === undefined || isComponent(value.d));
}

/** The node's $refs index; a malformed one is INVALID. */
export function refsOf(node: NodeData): RefEntry[] | undefined {
  const refs = node.$refs;
  if (refs === undefined) return undefined;
  if (!Array.isArray(refs) || !refs.every(isRefEntry)) throw new KernelError('INVALID', `Malformed $refs on ${node.$path}`);
  return refs;
}

// ── Moved tombstone ──
// Left at the old path by move(): redirects reads/refs to the new location.
// Deliberately NOT a ref (isRef is false) — nothing follows it by accident;
// resolveRef follows chains explicitly. Carries the moved node's $id (echoed
// by the write pipeline): the tombstone is a forwarding address for exactly
// that identity, letting resolveRef verify it is following the right chain.
export type Moved = { $type: 'moved' | 't.moved'; $ref: string };

export function isMoved(value: unknown): value is Moved {
  return isRecord(value) && (value.$type === 'moved' || value.$type === 't.moved') && typeof value.$ref === 'string';
}
