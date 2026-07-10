import { AnyType, type ComponentData, getComponent, getComponentByName, getMeta, type NodeData, type TypeId } from '#core';
import { basename, dirname, join } from '#core/path';
import { type Tree } from '#tree';

// ── Types ──

export type NeedSpec =
  | { kind: 'sibling'; name: string; key: string }
  | { kind: 'field-ref'; field: string; key: string }
  | { kind: 'path'; path: string; key: string }
  | { kind: 'children'; path: string; key: string };

export type ResolvedDeps = Record<string, ComponentData | NodeData | NodeData[]>;

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
  node: NodeData, componentName: string, actionName: string, tree: Tree,
): Promise<ResolvedDeps> {
  const cv = getComponent(node, AnyType, componentName);
  if (!cv) throw new Error(`Component "${componentName}" not found on ${node.$path}`);

  const specs = getActionNeeds(cv.$type, actionName);
  if (!specs.length) return {};

  const deps: ResolvedDeps = {};
  const async_: Promise<void>[] = [];

  for (const s of specs) {
    if (s.kind === 'sibling') {
      const v = getComponentByName(node, s.name);
      if (!v) throw new Error(`Needed sibling "${s.name}" not found on ${node.$path}`);
      deps[s.key] = v;
      continue;
    }

    // cross-node: resolve target path, then fetch
    let target: string;
    if (s.kind === 'field-ref') {
      const raw = (cv as Record<string, unknown>)[s.field];
      if (typeof raw !== 'string') throw new Error(`Field "${s.field}" on ${componentName} is not a path string`);
      target = raw;
    } else {
      target = resolvePath(node.$path, s.path);
    }

    if (s.kind === 'children') {
      async_.push(tree.getChildren(target).then(({ items }) => { deps[s.key] = items; }));
    } else {
      async_.push(tree.get(target).then(n => {
        if (!n) throw new Error(`Dep "${s.key}" → "${target}" not found`);
        deps[s.key] = n;
      }));
    }
  }

  if (async_.length) await Promise.all(async_);
  return deps;
}
