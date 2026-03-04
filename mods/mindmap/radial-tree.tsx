// Radial tree renderer — D3 hierarchy layout + React SVG
// Produces organic bezier curves radiating from center

import { hierarchy, tree as d3tree } from 'd3-hierarchy';
import { select } from 'd3-selection';
import 'd3-transition';
import { zoom as d3zoom, type ZoomBehavior, zoomIdentity } from 'd3-zoom';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { NodeCard } from './node-card';
import type { TreeItem } from './use-tree-data';

type Props = {
  data: TreeItem;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  onToggle: (path: string) => void;
  branchColors: Map<string, string>;
  width: number;
  height: number;
};

// Card dimensions for foreignObject
const CARD_W = 160;
const CARD_H_BASE = 40;
const CARD_H_WITH_COMPS = 62;
const CARD_H_WITH_CHILDREN = 76;

function estimateHeight(item: TreeItem): number {
  let h = CARD_H_BASE;
  if (item.components.length > 0) h = CARD_H_WITH_COMPS;
  if (item.expanded && item.childCount > 0) h = CARD_H_WITH_CHILDREN;
  return h;
}

// Radial point: convert (angle, radius) to (x, y)
function radialPoint(x: number, y: number): [number, number] {
  return [y * Math.cos(x - Math.PI / 2), y * Math.sin(x - Math.PI / 2)];
}

// Point just outside card boundary in the direction of a target
function cardEdge(cx: number, cy: number, tx: number, ty: number, w: number, h: number): [number, number] {
  const dx = tx - cx;
  const dy = ty - cy;
  if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) return [cx, cy];
  const PAD = 4; // push link start/end outside the card
  const scale = Math.min(
    dx !== 0 ? (w / 2 + PAD) / Math.abs(dx) : Infinity,
    dy !== 0 ? (h / 2 + PAD) / Math.abs(dy) : Infinity,
  );
  return [cx + dx * scale, cy + dy * scale];
}

export function RadialTree({ data, selectedPath, onSelect, onToggle, branchColors, width, height }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const gRef = useRef<SVGGElement>(null);
  const zoomRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);

  // Build D3 hierarchy
  const root = useMemo(() => {
    const h = hierarchy(data, d => d.children);
    const nodeCount = h.descendants().length;

    // Dynamic radius based on node count
    const baseRadius = Math.max(200, nodeCount * 18);
    const layout = d3tree<TreeItem>()
      .size([2 * Math.PI, baseRadius])
      .separation((a, b) => (a.parent === b.parent ? 1 : 2) / a.depth);

    layout(h);
    return h;
  }, [data]);

  // D3 zoom setup
  useEffect(() => {
    if (!svgRef.current || !gRef.current) return;

    const svg = select(svgRef.current);
    const g = select(gRef.current);

    const zoomBehavior = d3zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.1, 4])
      .on('zoom', (event) => {
        g.attr('transform', event.transform.toString());
      });

    svg.call(zoomBehavior);

    // Initial transform: center the view
    const initialTransform = zoomIdentity.translate(width / 2, height / 2).scale(0.8);
    svg.call(zoomBehavior.transform, initialTransform);

    zoomRef.current = zoomBehavior;

    return () => { svg.on('.zoom', null); };
  }, [width, height]);

  // Fit view to content
  const fitView = useCallback(() => {
    if (!svgRef.current || !zoomRef.current) return;
    const svg = select(svgRef.current);
    const bounds = gRef.current?.getBBox();
    if (!bounds) return;

    const fullWidth = bounds.width || 1;
    const fullHeight = bounds.height || 1;
    const scale = Math.min(
      (width * 0.9) / fullWidth,
      (height * 0.9) / fullHeight,
      2,
    );
    const tx = width / 2 - (bounds.x + fullWidth / 2) * scale;
    const ty = height / 2 - (bounds.y + fullHeight / 2) * scale;

    svg.transition().duration(500).call(
      zoomRef.current.transform,
      zoomIdentity.translate(tx, ty).scale(scale),
    );
  }, [width, height]);

  // Re-fit on data change
  useEffect(() => {
    const timer = setTimeout(fitView, 100);
    return () => clearTimeout(timer);
  }, [data, fitView]);

  const descendants = root.descendants();
  const links = root.links();

  return (
    <div className="mm-tree-container">
      <div className="mm-toolbar">
        <button className="mm-btn" onClick={fitView} title="Fit view">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
          </svg>
        </button>
      </div>

      <svg ref={svgRef} width={width} height={height} className="mm-svg">
        <g ref={gRef}>
          {/* Links — edge-to-edge radial beziers */}
          <g className="mm-links">
            {links.map(link => {
              // Node centers
              const [scx, scy] = link.source.depth === 0 ? [0, 0] : radialPoint(link.source.x!, link.source.y!);
              const [tcx, tcy] = radialPoint(link.target.x!, link.target.y!);
              const color = branchColors.get(link.target.data.path) ?? 'var(--border)';

              // Start/end at card edges, not centers
              const sH = estimateHeight(link.source.data);
              const tH = estimateHeight(link.target.data);
              const [sx, sy] = cardEdge(scx, scy, tcx, tcy, CARD_W, sH);
              const [tx, ty] = cardEdge(tcx, tcy, scx, scy, CARD_W, tH);

              // Radial unit vectors for control point direction
              const sLen = Math.sqrt(scx * scx + scy * scy);
              const tLen = Math.sqrt(tcx * tcx + tcy * tcy) || 1;
              const edgeDist = Math.sqrt((tx - sx) ** 2 + (ty - sy) ** 2) || 1;
              const stretch = edgeDist * 0.4;

              // Source control: push outward along radial direction
              const srx = sLen > 1 ? scx / sLen : tcx / tLen;
              const sry = sLen > 1 ? scy / sLen : tcy / tLen;
              const c1x = sx + srx * stretch;
              const c1y = sy + sry * stretch;

              // Target control: push inward (opposite of radial)
              const c2x = tx - (tcx / tLen) * stretch;
              const c2y = ty - (tcy / tLen) * stretch;

              return (
                <path
                  key={`${link.source.data.path}->${link.target.data.path}`}
                  d={`M${sx},${sy} C${c1x},${c1y} ${c2x},${c2y} ${tx},${ty}`}
                  fill="none"
                  stroke={color}
                  strokeWidth={Math.max(1.5, 3 - link.target.depth * 0.4)}
                  strokeOpacity={0.6}
                  className="mm-link"
                />
              );
            })}
          </g>

          {/* Nodes — opaque background + card */}
          <g className="mm-nodes">
            {descendants.map(d => {
              const [x, y] = d.depth === 0 ? [0, 0] : radialPoint(d.x!, d.y!);
              const h = estimateHeight(d.data);
              const color = branchColors.get(d.data.path) ?? 'var(--text-2)';

              return (
                <g key={d.data.path} transform={`translate(${x},${y})`}>
                  {/* Opaque background so links don't show through */}
                  <rect
                    x={-CARD_W / 2 - 2}
                    y={-h / 2 - 2}
                    width={CARD_W + 4}
                    height={h + 4}
                    rx={10}
                    fill="var(--surface)"
                  />
                  <foreignObject
                    x={-CARD_W / 2}
                    y={-h / 2}
                    width={CARD_W}
                    height={h}
                    className="mm-fo"
                  >
                    <NodeCard
                      item={d.data}
                      selected={selectedPath === d.data.path}
                      branchColor={color}
                      onSelect={onSelect}
                      onToggle={onToggle}
                    />
                  </foreignObject>
                </g>
              );
            })}
          </g>
        </g>
      </svg>
    </div>
  );
}
