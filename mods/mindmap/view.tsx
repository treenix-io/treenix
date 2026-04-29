// MindMap View — Miro-style horizontal tree with organic curves
// Each node fetches its own children via useChildren when expanded

import type { NodeData } from '@treenx/core';
import { register } from '@treenx/core';
import type { View } from '@treenx/react';
import { useChildren } from '@treenx/react';
import { trpc } from '@treenx/react';
import { select } from 'd3-selection';
import 'd3-transition';
import { zoom as d3zoom, type D3ZoomEvent, type ZoomBehavior, zoomIdentity } from 'd3-zoom';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type EditingAt, MindMapBranch, MindMapCtx, type MindMapState } from './branch';
import { MindMapSidebar } from './sidebar';
import type { MindMapConfig } from './types';
import './mindmap.css';

const PALETTE = [
  '#6366f1', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6',
  '#06b6d4', '#f97316', '#ec4899', '#14b8a6', '#84cc16',
];

const LEVEL_W = 200;
const SPACING = 36;

function sCurve(dx: number, dy: number): string {
  const cx = dx * 0.5;
  return `M0,0 C${cx},0 ${cx},${dy} ${dx},${dy}`;
}

function basename(path: string): string {
  if (path === '/') return '/';
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}

const MindMapView: View<MindMapConfig> = ({ value, ctx }) => {
  const rootPath = value.root || ctx?.node?.$path || '/';
  const rootName = basename(rootPath);

  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([rootPath]));
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [editingAt, setEditingAt] = useState<EditingAt>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const gRef = useRef<SVGGElement>(null);
  const zoomRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const [dims, setDims] = useState({ w: 800, h: 600 });

  const { data: rootChildren } = useChildren(rootPath, { watch: true, watchNew: true });

  const left = useMemo(() => rootChildren.filter((_, i) => i % 2 === 1), [rootChildren]);
  const right = useMemo(() => rootChildren.filter((_, i) => i % 2 === 0), [rootChildren]);

  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect;
      setDims({ w: width, h: height });
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!svgRef.current || !gRef.current) return;
    const svg = select(svgRef.current);
    const g = select(gRef.current);

    const zoomBehavior = d3zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.1, 4])
      .on('zoom', (event: D3ZoomEvent<SVGSVGElement, unknown>) => g.attr('transform', event.transform.toString()));

    svg.call(zoomBehavior);
    svg.call(zoomBehavior.transform, zoomIdentity.translate(dims.w / 2, dims.h / 2).scale(0.85));
    zoomRef.current = zoomBehavior;

    return () => { svg.on('.zoom', null); };
  }, [dims.w, dims.h]);

  const fitView = useCallback(() => {
    if (!svgRef.current || !zoomRef.current || !gRef.current) return;
    const svg = select(svgRef.current);
    const bounds = gRef.current.getBBox();
    if (!bounds.width || !bounds.height) return;

    const pad = 60;
    const scale = Math.min((dims.w - pad * 2) / bounds.width, (dims.h - pad * 2) / bounds.height, 1.5);
    const tx = dims.w / 2 - (bounds.x + bounds.width / 2) * scale;
    const ty = dims.h / 2 - (bounds.y + bounds.height / 2) * scale;

    svg.transition().duration(400).call(
      zoomRef.current.transform,
      zoomIdentity.translate(tx, ty).scale(scale),
    );
  }, [dims.w, dims.h]);

  const handleToggle = useCallback((path: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(path)) {
        for (const p of next) {
          if (p === path || p.startsWith(path + '/')) next.delete(p);
        }
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const handleSelect = useCallback((path: string) => {
    setSelectedPath(prev => prev === path ? null : path);
  }, []);

  const handleCloseSidebar = useCallback(() => setSelectedPath(null), []);

  const handleNavigate = useCallback((path: string) => {
    window.history.pushState(null, '', '/t' + path);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, []);

  const handleAddChild = useCallback((parentPath: string, side: 'left' | 'right', color: string) => {
    setEditingAt({ parentPath, side, color });
    setExpanded(prev => new Set([...prev, parentPath]));
  }, []);

  const handleCommitAdd = useCallback((parentPath: string, name: string) => {
    const childPath = `${parentPath}/${name}`;
    trpc.set.mutate({ node: { $path: childPath, $type: 'dir' } as NodeData });
    setEditingAt(null);
  }, []);

  const handleCancelAdd = useCallback(() => setEditingAt(null), []);

  const handleDelete = useCallback((path: string) => {
    if (path === rootPath) return;
    if (!confirm(`Delete ${basename(path)}?`)) return;
    trpc.remove.mutate({ path });
    setSelectedPath(null);
  }, [rootPath]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 'Enter' && selectedPath) { e.preventDefault(); handleToggle(selectedPath); }
      if (e.key === 'Escape') setSelectedPath(null);
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedPath && selectedPath !== rootPath) {
        e.preventDefault();
        handleDelete(selectedPath);
      }
      if (e.key === 'Tab' && selectedPath && !editingAt) {
        e.preventDefault();
        handleAddChild(selectedPath, 'right', PALETTE[0]);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [selectedPath, handleToggle, handleDelete, handleAddChild, rootPath, editingAt]);

  const mmState: MindMapState = useMemo(
    () => ({
      expanded, selectedPath, editingAt,
      onToggle: handleToggle, onSelect: handleSelect,
      onAddChild: handleAddChild, onCommitAdd: handleCommitAdd, onCancelAdd: handleCancelAdd,
      onDelete: handleDelete,
    }),
    [expanded, selectedPath, editingAt, handleToggle, handleSelect, handleAddChild, handleCommitAdd, handleCancelAdd, handleDelete],
  );

  const svgW = selectedPath ? dims.w - 280 : dims.w;
  const rootW = rootName.length * 10 + 48;

  return (
    <div className="mm-container" ref={containerRef}>
      <div className="mm-tree-wrap">
        <div className="mm-toolbar">
          <button className="mm-btn" onClick={fitView} title="Fit view">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
            </svg>
          </button>
        </div>

        <svg ref={svgRef} width={svgW} height={dims.h} className="mm-svg">
          <MindMapCtx.Provider value={mmState}>
            <g ref={gRef}>
              {/* Curves from root to right children */}
              {right.map((child, i) => {
                const totalH = (right.length - 1) * SPACING;
                const cy = -totalH / 2 + i * SPACING;
                const color = PALETTE[(i * 2) % PALETTE.length];
                return (
                  <path
                    key={`link-r-${child.$path}`}
                    d={sCurve(LEVEL_W, cy)}
                    fill="none"
                    stroke={color}
                    strokeWidth={3}
                    strokeOpacity={0.6}
                    strokeLinecap="round"
                    className="mm-link"
                  />
                );
              })}

              {/* Curves from root to left children */}
              {left.map((child, i) => {
                const totalH = (left.length - 1) * SPACING;
                const cy = -totalH / 2 + i * SPACING;
                const color = PALETTE[(i * 2 + 1) % PALETTE.length];
                return (
                  <path
                    key={`link-l-${child.$path}`}
                    d={sCurve(-LEVEL_W, cy)}
                    fill="none"
                    stroke={color}
                    strokeWidth={3}
                    strokeOpacity={0.6}
                    strokeLinecap="round"
                    className="mm-link"
                  />
                );
              })}

              {/* Root — pill shape with solid bg */}
              <g
                className={`mm-node mm-root${selectedPath === rootPath ? ' mm-node-selected' : ''}`}
                onClick={() => handleSelect(rootPath)}
              >
                <rect
                  x={-rootW / 2}
                  y={-20}
                  width={rootW}
                  height={40}
                  rx={20}
                  className="mm-root-bg"
                />
                <text textAnchor="middle" dominantBaseline="central" className="mm-root-label">
                  {rootName}
                </text>
              </g>

              {/* Right child nodes */}
              {right.map((child, i) => {
                const totalH = (right.length - 1) * SPACING;
                const cy = -totalH / 2 + i * SPACING;
                const color = PALETTE[(i * 2) % PALETTE.length];
                return (
                  <g key={child.$path} transform={`translate(${LEVEL_W},${cy})`}>
                    <MindMapBranch node={child} side="right" color={color} depth={1} />
                  </g>
                );
              })}

              {/* Left child nodes */}
              {left.map((child, i) => {
                const totalH = (left.length - 1) * SPACING;
                const cy = -totalH / 2 + i * SPACING;
                const color = PALETTE[(i * 2 + 1) % PALETTE.length];
                return (
                  <g key={child.$path} transform={`translate(${-LEVEL_W},${cy})`}>
                    <MindMapBranch node={child} side="left" color={color} depth={1} />
                  </g>
                );
              })}
            </g>
          </MindMapCtx.Provider>
        </svg>
      </div>

      {selectedPath && (
        <MindMapSidebar
          path={selectedPath}
          onClose={handleCloseSidebar}
          onNavigate={handleNavigate}
        />
      )}
    </div>
  );
};

register('mindmap.map', 'react', MindMapView);
