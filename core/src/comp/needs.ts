import { getMeta, type TypeId } from '#core';
import { basename } from '#core/path';

// ── Types ──

export type NeedSpec =
  | { kind: 'sibling'; name: string; key: string }
  | { kind: 'field-ref'; field: string; key: string }
  | { kind: 'path'; path: string; key: string }
  | { kind: 'children'; path: string; key: string };

export function parseNeeds(patterns: readonly string[]): NeedSpec[] {
  const specs = patterns.map(parseNeedPattern);
  const seen = new Set<string>();
  for (const s of specs) {
    if (seen.has(s.key)) throw new Error(`Duplicate need key "${s.key}"`);
    seen.add(s.key);
  }
  return specs;
}

export function getActionNeeds(type: TypeId, action: string): NeedSpec[] {
  return (getMeta(type, `action:${action}`)?.needs as NeedSpec[] | undefined) ?? [];
}

// ── Pattern parsing ──

export function parseNeedPattern(p: string): NeedSpec {
  if (p.startsWith('@')) return { kind: 'field-ref', field: p.slice(1), key: p.slice(1) };
  if (p.endsWith('/*')) return { kind: 'children', path: p.slice(0, -2), key: basename(p.slice(0, -2)) };
  if (p[0] === '/' || p.startsWith('./') || p.startsWith('../')) return { kind: 'path', path: p, key: basename(p) };
  return { kind: 'sibling', name: p, key: p };
}
