import { mapNodeForSift } from '#kernel/store/keys';
// Treenix Query Tree — Layer 1
// Virtual filtered view over a parent tree's children.
// Used by t.mount.query to create virtual folders (e.g., /orders/incoming shows orders where status.value === 'incoming').

import { type NodeData } from '#core';
import { KernelError } from '#errors';
import { assertSafeSiftQuery, createSiftTest, mapSiftQuery } from '#kernel/expr';
import { exprWork } from '#kernel/eval';
import { DEFAULT_LIMITS } from '#kernel/types';
import type { QueryConfig } from '#kernel/query';
import { type Tree } from './index';

export function matchesFilter(node: NodeData, match: Record<string, unknown>): boolean {
  return createSiftTest(match, DEFAULT_LIMITS)(mapNodeForSift(node), exprWork(DEFAULT_LIMITS));
}

export function createQueryTree(config: QueryConfig, parentStore: Tree): Tree {
  return {
    async get(path, ctx) {
      return parentStore.get(path, ctx);
    },

    // RAW-tree reads only (systemTree, internal services): the public ACL
    // read path resolves query mounts into ReadPlans BEFORE the raw tree is
    // consulted (resolveReadPlan), so this adapter never sees client traffic.
    async getChildren(_path, opts, ctx) {
      const mappedQuery = mapSiftQuery(config.match) as Record<string, unknown>;
      const mergedQuery = opts?.query ? { $and: [opts.query, mappedQuery] } : mappedQuery;
      // Judged here, whole: a parent that hands the query to its database compiles no sift.
      assertSafeSiftQuery(mergedQuery, DEFAULT_LIMITS);
      return parentStore.getChildren(config.source, { ...opts, depth: 1, query: mergedQuery }, ctx);
    },

    async set() {
      throw new KernelError('FORBIDDEN', 'Query mount is read-only: writes not supported');
    },

    async remove() {
      throw new KernelError('FORBIDDEN', 'Query mount is read-only: removes not supported');
    },

    async patch() {
      throw new KernelError('FORBIDDEN', 'Query mount is read-only: patches not supported');
    },
  };
}
