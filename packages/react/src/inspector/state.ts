// Inspector store — module-level state shared across inspector.{tree,props,view}.
// Kept client-side and out of the tree protocol. Selectors via useSyncExternalStore
// so each consumer subscribes to its slice and avoids unrelated re-renders.
//
// When state needs to live on the server (cross-device sync, AI visibility),
// replace this module's internals with `tree.execute(...)` against a node path
// — the public API (useInspectorState + inspectorActions) won't change.

import { useSyncExternalStore } from 'react';

export type InspectorState = {
  selectedPath: string;
  root: string;
  expanded: string[];
  filter: string;
  showHidden: boolean;
  sidebarCollapsed: boolean;
};

const initial: InspectorState = {
  selectedPath: '/',
  root: '/',
  expanded: [],
  filter: '',
  showHidden: false,
  sidebarCollapsed: false,
};

let state: InspectorState = initial;
const listeners = new Set<() => void>();

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
};

const notify = () => { for (const cb of listeners) cb(); };

const set = (patch: Partial<InspectorState>) => {
  state = { ...state, ...patch };
  notify();
};

export function useInspectorState<T>(select: (s: InspectorState) => T): T {
  return useSyncExternalStore(subscribe, () => select(state));
}

export function getInspectorState(): InspectorState { return state; }

export const inspectorActions = {
  select: (path: string) => set({ selectedPath: path }),
  setRoot: (path: string) => set({ root: path }),
  toggleExpand: (path: string) => {
    const has = state.expanded.includes(path);
    set({ expanded: has ? state.expanded.filter(p => p !== path) : [...state.expanded, path] });
  },
  setExpanded: (paths: string[]) => set({ expanded: paths }),
  setFilter: (text: string) => set({ filter: text }),
  toggleHidden: () => set({ showHidden: !state.showHidden }),
  toggleSidebar: () => set({ sidebarCollapsed: !state.sidebarCollapsed }),
  // Reset for tests — not for production callers
  __reset: () => { state = initial; notify(); },
};
