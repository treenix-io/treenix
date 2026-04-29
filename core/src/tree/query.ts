// Treenix Query Tree — Layer 1
// Virtual filtered view over a parent tree's children.
// Used by t.mount.query to create virtual folders (e.g., /orders/incoming shows orders where status.value === 'incoming').

import { type NodeData, toStorageKeys } from '#core';
import sift from 'sift';
import { type Tree } from './index';

export type QueryConfig = {
  source: string;
  match: Record<string, unknown>;
};

export function mapSiftQuery(q: unknown): unknown {
  if (Array.isArray(q)) return q.map(mapSiftQuery);
  if (q && typeof q === 'object' && q.constructor === Object) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(q)) {
      let newKey = k;
      if (k === '$type') newKey = '_type';
      else if (k === '$path') newKey = '_path';
      else if (k === '$acl') newKey = '_acl';
      else if (k === '$owner') newKey = '_owner';
      else if (k === '$rev') newKey = '_rev';
      out[newKey] = mapSiftQuery(v);
    }
    return out;
  }
  return q;
}

export function mapNodeForSift(node: NodeData): Record<string, unknown> {
  return toStorageKeys(node);
}

export function createSiftTest(match: Record<string, unknown>): (node: Record<string, unknown>) => boolean {
  return sift(mapSiftQuery(match) as Record<string, unknown>);
}

export function matchesFilter(node: NodeData, match: Record<string, unknown>): boolean {
  return sift(mapSiftQuery(match))(mapNodeForSift(node));
}

export function createQueryTree(config: QueryConfig, parentStore: Tree): Tree {
  return {
    async get(path, ctx) {
      return parentStore.get(path, ctx);
    },

    async getChildren(_path, opts, ctx) {
      // Pass ctx properly to ensure auth/context flows through the query mount
      const mappedQuery = mapSiftQuery(config.match) as Record<string, unknown>;
      const mergedQuery = opts?.query ? { $and: [opts.query, mappedQuery] } : mappedQuery;
      const res = await parentStore.getChildren(config.source, { ...opts, depth: 1, query: mergedQuery }, ctx);
      return { ...res, queryMount: { source: config.source, match: config.match } };
    },

    async set() {
      throw new Error('Query mount is read-only: writes not supported');
    },

    async remove() {
      throw new Error('Query mount is read-only: removes not supported');
    },

    async patch() {
      throw new Error('Query mount is read-only: patches not supported');
    },
  };
}
