// In-memory index of /sys/routes/* nodes for SSR resolution.
//
// Owns:
//   - exact-match map (URL key → NodeData)
//   - wildcard list, sorted longest-prefix-first
// Reuses the pure resolver from @treenx/react so client + server agree byte-for-byte.
//
// Lifecycle: construct empty, call hydrate(nodes) at boot, then ingest(node) /
// remove(path) on tree mutations. Wiring to a watcher is a Phase 5 concern.

import type { NodeData } from '@treenx/core';
import type { Reader } from '@treenx/core/kernel/types';
import type { PresentationNode } from '@treenx/react/tree/presentation';
import { KernelError } from '@treenx/core/errors';
import { resolveRoute, type ResolveResult } from '@treenx/react/router/route-resolve';

/** Traverse native immediate-child pages under a bounded route inventory. */
export async function fetchRouteNodes(reader: Reader): Promise<PresentationNode[]> {
  const nodes: PresentationNode[] = [], pending = ['/sys/routes'];
  for (let index = 0; index < pending.length; index++) {
    let after: string | undefined;
    do {
      const result = await reader.read({ children: pending[index], window: { limit: 100, ...(after === undefined ? {} : { after }) } });
      const copies = new Map(result.copies.map(copy => ['node' in copy ? copy.node.$id : copy.id, copy]));
      for (const id of result.list) {
        const copy = copies.get(id);
        if (copy === undefined) throw new KernelError('INVALID', 'Route member has no native copy');
        if ('error' in copy) throw copy.error;
        if (nodes.length >= 1000) throw new KernelError('BUDGET', 'Route inventory exceeds its bound');
        nodes.push(copy.node);
        pending.push(copy.node.$path);
      }
      after = result.next;
    } while (after !== undefined);
  }
  return nodes;
}

export class RouteIndex {
  private byPath = new Map<string, PresentationNode>();

  /** Replace all known routes (initial build / full rebuild). */
  hydrate(nodes: readonly PresentationNode[]): void {
    this.byPath.clear();
    for (const n of nodes) this.ingest(n);
  }

  /** Insert or replace a single route node. No-op for non-/sys/routes paths. */
  ingest(node: PresentationNode): void {
    if (!node.$path?.startsWith('/sys/routes/')) return;
    this.byPath.set(node.$path, node);
  }

  /** Remove a route by path. */
  remove(path: string): void {
    this.byPath.delete(path);
  }

  /** Number of route nodes currently indexed. */
  size(): number {
    return this.byPath.size;
  }

  /** Resolve a URL against the index. */
  resolve(urlPath: string): ResolveResult<PresentationNode> {
    return resolveRoute(urlPath, [...this.byPath.values()]);
  }
}
