// ServerTreeSource — TreeSource implementation for SSR.
//
// Hooks call mountPath / mountChildren synchronously while React renders.
// On the server we can't actually fetch in those calls — we record the
// requested paths as PENDING and return inert handles. After React's render
// pass returns a string, the SSR pipeline calls flushPending() which awaits
// the underlying tree.get / tree.getChildren for every recorded path and
// stores results locally. Then the next render pass sees data.
//
// Render-loop bound: handler.ts caps at N passes; if pendingCount stays
// nonzero after the budget, throws SsrDataUnresolved.

import type { NodeData } from '@treenx/core';
import type { Tree } from '@treenx/core/tree';
import {
  EMPTY_PATH_SNAPSHOT,
  EMPTY_CHILDREN_SNAPSHOT,
  NOOP_PATH_HANDLE,
  NOOP_CHILDREN_HANDLE,
  type ChildrenSnapshot,
  type ChildrenHandle,
  type PathHandle,
  type PathSnapshot,
  type TreeSource,
} from '@treenx/react/tree/tree-source';

const LOADING_PATH: PathSnapshot = Object.freeze({ data: undefined, status: 'loading', error: null });

const LOADING_CHILDREN: ChildrenSnapshot = Object.freeze({
  data: [],
  phase: 'initial',
  total: null,
  truncated: null,
  error: null,
});

export class ServerTreeSource implements TreeSource {
  private paths = new Map<string, PathSnapshot>();
  private children = new Map<string, ChildrenSnapshot>();
  private pendingPaths = new Set<string>();
  private pendingChildren = new Set<string>();

  constructor(private tree: Tree, private ctx?: unknown) {}

  // ── snapshots ──

  getPathSnapshot(path: string): PathSnapshot {
    if (!path) return EMPTY_PATH_SNAPSHOT;
    const cached = this.paths.get(path);
    if (cached) return cached;
    this.pendingPaths.add(path);
    this.paths.set(path, LOADING_PATH);
    return LOADING_PATH;
  }

  getChildrenSnapshot(path: string): ChildrenSnapshot {
    if (!path) return EMPTY_CHILDREN_SNAPSHOT;
    const cached = this.children.get(path);
    if (cached) return cached;
    this.pendingChildren.add(path);
    this.children.set(path, LOADING_CHILDREN);
    return LOADING_CHILDREN;
  }

  // ── change notification (no-op on server) ──

  subscribePath(_path: string, _cb: () => void): () => void {
    return noop;
  }

  subscribeChildren(_path: string, _cb: () => void): () => void {
    return noop;
  }

  // ── lifecycle (record pending; never effectful) ──

  mountPath(path: string): PathHandle {
    if (path) this.getPathSnapshot(path);
    return NOOP_PATH_HANDLE;
  }

  mountChildren(path: string): ChildrenHandle {
    if (path) this.getChildrenSnapshot(path);
    return NOOP_CHILDREN_HANDLE;
  }

  // ── render-loop driver ──

  pendingCount(): number {
    return this.pendingPaths.size + this.pendingChildren.size;
  }

  /** Return the still-pending paths/children for diagnostics. */
  pending(): { paths: string[]; children: string[] } {
    return { paths: [...this.pendingPaths], children: [...this.pendingChildren] };
  }

  /** Resolve every recorded pending entry concurrently and store results. */
  async flushPending(): Promise<void> {
    const paths = [...this.pendingPaths];
    const children = [...this.pendingChildren];
    this.pendingPaths.clear();
    this.pendingChildren.clear();
    await Promise.all([
      ...paths.map(p => this.loadPath(p)),
      ...children.map(p => this.loadChildren(p)),
    ]);
  }

  private async loadPath(path: string): Promise<void> {
    try {
      const data = await this.tree.get(path, this.ctx);
      this.paths.set(path, Object.freeze({
        data,
        status: data ? 'ready' : 'not_found',
        error: null,
      }));
    } catch (err) {
      this.paths.set(path, Object.freeze({
        data: undefined,
        status: 'error',
        error: err instanceof Error ? err : new Error(String(err)),
      }));
    }
  }

  private async loadChildren(path: string): Promise<void> {
    try {
      const page = await this.tree.getChildren(path, undefined, this.ctx);
      this.children.set(path, Object.freeze({
        data: page.items,
        phase: 'ready',
        total: page.total,
        truncated: page.truncated ?? false,
        error: null,
      }));
    } catch (err) {
      this.children.set(path, Object.freeze({
        data: [],
        phase: 'error',
        total: null,
        truncated: null,
        error: err instanceof Error ? err : new Error(String(err)),
      }));
    }
  }

  /** Snapshot for hydration: what we ended up with. */
  serialize(): { paths: Record<string, NodeData | null>; children: Record<string, NodeData[]> } {
    const paths: Record<string, NodeData | null> = {};
    for (const [k, v] of this.paths) {
      if (v.status === 'ready' || v.status === 'not_found') {
        paths[k] = v.data ?? null;
      }
    }
    const children: Record<string, NodeData[]> = {};
    for (const [k, v] of this.children) {
      if (v.phase === 'ready') children[k] = v.data;
    }
    return { paths, children };
  }
}

const noop = () => {};
