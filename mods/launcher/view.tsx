// Launcher view — dashboard with drag-drop from tree + context switching

import { isRef, type NodeData, register, resolveExact } from '@treenx/core';
import { Render, RenderContext, type View } from '@treenx/react';
import { useChildren, useNavigate, usePath } from '@treenx/react';
import { cn } from '@treenx/react';
import { Button } from '@treenx/react/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@treenx/react/ui/dropdown-menu';
import { GripVertical, Plus, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import GridLayout from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import { Launcher } from './types';

type LauncherLayoutItem = { i: string; x: number; y: number; w: number; h: number; ctx?: string };

// Available rendering contexts for the selector
const CONTEXTS = ['auto', 'react', 'react:icon', 'react:widget', 'react:compact'] as const;

function contextLabel(ctx: string) {
  if (ctx === 'auto') return 'Auto';
  if (ctx === 'react') return 'Full';
  if (ctx === 'react:icon') return 'Icon';
  if (ctx === 'react:widget') return 'Widget';
  if (ctx === 'react:compact') return 'Compact';
  return ctx;
}

// Resolve which context to render based on layout item
function resolveContext(item: LauncherLayoutItem): string {
  if (item.ctx && item.ctx !== 'auto') return item.ctx;
  return item.w > 1 || item.h > 1 ? 'react:widget' : 'react:icon';
}

// ── Edit overlay — close + context dropdown menu ──

function EditOverlay({
  ctx,
  onRemove,
  onContextChange,
}: {
  ctx: string;
  onRemove: () => void;
  onContextChange: (ctx: string) => void;
}) {
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="launcher-btn absolute -right-1 -top-1 z-10 h-5 w-5 rounded-full bg-red-700 p-0 hover:bg-red-600"
        onClick={(e) => { e.stopPropagation(); onRemove(); }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <X className="h-3 w-3 text-white" />
      </Button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="launcher-btn absolute -left-1 -top-1 z-10 h-auto min-w-5 rounded-full bg-blue-600 px-1.5 py-0.5 text-[9px] font-medium text-white hover:bg-blue-500"
            onMouseDown={(e) => e.stopPropagation()}
          >
            {contextLabel(ctx)}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-24">
          {CONTEXTS.map((c) => (
            <DropdownMenuItem
              key={c}
              className={cn('text-xs', c === ctx && 'font-bold')}
              onSelect={() => onContextChange(c)}
            >
              {contextLabel(c)}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

// Stored ctx or 'auto' if none
function getStoredCtx(item: LauncherLayoutItem): string {
  return item.ctx || 'auto';
}

// ── App item — resolves ref target and renders via context ──

function AppItem({
  refNode,
  context,
  stored,
  editing,
  onRemove,
  onContextChange,
}: {
  refNode: NodeData;
  context: string;
  stored: string;
  editing?: boolean;
  onRemove?: () => void;
  onContextChange?: (ctx: string) => void;
}) {
  const targetPath = isRef(refNode) ? refNode.$ref : null;
  const { data: target } = usePath(targetPath);
  const navigate = useNavigate();

  if (!target) {
    return (
      <div className="flex h-full w-full items-center justify-center rounded-2xl bg-muted/50">
        <span className="text-xs text-muted-foreground">...</span>
      </div>
    );
  }

  const label = target.$path.split('/').at(-1) || '?';
  const hasView = !!resolveExact(target.$type, context as 'react');

  // No view registered for this context — offer AI generation
  const renderContent = hasView
    ? <RenderContext name={context}><Render value={target} /></RenderContext>
    : <span className="text-xs text-muted-foreground italic">No view for {target.$type}</span>;

  // Icon-style: centered icon + label
  if (context === 'react:icon') {
    return (
      <div
        className="relative flex h-full w-full cursor-pointer flex-col items-center justify-center gap-1 overflow-visible"
        onClick={() => !editing && navigate(target.$path)}
      >
        {editing && onRemove && onContextChange && (
          <EditOverlay ctx={stored} onRemove={onRemove} onContextChange={onContextChange} />
        )}
        <div className="h-14 w-14 shrink-0">
          {renderContent}
        </div>
        <span className="max-w-16 truncate text-center text-[11px] font-medium text-white/90 drop-shadow-sm">
          {label}
        </span>
      </div>
    );
  }

  // Card-style: glass card with content
  return (
    <div
      className="launcher-glass relative h-full w-full cursor-pointer overflow-visible rounded-2xl border border-white/10 bg-white/10 p-3"
      onClick={() => !editing && navigate(target.$path)}
    >
      {editing && onRemove && onContextChange && (
        <EditOverlay ctx={stored} onRemove={onRemove} onContextChange={onContextChange} />
      )}
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-white/50">
        {label}
      </div>
      <div className="h-[calc(100%-1.5rem)] overflow-hidden text-white">
        {renderContent}
      </div>
    </div>
  );
}

// ── Drop zone overlay ──

function DropZone({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return (
    <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-2xl border-2 border-dashed border-blue-400/60 bg-blue-500/10 backdrop-blur-sm">
      <div className="flex flex-col items-center gap-1 text-blue-300">
        <Plus className="h-8 w-8" />
        <span className="text-sm font-medium">Drop node here</span>
      </div>
    </div>
  );
}

// ── Main Launcher View ──

const LauncherView: View<NodeData> = ({ value }) => {
  const { data: launcher } = usePath(value.$path, Launcher);
  const { data: children } = useChildren(value.$path, { watch: true, watchNew: true });

  const [editing, setEditing] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  // Measure container width for RGL
  const containerRef = useRef<HTMLDivElement>(null);
  const [gridWidth, setGridWidth] = useState(400);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w && w > 0) setGridWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Parse layout
  const columns = typeof launcher?.columns === 'number' ? launcher.columns : 4;
  const wallpaper = typeof launcher?.wallpaper === 'string' ? launcher.wallpaper : '';
  const layoutStr = typeof launcher?.layout === 'string' ? launcher.layout : '[]';

  let layoutItems: LauncherLayoutItem[];
  try {
    layoutItems = JSON.parse(layoutStr);
  } catch {
    layoutItems = [];
  }

  // Build child map
  const childMap = new Map<string, NodeData>();
  for (const c of children) {
    const id = c.$path.split('/').at(-1) || '';
    childMap.set(id, c);
  }

  // Auto-generate layout for children without layout entries
  const layoutIds = new Set(layoutItems.map((l) => l.i));
  let nextY = layoutItems.reduce((m, l) => Math.max(m, l.y + l.h), 0);
  let nextX = 0;

  for (const c of children) {
    const id = c.$path.split('/').at(-1) || '';
    if (!layoutIds.has(id)) {
      layoutItems.push({ i: id, x: nextX, y: nextY, w: 1, h: 1 });
      nextX++;
      if (nextX >= columns) {
        nextX = 0;
        nextY++;
      }
    }
  }

  const rowHeight = 90;

  const persistLayout = useCallback(
    (newLayout: readonly LauncherLayoutItem[]) => {
      // Preserve ctx from current layoutItems
      const ctxMap = new Map(layoutItems.map((l) => [l.i, l.ctx]));
      const clean = newLayout.map(({ i, x, y, w, h }) => ({
        i, x, y, w, h,
        ...(ctxMap.get(i) ? { ctx: ctxMap.get(i) } : {}),
      }));
      launcher.updateLayout({ layout: JSON.stringify(clean) });
    },
    [launcher, layoutItems],
  );

  const handleRemove = (id: string) => {
    launcher.removeApp({ id });
  };

  const handleContextChange = (id: string, ctx: string) => {
    const updated = layoutItems.map((l) =>
      l.i === id ? { ...l, ctx: ctx === 'auto' ? undefined : ctx } : l,
    );
    launcher.updateLayout({ layout: JSON.stringify(updated) });
  };

  // ── External drop from tree sidebar ──

  const handleExternalDrop = useCallback(
    (_layout: unknown, _item: unknown, e: Event) => {
      const de = e as DragEvent;
      const path = de.dataTransfer?.getData('application/treenix-path')
        || de.dataTransfer?.getData('text/plain');
      if (!path || !path.startsWith('/')) return;
      launcher.addApp({ path });
      setDragOver(false);
    },
    [value.$path],
  );

  // Container-level drop for when grid is empty or drop misses grid items
  const handleContainerDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('application/treenix-path')) {
      e.preventDefault();
      setDragOver(true);
    }
  }, []);

  const handleContainerDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const path = e.dataTransfer.getData('application/treenix-path')
        || e.dataTransfer.getData('text/plain');
      if (!path || !path.startsWith('/')) return;
      launcher.addApp({ path });
    },
    [launcher],
  );

  return (
    <div
      className={cn(
        'view-full relative min-h-screen select-none overflow-auto',
        editing && 'launcher-editing',
      )}
      style={{ background: wallpaper || undefined }}
      onDragOver={handleContainerDragOver}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleContainerDrop}
    >
      {/* Status bar */}
      <div className="flex items-center justify-between px-5 pb-2 pt-3">
        <span className="text-sm font-semibold text-white/80">Treenix</span>
        <Button
          size="sm"
          variant="ghost"
          className="rounded-full text-xs text-white/60"
          onClick={(e) => {
            e.stopPropagation();
            setEditing(!editing);
          }}
        >
          {editing ? 'Done' : 'Edit'}
        </Button>
      </div>

      {/* Drop zone overlay */}
      <DropZone visible={dragOver && children.length === 0} />

      {/* Grid */}
      <div className="launcher-grid px-3 relative" ref={containerRef}>
        <GridLayout
          layout={layoutItems}
          width={gridWidth}
          gridConfig={{
            cols: columns,
            rowHeight,
            margin: [12, 12] as const,
            containerPadding: null,
            maxRows: Infinity,
          }}
          dragConfig={{ enabled: editing, handle: '.launcher-item', cancel: '.launcher-btn' }}
          resizeConfig={{ enabled: editing }}
          dropConfig={{
            enabled: true,
            defaultItem: { w: 1, h: 1 },
          }}
          onDragStop={(layout) => persistLayout(layout)}
          onResizeStop={(layout) => persistLayout(layout)}
          onDrop={handleExternalDrop}
        >
          {layoutItems.map((item) => {
            const child = childMap.get(item.i);
            if (!child) return <div key={item.i} />;

            return (
              <div key={item.i} className="launcher-item h-full overflow-visible">
                <div
                  className={cn(
                    'h-full overflow-visible transition-transform duration-300',
                    editing && 'launcher-edit-item',
                  )}
                >
                  <AppItem
                    refNode={child}
                    context={resolveContext(item)}
                    stored={getStoredCtx(item)}
                    editing={editing}
                    onRemove={() => handleRemove(item.i)}
                    onContextChange={(ctx) => handleContextChange(item.i, ctx)}
                  />
                </div>
              </div>
            );
          })}
        </GridLayout>

        {/* Inline drop hint when grid has items */}
        {dragOver && children.length > 0 && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center py-4">
            <div className="rounded-full bg-blue-500/30 border border-blue-400/50 px-4 py-2 text-sm text-blue-200 backdrop-blur-sm">
              Drop to add to launcher
            </div>
          </div>
        )}
      </div>

      {/* Empty state */}
      {children.length === 0 && !dragOver && (
        <div className="flex flex-col items-center justify-center gap-3 py-20 text-white/40">
          <GripVertical className="h-12 w-12" />
          <p className="text-sm">Drag nodes from the tree to add them here</p>
        </div>
      )}
    </div>
  );
};

register('launcher', 'react', LauncherView);
