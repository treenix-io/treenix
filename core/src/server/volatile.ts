// Treenix Volatile Nodes — Layer 3
// Nodes with $volatile go to memory, rest to backing tree.
// Cascade: $volatile on instance > register(type, 'volatile') > false

import { type NodeData, resolve as resolveHandler } from '#core';
import { createFilterTree, createMemoryTree, type Tree } from '#tree';

declare module '#core/context' {
  interface ContextHandlers {
    volatile: () => boolean;
  }
}

export function isVolatile(node: NodeData): boolean {
  if ('$volatile' in node) return !!node.$volatile;
  return !!resolveHandler(node.$type, 'volatile');
}

export function extractPaths(result: unknown): string[] {
  if (!result || typeof result !== 'object') return [];
  const r = result as Record<string, unknown>;
  if (Array.isArray(r.items))
    return (r.items as Record<string, unknown>[])
      .filter((n) => typeof n?.$path === 'string')
      .map((n) => n.$path as string);
  if (typeof r.$path === 'string') return [r.$path];
  return [];
}

export function withVolatile(tree: Tree): Tree {
  return createFilterTree(createMemoryTree(), tree, isVolatile);
}
