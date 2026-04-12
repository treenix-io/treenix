// MindMapBranch — recursive node component
// Each instance calls useChildren when expanded, parent draws curves

import type { NodeData } from '@treenity/core';
import { useChildren } from '@treenity/react';
import { createContext, useContext, useEffect, useRef } from 'react';

export type EditingAt = {
  parentPath: string;
  side: 'left' | 'right';
  color: string;
} | null;

export type MindMapState = {
  expanded: Set<string>;
  selectedPath: string | null;
  editingAt: EditingAt;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
  onAddChild: (parentPath: string, side: 'left' | 'right', color: string) => void;
  onCommitAdd: (parentPath: string, name: string) => void;
  onCancelAdd: () => void;
  onDelete: (path: string) => void;
};

export const MindMapCtx = createContext<MindMapState>(null!);

const LEVEL_W = 200;
const SPACING = 40;

function basename(path: string): string {
  if (path === '/') return '/';
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}

function shortType(type: string): string {
  const parts = type.split('.');
  return parts.length > 1 ? parts.pop()! : '';
}

function sCurve(dx: number, dy: number): string {
  const cx = dx * 0.5;
  return `M0,0 C${cx},0 ${cx},${dy} ${dx},${dy}`;
}

type BranchProps = {
  node: NodeData;
  side: 'left' | 'right';
  color: string;
  depth: number;
};

export function MindMapBranch({ node, side, color, depth }: BranchProps) {
  const { expanded, selectedPath, onToggle, onSelect, onAddChild } = useContext(MindMapCtx);
  const isExpanded = expanded.has(node.$path);
  const isLeft = side === 'left';
  const isSelected = selectedPath === node.$path;
  const name = basename(node.$path);
  const type = shortType(node.$type);
  const strokeW = Math.max(1.5, 3 - depth * 0.4);

  return (
    <g className="mm-branch">
      <g
        className={`mm-node${isSelected ? ' mm-node-selected' : ''}`}
        onClick={() => onToggle(node.$path)}
        onContextMenu={e => { e.preventDefault(); onSelect(node.$path); }}
      >
        {/* Dot */}
        <circle r={isSelected ? 5 : 3.5} fill={color} className="mm-dot" />

        {/* Label — offset from dot to avoid overlap with child curves */}
        <text
          x={isLeft ? -14 : 14}
          textAnchor={isLeft ? 'end' : 'start'}
          dominantBaseline="central"
          className="mm-label"
          fill={color}
        >
          {name}
        </text>

        {/* Type tag */}
        {type && depth <= 2 && (
          <text
            x={isLeft ? -14 - name.length * 7.5 - 6 : 14 + name.length * 7.5 + 6}
            textAnchor={isLeft ? 'end' : 'start'}
            dominantBaseline="central"
            className="mm-type-tag"
            fill={color}
          >
            {type}
          </text>
        )}

        {/* Hit area */}
        <rect
          x={isLeft ? -14 - name.length * 8 : -6}
          y={-16}
          width={name.length * 8 + 24}
          height={32}
          fill="transparent"
        />
      </g>

      {/* "+" add child button — visible on hover */}
      <g
        className="mm-add-btn"
        transform={`translate(${isLeft ? -14 - name.length * 7.5 - 20 : 14 + name.length * 7.5 + 20},0)`}
        onClick={e => { e.stopPropagation(); onAddChild(node.$path, side, color); }}
      >
        <circle r={9} className="mm-add-bg" />
        <text textAnchor="middle" dominantBaseline="central" className="mm-add-icon">+</text>
      </g>

      {/* Children (only fetched when expanded) */}
      {isExpanded && (
        <BranchChildren
          path={node.$path}
          side={side}
          color={color}
          depth={depth}
          strokeW={strokeW}
        />
      )}
    </g>
  );
}

// Inline input for naming new nodes
function InlineInput({ x, y, side, onCommit, onCancel }: {
  x: number;
  y: number;
  side: 'left' | 'right';
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Focus after foreignObject mounts
    setTimeout(() => ref.current?.focus(), 50);
  }, []);

  const handleKey = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      const val = ref.current?.value.trim();
      if (val) onCommit(val);
      else onCancel();
    }
    if (e.key === 'Escape') onCancel();
  };

  const handleBlur = () => {
    const val = ref.current?.value.trim();
    if (val) onCommit(val);
    else onCancel();
  };

  const isLeft = side === 'left';
  const inputW = 140;

  return (
    <g transform={`translate(${x},${y})`}>
      <circle r={3.5} fill="var(--accent)" />
      <foreignObject
        x={isLeft ? -inputW - 14 : 14}
        y={-12}
        width={inputW}
        height={24}
      >
        <input
          ref={ref}
          className="mm-inline-input"
          placeholder="node name..."
          onKeyDown={handleKey}
          onBlur={handleBlur}
        />
      </foreignObject>
    </g>
  );
}

type ChildrenProps = {
  path: string;
  side: 'left' | 'right';
  color: string;
  depth: number;
  strokeW: number;
};

function BranchChildren({ path, side, color, depth, strokeW }: ChildrenProps) {
  const { editingAt, onCommitAdd, onCancelAdd } = useContext(MindMapCtx);
  const { data: children } = useChildren(path, { watch: true, watchNew: true });

  const isLeft = side === 'left';
  const dx = isLeft ? -LEVEL_W : LEVEL_W;
  const isEditing = editingAt?.parentPath === path;
  const totalCount = children.length + (isEditing ? 1 : 0);

  if (totalCount === 0) return null;

  const totalH = (totalCount - 1) * SPACING;
  const startY = -totalH / 2;

  return (
    <>
      {/* Curves to existing children */}
      {children.map((child, i) => {
        const cy = startY + i * SPACING;
        return (
          <path
            key={`link-${child.$path}`}
            d={sCurve(dx, cy)}
            fill="none"
            stroke={color}
            strokeWidth={strokeW}
            strokeOpacity={0.55}
            strokeLinecap="round"
            className="mm-link"
          />
        );
      })}

      {/* Curve to new node slot */}
      {isEditing && (
        <path
          d={sCurve(dx, startY + children.length * SPACING)}
          fill="none"
          stroke="var(--accent)"
          strokeWidth={strokeW}
          strokeOpacity={0.5}
          strokeLinecap="round"
          strokeDasharray="6 4"
        />
      )}

      {/* Existing child nodes */}
      {children.map((child, i) => {
        const cy = startY + i * SPACING;
        return (
          <g key={child.$path} transform={`translate(${dx},${cy})`}>
            <MindMapBranch node={child} side={side} color={color} depth={depth + 1} />
          </g>
        );
      })}

      {/* Inline input for new node */}
      {isEditing && (
        <InlineInput
          x={dx}
          y={startY + children.length * SPACING}
          side={side}
          onCommit={name => onCommitAdd(path, name)}
          onCancel={onCancelAdd}
        />
      )}
    </>
  );
}
