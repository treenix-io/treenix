// MindMap node card — rendered inside SVG foreignObject
// Click = select, expand button (▸/▾) = toggle children

import type { TreeItem } from './use-tree-data';

type Props = {
  item: TreeItem;
  selected: boolean;
  branchColor: string;
  onSelect: (path: string) => void;
  onToggle: (path: string) => void;
};

function shortType(type: string): string {
  const parts = type.split('.');
  return parts.length > 1 ? parts.slice(-1)[0] : type;
}

export function NodeCard({ item, selected, branchColor, onSelect, onToggle }: Props) {
  if (item.type === '__overflow__') {
    return (
      <div
        className="mm-card mm-overflow"
        onClick={() => onToggle(item.node.$path)}
      >
        <span className="text-[11px] text-[var(--text-3)]">{item.name}</span>
      </div>
    );
  }

  return (
    <div
      className={`mm-card${selected ? ' mm-selected' : ''}`}
      style={{ borderLeftColor: branchColor }}
      onClick={(e) => { e.stopPropagation(); onSelect(item.path); }}
    >
      <div className="mm-card-header">
        <span
          className="mm-expand-btn"
          onClick={(e) => { e.stopPropagation(); onToggle(item.path); }}
        >
          {item.expanded ? '▾' : '▸'}
        </span>
        <span className="mm-name">{item.name}</span>
        <span className="mm-type" style={{ background: branchColor + '30', color: branchColor }}>
          {shortType(item.type)}
        </span>
      </div>

      {item.components.length > 0 && (
        <div className="mm-comps">
          {item.components.slice(0, 4).map(([key, comp]) => (
            <span key={key} className="mm-comp-pill">
              {key || shortType((comp as any).$type)}
            </span>
          ))}
          {item.components.length > 4 && (
            <span className="mm-comp-pill">+{item.components.length - 4}</span>
          )}
        </div>
      )}

      {item.expanded && item.childCount > 0 && (
        <div className="mm-child-count">
          {item.childCount} {item.childCount === 1 ? 'child' : 'children'}
        </div>
      )}
    </div>
  );
}
