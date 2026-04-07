// Draft editing — create render-compatible objects outside the tree.
// Drafts are local-only: no cache, no IDB, no server sync.
// Commit persists to the real tree via createNode().
// See docs/research/drafts/ for architecture.

import { makeNode, type NodeData } from '@treenity/core';
import { stampNode } from '#symbols';
import { createNode } from '#hooks';
import { proxy, useSnapshot } from 'valtio';
import { useCallback, useMemo } from 'react';

export type DraftHandle = {
  /** Current draft node (snapshot), or null when inactive */
  node: NodeData | null;
  /** Create a new draft of the given type with optional initial data */
  create: (initial?: Record<string, unknown>) => void;
  /** Partial update — direct mutation, no spread needed */
  onChange: (partial: Record<string, unknown>) => void;
  /** Persist draft to a real tree path, then close */
  commit: (realPath: string) => Promise<void>;
  /** Discard draft without persisting */
  close: () => void;
};

export function useDraft(type: string): DraftHandle {
  const state = useMemo(() => proxy<{ node: NodeData | null }>({ node: null }), []);
  const snap = useSnapshot(state);

  const create = useCallback((initial?: Record<string, unknown>) => {
    const n = makeNode(`/draft/${crypto.randomUUID()}`, type, initial);
    stampNode(n);
    state.node = n;
  }, [type, state]);

  const onChange = useCallback((partial: Record<string, unknown>) => {
    if (state.node) Object.assign(state.node, partial);
  }, [state]);

  const commit = useCallback(async (realPath: string) => {
    const n = state.node;
    if (!n) return;
    const data: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(n)) {
      if (!k.startsWith('$')) data[k] = v;
    }
    await createNode(realPath, type, data);
    state.node = null;
  }, [type, state]);

  const close = useCallback(() => { state.node = null; }, [state]);

  // useSnapshot returns deeply readonly — cast to mutable NodeData for Render compatibility
  // (same pattern as bind/hook.ts:24)
  const node = snap.node as NodeData | null;

  return { node, create, onChange, commit, close };
}
