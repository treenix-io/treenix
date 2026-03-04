// Launcher view — iPhone-like home screen with react-grid-layout

import { type NodeData, isRef, register } from '@treenity/core/core';
import { Render, RenderContext } from '@treenity/react/context';
import { execute, useChildren, useNavigate, usePath } from '@treenity/react/hooks';
import { cn } from '@treenity/react/lib/utils';
import { Button } from '@treenity/react/ui/button';
import { Input } from '@treenity/react/ui/input';
import { Plus, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import GridLayout from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import { Launcher } from './types';

type LayoutItem = { i: string; x: number; y: number; w: number; h: number };

// ── App icon — resolves ref target and renders via react:icon ──

function AppIcon({ refNode, editing }: { refNode: NodeData; editing?: boolean }) {
  const targetPath = isRef(refNode) ? refNode.$ref : null;
  const target = usePath(targetPath) as NodeData | undefined;
  const navigate = useNavigate();

  if (!target) {
    return (
      <div className="flex h-full w-full items-center justify-center rounded-2xl bg-zinc-700/50">
        <span className="text-xs text-zinc-400">...</span>
      </div>
    );
  }

  const label = target.$path.split('/').at(-1) || '?';

  return (
    <div
      className="flex h-full w-full cursor-pointer flex-col items-center justify-center gap-1"
      onClick={() => !editing && navigate(target.$path)}
    >
      <div className="h-14 w-14 shrink-0">
        <RenderContext name="react:icon">
          <Render value={target} />
        </RenderContext>
      </div>
      <span className="max-w-16 truncate text-center text-[11px] font-medium text-white/90 drop-shadow-sm">
        {label}
      </span>
    </div>
  );
}

// ── Widget card — renders target via react:widget or react fallback ──

function WidgetCard({ refNode, editing }: { refNode: NodeData; editing?: boolean }) {
  const targetPath = isRef(refNode) ? refNode.$ref : null;
  const target = usePath(targetPath) as NodeData | undefined;
  const navigate = useNavigate();

  if (!target) {
    return (
      <div className="launcher-glass flex h-full w-full items-center justify-center rounded-2xl bg-white/10">
        <span className="text-xs text-zinc-400">Loading...</span>
      </div>
    );
  }

  return (
    <div
      className="launcher-glass h-full w-full cursor-pointer overflow-hidden rounded-2xl border border-white/10 bg-white/10 p-3"
      onClick={() => !editing && navigate(target.$path)}
    >
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-white/50">
        {target.$path.split('/').at(-1)}
      </div>
      <div className="h-[calc(100%-1.5rem)] overflow-hidden text-white">
        <RenderContext name="react:widget">
          <Render value={target} />
        </RenderContext>
      </div>
    </div>
  );
}

// ── Add app dialog (simple inline) ──

function AddAppInput({ launcherPath, onClose }: { launcherPath: string; onClose: () => void }) {
  const [path, setPath] = useState('');

  const handleAdd = async () => {
    const p = path.trim();
    if (!p) return;
    await execute(launcherPath, 'addApp', { path: p }, 'launcher');
    setPath('');
    onClose();
  };

  return (
    <div className="flex items-center gap-2 rounded-2xl bg-white/10 p-3 backdrop-blur-xl">
      <Input
        value={path}
        onChange={e => setPath(e.target.value)}
        placeholder="/path/to/node"
        className="border-white/20 bg-transparent text-white placeholder:text-white/40"
        onKeyDown={e => { if (e.key === 'Enter') handleAdd(); }}
        autoFocus
      />
      <Button size="sm" variant="secondary" onClick={handleAdd}>Add</Button>
      <Button size="sm" variant="ghost" className="text-white/60" onClick={onClose}>
        <X className="h-4 w-4" />
      </Button>
    </div>
  );
}

// ── Main Launcher View ──

function LauncherView({ value }: { value: NodeData }) {
  const proxy = usePath(value.$path, Launcher);
  const children = useChildren(value.$path, { watch: true, watchNew: true });

  const [editing, setEditing] = useState(false);
  const [showAdd, setShowAdd] = useState(false);

  // Measure container width for RGL
  const containerRef = useRef<HTMLDivElement>(null);
  const [gridWidth, setGridWidth] = useState(400);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      const w = entries[0]?.contentRect.width;
      if (w && w > 0) setGridWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Parse layout
  const columns = typeof proxy?.columns === 'number' ? proxy.columns : 4;
  const wallpaper = typeof proxy?.wallpaper === 'string' ? proxy.wallpaper : '';
  const layoutStr = typeof proxy?.layout === 'string' ? proxy.layout : '[]';

  let layoutItems: LayoutItem[];
  try { layoutItems = JSON.parse(layoutStr); } catch { layoutItems = []; }

  // Build child map
  const childMap = new Map<string, NodeData>();
  for (const c of children) {
    const id = c.$path.split('/').at(-1) || '';
    childMap.set(id, c);
  }

  // Auto-generate layout for children without layout entries
  const layoutIds = new Set(layoutItems.map(l => l.i));
  let nextY = layoutItems.reduce((m, l) => Math.max(m, l.y + l.h), 0);
  let nextX = 0;

  for (const c of children) {
    const id = c.$path.split('/').at(-1) || '';
    if (!layoutIds.has(id)) {
      layoutItems.push({ i: id, x: nextX, y: nextY, w: 1, h: 1 });
      nextX++;
      if (nextX >= columns) { nextX = 0; nextY++; }
    }
  }

  const rowHeight = 90;

  const persistLayout = useCallback((newLayout: readonly LayoutItem[]) => {
    const clean = newLayout.map(({ i, x, y, w, h }) => ({ i, x, y, w, h }));
    execute(value.$path, 'updateLayout', { layout: JSON.stringify(clean) }, 'launcher');
  }, [value.$path]);

  const handleRemove = (id: string) => {
    execute(value.$path, 'removeApp', { id }, 'launcher');
  };

  return (
    <div
      className={cn(
        'view-full relative min-h-screen select-none overflow-auto',
        editing && 'launcher-editing',
      )}
      style={{ background: wallpaper || undefined }}
    >
      {/* Status bar */}
      <div className="flex items-center justify-between px-5 pb-2 pt-3">
        <span className="text-sm font-semibold text-white/80">Treenity</span>
        <Button
          size="sm"
          variant="ghost"
          className="rounded-full text-xs text-white/60"
          onClick={e => { e.stopPropagation(); setEditing(!editing); }}
        >
          {editing ? 'Done' : 'Edit'}
        </Button>
      </div>

      {/* Grid */}
      <div className="launcher-grid px-3" ref={containerRef}>
        <GridLayout
          layout={layoutItems}
          width={gridWidth}
          gridConfig={{ cols: columns, rowHeight, margin: [12, 12], containerPadding: null, maxRows: Infinity }}
          dragConfig={{ enabled: editing, handle: '.launcher-item' }}
          resizeConfig={{ enabled: editing }}
          onDragStop={(layout) => persistLayout(layout)}
          onResizeStop={(layout) => persistLayout(layout)}
        >
          {layoutItems.map(item => {
            const child = childMap.get(item.i);
            if (!child) return <div key={item.i} />;

            const isWidget = item.w > 1 || item.h > 1;

            return (
              <div key={item.i} className="launcher-item relative">
                <div className={editing ? 'launcher-wiggle h-full' : 'h-full'}>
                  {isWidget
                    ? <WidgetCard refNode={child} editing={editing} />
                    : <AppIcon refNode={child} editing={editing} />
                  }
                </div>
                {editing && (
                  <button
                    className="absolute -right-1 -top-1 z-10 flex h-5 w-5 items-center justify-center rounded-full bg-red-500 text-white shadow-md"
                    onClick={e => { e.stopPropagation(); handleRemove(item.i); }}
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </div>
            );
          })}
        </GridLayout>
      </div>

      {/* Add button (edit mode) */}
      {editing && !showAdd && (
        <div className="flex justify-center py-4">
          <Button
            variant="secondary"
            className="rounded-full"
            onClick={e => { e.stopPropagation(); setShowAdd(true); }}
          >
            <Plus className="mr-1 h-4 w-4" /> Add App
          </Button>
        </div>
      )}

      {showAdd && (
        <div className="px-4 py-2">
          <AddAppInput launcherPath={value.$path} onClose={() => setShowAdd(false)} />
        </div>
      )}
    </div>
  );
}

register('launcher', 'react', LauncherView as any);
