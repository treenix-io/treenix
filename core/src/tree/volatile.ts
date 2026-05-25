// Treenix Volatile Nodes — Layer 3
// Nodes with $volatile go to memory, rest to backing tree.
// Cascade: $volatile on instance > register(type, 'volatile') > false

import { type NodeData, resolve as resolveHandler } from '#core';
import { OpError } from '#errors';
import { createFilterTree, createMemoryTree, type Tree } from '#tree';

declare module '#core/context' {
  interface ContextHandlers {
    volatile: () => boolean;
  }
}

export function isVolatile(node: NodeData): boolean {
  if ('$volatile' in node) return !!node.$volatile;
  const handler = resolveHandler(node.$type, 'volatile');
  return handler ? !!handler() : false;
}

// Strict by contract: when result IS a list (`items` array), every item must
// be a node-shape with string `$path`. The action-watch path in trpc consumes
// this — silently dropping malformed items would mask handler bugs and let
// a partial watch set look like the full one. Non-node results (scalar,
// `{count}`, undefined) return `[]` explicitly — that's "nothing to watch",
// not a malformed shape.
export function extractPaths(result: unknown): string[] {
  if (!result || typeof result !== 'object') return [];
  const r = result as Record<string, unknown>;
  if (Array.isArray(r.items)) {
    const items = r.items;
    const paths: string[] = [];
    for (let i = 0; i < items.length; i++) {
      const n = items[i];
      if (!n || typeof n !== 'object' || typeof (n as { $path?: unknown }).$path !== 'string') {
        throw new OpError('BAD_REQUEST', `extractPaths: items[${i}] missing string $path`);
      }
      paths.push((n as { $path: string }).$path);
    }
    return paths;
  }
  if (typeof r.$path === 'string') return [r.$path];
  return [];
}

export function withVolatile(tree: Tree): Tree {
  return createFilterTree(createMemoryTree(), tree, isVolatile);
}
