// MindMap View — radial tree visualization of Treenity nodes
// Activated by adding mindmap.map component to any node

import { register } from '@treenity/core/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RadialTree } from './radial-tree';
import { MindMapSidebar } from './sidebar';
import { type TreeItem, useTreeData } from './use-tree-data';
import './mindmap.css';

// Deterministic branch color palette — visually distinct hues
const PALETTE = [
  '#6366f1', // indigo
  '#f59e0b', // amber
  '#10b981', // emerald
  '#ef4444', // red
  '#8b5cf6', // violet
  '#06b6d4', // cyan
  '#f97316', // orange
  '#ec4899', // pink
  '#14b8a6', // teal
  '#84cc16', // lime
];

function hashColor(str: string, idx: number): string {
  return PALETTE[idx % PALETTE.length];
}

// Build color map: each top-level branch gets a unique color,
// children inherit parent branch color
function buildBranchColors(tree: TreeItem | null): Map<string, string> {
  const colors = new Map<string, string>();
  if (!tree) return colors;

  colors.set(tree.path, 'var(--text)'); // root gets neutral color

  tree.children.forEach((child, i) => {
    const color = hashColor(child.path, i);
    assignColor(child, color, colors);
  });

  return colors;
}

function assignColor(item: TreeItem, color: string, map: Map<string, string>) {
  map.set(item.path, color);
  for (const child of item.children) {
    assignColor(child, color, map);
  }
}

// Find a component by $type on a node
function findComp(node: any, type: string): any {
  for (const [k, v] of Object.entries(node)) {
    if (k.startsWith('$')) continue;
    if (typeof v === 'object' && v !== null && (v as any).$type === type) return v;
  }
  return null;
}

type Props = { value: any };

function MindMapView({ value }: Props) {
  const config = findComp(value, 'mindmap.map');
  const rootPath = (config?.root || value.$path) as string;
  const maxChildren = config?.maxChildren ?? 50;
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([rootPath]));
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState({ w: 800, h: 600 });

  // Measure container
  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect;
      setDims({ w: width, h: height });
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  // Fetch tree data
  const tree = useTreeData(rootPath, expanded, maxChildren);

  // Branch colors
  const branchColors = useMemo(() => buildBranchColors(tree), [tree]);

  // Handlers
  const handleSelect = useCallback((path: string) => {
    setSelectedPath(prev => prev === path ? null : path);
  }, []);

  const handleToggle = useCallback((path: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(path)) {
        // Collapse: remove this path and all descendants
        for (const p of next) {
          if (p === path || p.startsWith(path + '/')) next.delete(p);
        }
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const handleCloseSidebar = useCallback(() => setSelectedPath(null), []);

  // Navigate to node in Inspector (use URL)
  const handleNavigate = useCallback((path: string) => {
    window.history.pushState(null, '', '/t' + path);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      if (e.key === 'Enter' && selectedPath) {
        e.preventDefault();
        handleToggle(selectedPath);
      }
      if (e.key === 'Backspace' && selectedPath) {
        e.preventDefault();
        // Collapse selected or navigate to parent
        if (expanded.has(selectedPath)) {
          handleToggle(selectedPath);
        } else {
          const parentIdx = selectedPath.lastIndexOf('/');
          const parent = parentIdx <= 0 ? '/' : selectedPath.slice(0, parentIdx);
          setSelectedPath(parent);
        }
      }
      if (e.key === 'Escape') {
        setSelectedPath(null);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [selectedPath, expanded, handleToggle]);

  if (!tree) {
    return (
      <div className="mm-container" ref={containerRef}>
        <div className="flex items-center justify-center flex-1 text-[var(--text-3)] text-sm">
          Loading tree...
        </div>
      </div>
    );
  }

  return (
    <div className="mm-container" ref={containerRef}>
      <RadialTree
        data={tree}
        selectedPath={selectedPath}
        onSelect={handleSelect}
        onToggle={handleToggle}
        branchColors={branchColors}
        width={selectedPath ? dims.w - 280 : dims.w}
        height={dims.h}
      />

      {selectedPath && (
        <MindMapSidebar
          path={selectedPath}
          onClose={handleCloseSidebar}
          onNavigate={handleNavigate}
        />
      )}
    </div>
  );
}

// Component-type registration: makes getContextsForType('mindmap.map') discover 'react:mindmap'
register('mindmap.map', 'react:mindmap', MindMapView as any);
// Default fallback: any node type resolves to MindMapView in react:mindmap context
register('default', 'react:mindmap', MindMapView as any);
