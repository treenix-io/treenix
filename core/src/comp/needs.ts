import { type ComponentData, getCompByKey, isComponent, type NodeData } from '#core';
import { basename, dirname, join } from '#core/path';
import { type Tree } from '#tree';

// ── Types ──

export type NeedSpec =
  | { kind: 'sibling'; name: string; key: string }
  | { kind: 'field-ref'; field: string; key: string }
  | { kind: 'path'; path: string; key: string }
  | { kind: 'children'; path: string; key: string };

export type ResolvedDeps = Record<string, ComponentData | NodeData | NodeData[]>;

// ── Needs store ──
// Local map keyed by type@action. Populated by registerActionNeeds (called from registerType).
// Separate from registry meta because needs are registered before actions exist in the registry.

const needsMap = new Map<string, NeedSpec[]>();

export function registerActionNeeds(type: string, action: string, patterns: string[]): void {
  needsMap.set(`${type}@${action}`, patterns.map(parseNeedPattern));
}

export function getActionNeeds(type: string, action: string): NeedSpec[] {
  return needsMap.get(`${type}@${action}`)
    ?? needsMap.get(`${type}@*`)
    ?? [];
}

// ── Pattern parsing ──

export function parseNeedPattern(p: string): NeedSpec {
  if (p.startsWith('@')) return { kind: 'field-ref', field: p.slice(1), key: p.slice(1) };
  if (p.endsWith('/*')) return { kind: 'children', path: p.slice(0, -2), key: basename(p.slice(0, -2)) };
  if (p[0] === '/' || p.startsWith('./') || p.startsWith('../')) return { kind: 'path', path: p, key: basename(p) };
  return { kind: 'sibling', name: p, key: p };
}

function resolvePath(base: string, rel: string): string {
  if (rel[0] === '/') return rel;
  if (rel.startsWith('./')) return join(base, rel.slice(2));
  if (!rel.startsWith('../')) throw new Error(`Invalid relative path: ${rel}`);
  const parent = dirname(base);
  if (!parent) throw new Error(`Cannot resolve "../" from root`);
  return join(parent, rel.slice(3));
}

// ── Dependency collection ──

export async function collectDeps(
  node: NodeData, componentName: string, actionName: string, store: Tree,
): Promise<ResolvedDeps> {
  const cv = getCompByKey(node, componentName);
  if (!cv) throw new Error(`Component "${componentName}" not found on ${node.$path}`);

  const specs = getActionNeeds(cv.$type, actionName);
  if (!specs.length) return {};

  const deps: ResolvedDeps = {};
  const async_: Promise<void>[] = [];

  for (const s of specs) {
    if (deps[s.key] !== undefined) throw new Error(`Duplicate dep key "${s.key}"`);

    if (s.kind === 'sibling') {
      const v = node[s.name];
      if (!isComponent(v)) throw new Error(`Needed sibling "${s.name}" not found on ${node.$path}`);
      deps[s.key] = v;
      continue;
    }

    // cross-node: resolve target path, then fetch
    let target: string;
    if (s.kind === 'field-ref') {
      target = (cv as Record<string, unknown>)[s.field] as string;
      if (typeof target !== 'string') throw new Error(`Field "${s.field}" on ${componentName} is not a path string`);
    } else {
      target = resolvePath(node.$path, s.path);
    }

    if (s.kind === 'children') {
      async_.push(store.getChildren(target).then(({ items }) => { deps[s.key] = items; }));
    } else {
      async_.push(store.get(target).then(n => {
        if (!n) throw new Error(`Dep "${s.key}" → "${target}" not found`);
        deps[s.key] = n;
      }));
    }
  }

  if (async_.length) await Promise.all(async_);
  return deps;
}

// ── Backward compat ──

export function collectSiblings(node: NodeData, componentName: string): Record<string, ComponentData> {
  const cv = getCompByKey(node, componentName);
  if (!cv) throw new Error(`Component "${componentName}" not found on ${node.$path}`);

  const specs = getActionNeeds(cv.$type, '*');
  if (!specs.length) return {};

  const out: Record<string, ComponentData> = {};
  for (const s of specs) {
    if (s.kind !== 'sibling') continue;
    const v = node[s.name];
    if (!isComponent(v)) throw new Error(`Needed component "${s.name}" not found on ${node.$path}`);
    out[s.key] = v;
  }
  return out;
}
