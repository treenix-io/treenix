// $ref + $map evaluator
// Resolves source from $ref, applies $map pipeline
// #field (self) and #/path.field (external) args resolved from context

import type { NodeData, Ref } from '@treenity/core/core';
import { isRefArg, type MapExpr, parseMapExpr, type PipeArg } from './parse';
import { getPipe } from './pipes';

export type BindCtx = {
  getNode: (path: string) => NodeData | undefined;
  getChildren: (path: string) => NodeData[];
};

// Collection pipe names — when first step is one of these, resolve source as children
const COLLECTION_PIPES = new Set(['last', 'first', 'count', 'avg', 'max', 'min', 'sum', 'map']);

// Parsed expression cache
const exprCache = new Map<string, MapExpr>();

function getCachedExpr(map: string): MapExpr {
  let expr = exprCache.get(map);
  if (!expr) {
    expr = parseMapExpr(map);
    exprCache.set(map, expr);
  }
  return expr;
}

/** Resolve a pipe argument — ref args looked up from context, scalars pass through */
function resolveArg(arg: PipeArg, ctx: BindCtx, refPath: string): unknown {
  if (!isRefArg(arg)) return arg;
  const path = arg.$ref === '.' ? refPath : arg.$ref;
  let val: unknown = ctx.getNode(path);
  for (const f of arg.fields) {
    if (val == null || typeof val !== 'object') return undefined;
    val = (val as Record<string, unknown>)[f];
  }
  return val;
}

export function evaluateRef(ref: Ref, ctx: BindCtx): unknown {
  // Plain ref without $map — resolve to node
  if (!ref.$map) {
    return ctx.getNode(ref.$ref);
  }

  const expr = getCachedExpr(ref.$map);
  const firstStep = expr.steps[0];

  // Determine source: children (if first pipe is collection) or single node
  let value: unknown;
  if (firstStep?.type === 'pipe' && COLLECTION_PIPES.has(firstStep.name)) {
    value = ctx.getChildren(ref.$ref);
  } else {
    value = ctx.getNode(ref.$ref);
  }

  // Apply pipeline left-to-right
  for (const step of expr.steps) {
    if (value === undefined || value === null) return undefined;

    if (step.type === 'field') {
      value = (value as Record<string, unknown>)[step.name];
    } else {
      const fn = getPipe(step.name);
      if (!fn) {
        console.warn(`[bind] unknown pipe: ${step.name}`);
        return undefined;
      }
      const resolved = step.args.map(a => resolveArg(a, ctx, ref.$ref));
      value = fn(value, ...resolved);
    }
  }

  return value;
}

/** Check if first pipe in $map is a collection pipe (needs children subscription) */
export function isCollectionRef(ref: Ref): boolean {
  if (!ref.$map) return false;
  const expr = getCachedExpr(ref.$map);
  const first = expr.steps[0];
  return first?.type === 'pipe' && COLLECTION_PIPES.has(first.name);
}

/** Check if $map contains `once` pipe — disables reactive subscription */
export function hasOnce(ref: Ref): boolean {
  if (!ref.$map) return false;
  const expr = getCachedExpr(ref.$map);
  return expr.steps.some(s => s.type === 'pipe' && s.name === 'once');
}

/** Extract all external #/path refs from a $map expression (for subscriptions) */
export function extractArgPaths(ref: Ref): string[] {
  if (!ref.$map) return [];
  const expr = getCachedExpr(ref.$map);
  const paths: string[] = [];
  for (const step of expr.steps) {
    if (step.type === 'pipe') {
      for (const arg of step.args) {
        if (isRefArg(arg) && arg.$ref !== '.') {
          paths.push(arg.$ref);
        }
      }
    }
  }
  return paths;
}
