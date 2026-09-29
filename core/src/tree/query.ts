// Treenix Query Tree — Layer 1
// Virtual filtered view over a parent tree's children.
// Used by t.mount.query to create virtual folders (e.g., /orders/incoming shows orders where status.value === 'incoming').

import { type NodeData } from '#core';
import { KernelError } from '#errors';
import { assertSafeSiftQuery, createSiftTest, mapSiftQuery } from '#kernel/expr';
import { DEFAULT_LIMITS } from '#kernel/types';
import { isRecord } from '#util/is-record';
import { mapNodeForSift, type Tree } from './index';

export type QueryConfig = {
  source: string;
  match: Record<string, unknown>;
};

/** Validate a t.mount.query component — shared by the mount adapter and the
 *  ACL read planner (resolve-plan.ts) so both accept and reject the same
 *  configs. An empty `match` is a legitimate match-all; a missing one is not. */
export function queryConfigOf(comp: Record<string, unknown>, at: string): QueryConfig {
  const { source, match } = comp;
  if (typeof source !== 'string' || !source.startsWith('/')) {
    throw new KernelError('INVALID', `query mount at ${at}: source must be an absolute path`);
  }
  if (!isRecord(match)) throw new KernelError('INVALID', `query mount at ${at}: match must be an object`);
  return { source, match };
}

export function matchesFilter(node: NodeData, match: Record<string, unknown>): boolean {
  return createSiftTest(match, DEFAULT_LIMITS)(mapNodeForSift(node));
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
      if (opts?.query) assertSafeSiftQuery(opts.query, DEFAULT_LIMITS);
      const mappedQuery = mapSiftQuery(config.match) as Record<string, unknown>;
      const mergedQuery = opts?.query ? { $and: [opts.query, mappedQuery] } : mappedQuery;
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
