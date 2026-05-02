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
import { resolveRoute, type ResolveResult } from '@treenx/react/tree/route-resolve';

export class RouteIndex {
  private byPath = new Map<string, NodeData>();

  /** Replace all known routes (initial build / full rebuild). */
  hydrate(nodes: readonly NodeData[]): void {
    this.byPath.clear();
    for (const n of nodes) this.ingest(n);
  }

  /** Insert or replace a single route node. No-op for non-/sys/routes paths. */
  ingest(node: NodeData): void {
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
  resolve(urlPath: string): ResolveResult {
    return resolveRoute(urlPath, [...this.byPath.values()]);
  }
}
