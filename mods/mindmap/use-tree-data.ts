// useTreeData — bridge between Treenity cache and D3 hierarchy
// Lazily loads children for expanded paths, builds nested tree structure

import type { NodeData } from '@treenity/core/core';
import * as cache from '@treenity/react/cache';
import { getComponents } from '@treenity/react/mods/editor-ui/node-utils';
import { trpc } from '@treenity/react/trpc';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

export type TreeItem = {
  path: string;
  name: string;
  type: string;
  node: NodeData;
  components: [string, Record<string, unknown>][];
  childCount: number;
  children: TreeItem[];
  expanded: boolean;
  depth: number;
};

// Fetch children for a path if not already in cache
function ensureChildren(path: string) {
  const existing = cache.getChildren(path);
  if (existing.length) return;
  trpc.getChildren
    .query({ path, watch: true, watchNew: true })
    .then((r: any) => cache.putMany(r.items as NodeData[], path));
}

function basename(path: string): string {
  if (path === '/') return '/';
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}

function buildTree(
  rootNode: NodeData,
  expanded: Set<string>,
  depth: number,
  maxChildren: number,
): TreeItem {
  const children = cache.getChildren(rootNode.$path);
  const isExpanded = expanded.has(rootNode.$path);
  const comps = getComponents(rootNode);

  const childItems: TreeItem[] = [];
  if (isExpanded) {
    const limited = children.slice(0, maxChildren);
    for (const child of limited) {
      childItems.push(buildTree(child, expanded, depth + 1, maxChildren));
    }
    // Overflow indicator
    if (children.length > maxChildren) {
      childItems.push({
        path: rootNode.$path + '/__more__',
        name: `+${children.length - maxChildren} more`,
        type: '__overflow__',
        node: rootNode,
        components: [],
        childCount: 0,
        children: [],
        expanded: false,
        depth: depth + 1,
      });
    }
  }

  return {
    path: rootNode.$path,
    name: basename(rootNode.$path),
    type: rootNode.$type,
    node: rootNode,
    components: comps,
    childCount: children.length,
    children: childItems,
    expanded: isExpanded,
    depth,
  };
}

export function useTreeData(rootPath: string, expanded: Set<string>, maxChildren = 50) {
  const [version, setVersion] = useState(0);
  const loadedRef = useRef<string | null>(null);

  // Initial fetch for root's children
  useEffect(() => {
    if (loadedRef.current === rootPath) return;
    loadedRef.current = rootPath;
    ensureChildren(rootPath);
  }, [rootPath]);

  // Fetch children for newly expanded paths
  useEffect(() => {
    for (const p of expanded) ensureChildren(p);
  }, [expanded]);

  // Subscribe to children changes for root + all expanded paths
  useEffect(() => {
    const paths = [rootPath, ...expanded];
    const unsubs = paths.map(p =>
      cache.subscribeChildren(p, () => setVersion(v => v + 1)),
    );
    return () => unsubs.forEach(u => u());
  }, [rootPath, [...expanded].join(',')]);

  // Subscribe to root node changes
  useEffect(() => {
    return cache.subscribePath(rootPath, () => setVersion(v => v + 1));
  }, [rootPath]);

  // Get root node from cache
  const rootNode = useSyncExternalStore(
    useCallback((cb: () => void) => cache.subscribePath(rootPath, cb), [rootPath]),
    useCallback(() => cache.get(rootPath), [rootPath]),
  );

  // Build hierarchy from cache data
  const tree = useMemo(() => {
    if (!rootNode) return null;
    return buildTree(rootNode, expanded, 0, maxChildren);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootNode, expanded, version, maxChildren]);

  return tree;
}
