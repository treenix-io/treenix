import { Button } from '#components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '#components/ui/dropdown-menu';
import { Input } from '#components/ui/input';
import { ResizablePanel } from '#components/ui/resizable';
import { Tree } from '#editor/Tree';
import { createNode } from '#hooks';
import { TypePicker } from '#mods/editor-ui/type-picker';
import { checkBeforeNavigate } from '#navigate';
import * as cache from '#tree/cache';
import { tree } from '#tree/client';
import { startEvents, stopEvents } from '#tree/events';
import { trpc } from '#tree/trpc';
import type { NodeData } from '@treenx/core';
import { ChevronDown, Eye, EyeOff, LogIn, LogOut, RotateCcw } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';
import type { PanelImperativeHandle, PanelSize } from 'react-resizable-panels';

const SIDEBAR_EXPAND_MS = 200;
const SIDEBAR_COLLAPSE_MS = 500;
const SIDEBAR_COLLAPSED_WIDTH = 50;
const SIDEBAR_MIN_WIDTH = 240;
const SIDEBAR_RESIZE_COLLAPSE_WIDTH = (SIDEBAR_COLLAPSED_WIDTH + SIDEBAR_MIN_WIDTH) / 2;

type SidebarPhase = 'expanded' | 'expanding' | 'collapsing' | 'collapsed';

type EditorSidebarProps = {
  authed: string;
  root: string;
  selected: string | null;
  onSelect: (path: string) => void | Promise<void>;
  onSetRoot: (path: string) => void;
  onRequestCreateRoot: () => void;
  toast: (message: string, type?: 'success' | 'error') => void;
  onLogout: () => void;
};

function NodeCount() {
  return <>{useSyncExternalStore(cache.subscribeGlobal, cache.size)}</>;
}

function SidebarToggleIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg viewBox="0 0 16 16" className="size-4" fill="none" aria-hidden="true">
      <rect x="2.25" y="2.5" width="11.5" height="11" rx="2.25" stroke="currentColor" strokeWidth="1.4" />
      <path d="M6.25 3.25v9.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" opacity="0.55" />
      <path
        d={collapsed ? 'M9 6.25 11 8l-2 1.75' : 'M11 6.25 9 8l2 1.75'}
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function MenuItemIcon({ children }: { children: ReactNode }) {
  return (
    <span className="flex size-4 items-center justify-center">
      {children}
    </span>
  );
}

export function EditorSidebar({
  authed,
  root,
  selected,
  onSelect,
  onSetRoot,
  onRequestCreateRoot,
  toast,
  onLogout,
}: EditorSidebarProps) {
  const panelRef = useRef<PanelImperativeHandle | null>(null);
  const animationTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const searchRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<SidebarPhase>('expanded');
  const [filter, setFilter] = useState('');
  const [showHidden, setShowHidden] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState<Set<string>>(new Set());
  const [creatingAt, setCreatingAt] = useState<string | null>(null);
  const expandedRef = useRef(expanded);
  const selectedRef = useRef(selected);
  const phaseRef = useRef(phase);

  expandedRef.current = expanded;
  selectedRef.current = selected;
  phaseRef.current = phase;

  const hasRootNode = useSyncExternalStore(
    useCallback((cb: () => void) => cache.subscribePath(root, cb), [root]),
    useCallback(() => cache.has(root), [root]),
  );
  const roots = hasRootNode ? [root, '/local'] : ['/local'];

  const loadChildren = useCallback(async (path: string) => {
    const { items: children } = await tree.getChildren(path, { watch: true, watchNew: true });
    cache.replaceChildren(path, children);
    setLoaded((prev) => new Set(prev).add(path));
  }, []);

  useEffect(() => () => {
    if (animationTimer.current) clearTimeout(animationTimer.current);
  }, []);

  useEffect(() => {
    cache.clear();
    setLoaded(new Set());
    (async () => {
      const rootNode = (await trpc.get.query({ path: root, watch: true })) as NodeData | undefined;
      if (rootNode) cache.put(rootNode);
      await loadChildren(root);

      const p = location.pathname;
      const target = p.startsWith('/t') ? p.slice(2) || '/' : root;
      const toExpand = new Set([root]);

      if (target !== root && target.startsWith(root === '/' ? '/' : `${root}/`)) {
        const relative = root === '/' ? target : target.slice(root.length);
        const parts = relative.split('/').filter(Boolean);
        let cur = root === '/' ? '' : root;
        for (let i = 0; i < parts.length - 1; i++) {
          cur += `/${parts[i]}`;
          toExpand.add(cur);
          await loadChildren(cur);
        }
        const parent = cur || root;
        if (!toExpand.has(parent)) await loadChildren(parent);
      }

      setExpanded(toExpand);
      await onSelect(target);
      if (target !== root && !cache.has(target)) {
        const node = (await trpc.get.query({ path: target, watch: true })) as NodeData | undefined;
        if (node) cache.put(node);
      }
    })().catch((e: unknown) => {
      toast(e instanceof Error ? e.message : 'Failed to connect to server', 'error');
    });
  }, [loadChildren, onSelect, root, toast]);

  useEffect(() => {
    startEvents({
      loadChildren,
      getExpanded: () => expandedRef.current,
      getSelected: () => selectedRef.current,
    });
    return stopEvents;
  }, [loadChildren]);

  const toggleSidebar = useCallback(() => {
    if (animationTimer.current) clearTimeout(animationTimer.current);

    if (phase === 'collapsed') {
      setPhase('expanding');
      panelRef.current?.expand();
      animationTimer.current = setTimeout(() => {
        setPhase('expanded');
        animationTimer.current = undefined;
      }, SIDEBAR_EXPAND_MS);
      return;
    }

    flushSync(() => setPhase('collapsing'));
    panelRef.current?.collapse();
    animationTimer.current = setTimeout(() => {
      setPhase('collapsed');
      animationTimer.current = undefined;
    }, SIDEBAR_COLLAPSE_MS);
  }, [phase]);

  const handlePanelResize = useCallback((size: PanelSize) => {
    const currentPhase = phaseRef.current;
    if (currentPhase === 'expanding' || currentPhase === 'collapsing') return;

    const isCollapsedSize =
      panelRef.current?.isCollapsed() || size.inPixels <= SIDEBAR_RESIZE_COLLAPSE_WIDTH;

    if (isCollapsedSize && currentPhase !== 'collapsed') {
      setPhase('collapsed');
      return;
    }

    if (!isCollapsedSize && currentPhase === 'collapsed') {
      setPhase('expanded');
    }
  }, []);

  const handleSelect = useCallback(
    async (path: string) => {
      if (!checkBeforeNavigate()) return;
      await onSelect(path);
      await loadChildren(path);
    },
    [loadChildren, onSelect],
  );

  const handleExpand = useCallback(
    async (path: string) => {
      const wasExpanded = expanded.has(path);
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        return next;
      });
      if (!wasExpanded) {
        await loadChildren(path);
      } else {
        const childPaths = cache.getChildren(path).map((n) => n.$path).filter((p) => p !== path);
        trpc.unwatchChildren.mutate({ paths: [path] });
        if (childPaths.length) trpc.unwatch.mutate({ paths: childPaths });
      }
    },
    [expanded, loadChildren],
  );

  const handleCreateChild = useCallback((parentPath: string) => {
    setCreatingAt(parentPath);
  }, []);

  const handlePickType = useCallback(
    async (name: string, type: string) => {
      const parentPath = creatingAt;
      if (!parentPath) return;
      setCreatingAt(null);

      const childPath = parentPath === '/' ? `/${name}` : `${parentPath}/${name}`;
      await createNode(childPath, type);
      await loadChildren(parentPath);
      setExpanded((prev) => new Set(prev).add(parentPath));
      await onSelect(childPath);

      const node = (await trpc.get.query({ path: childPath, watch: true })) as NodeData | undefined;
      if (node) cache.put(node);
      toast(`Created ${name}`);
    },
    [creatingAt, loadChildren, onSelect, toast],
  );

  const handleDelete = useCallback(
    async (path: string) => {
      await tree.remove(path);
      cache.remove(path);
      const parent = path === '/' ? null : path.slice(0, path.lastIndexOf('/')) || '/';
      if (parent) {
        await loadChildren(parent);
        await onSelect(parent);
      } else {
        await onSelect('/');
      }
    },
    [loadChildren, onSelect],
  );

  const handleMove = useCallback(
    async (fromPath: string, toPath: string) => {
      const fromNode = cache.get(fromPath);
      const toNode = cache.get(toPath);
      if (!fromNode || !toNode) return;

      const toParent = toPath === '/' ? '/' : toPath.slice(0, toPath.lastIndexOf('/')) || '/';
      const fromName = fromPath.slice(fromPath.lastIndexOf('/') + 1);
      const newPath = toParent === '/' ? `/${fromName}` : `${toParent}/${fromName}`;
      if (newPath === fromPath) return;

      await tree.remove(fromPath);
      await tree.set({ ...fromNode, $path: newPath });
      const oldParent = fromPath === '/' ? '/' : fromPath.slice(0, fromPath.lastIndexOf('/')) || '/';
      await loadChildren(oldParent);
      await loadChildren(toParent);
      await onSelect(newPath);
      toast(`Moved to ${newPath}`);
    },
    [loadChildren, onSelect, toast],
  );

  const handleClearCache = useCallback(() => {
    cache.clear();
    toast('Cache cleared');
    location.reload();
  }, [toast]);

  const collapsed = phase === 'collapsed';
  const compact = phase !== 'expanded';
  const buttonCompact = phase === 'collapsed' || phase === 'collapsing';
  const buttonHidden = phase === 'expanding';
  const contentClass = compact ? 'opacity-0 pointer-events-none' : 'opacity-100';
  const animationMode = phase === 'expanding' || phase === 'collapsing' ? phase : undefined;

  return (
    <ResizablePanel
      data-editor-sidebar-panel
      data-sidebar-animation={animationMode}
      panelRef={panelRef}
      onResize={handlePanelResize}
      defaultSize="28%"
      minSize={`${SIDEBAR_MIN_WIDTH}px`}
      maxSize="450px"
      collapsible
      collapsedSize={`${SIDEBAR_COLLAPSED_WIDTH}px`}
      className="flex flex-col border-r border-border"
    >
      <div className={`relative shrink-0 overflow-hidden border-b border-border ${compact ? 'h-[74px]' : 'h-[44px]'}`}>
        <div className="absolute left-0 top-1">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className={`group relative flex h-9 min-w-0 shrink-0 select-none items-center overflow-hidden rounded-lg text-left outline-none transition-colors focus-visible:ring-1 focus-visible:ring-primary/50 ${compact ? 'w-[50px] hover:bg-white/[0.035]' : 'w-auto pr-3 before:absolute before:inset-y-0 before:left-2 before:right-0 before:rounded-lg before:transition-colors hover:before:bg-white/[0.035]'}`}
                title="System menu"
              >
                <span className="relative z-10 flex h-9 w-[50px] shrink-0 items-center justify-center">
                  <img src="/treenix.svg" alt="" width="22" height="22" className="shrink-0" />
                </span>
                {!compact && (
                  <>
                    <span className={`relative z-10 -ml-1 text-[17px] font-semibold leading-none tracking-tight ${contentClass}`}>Treenix</span>
                    <ChevronDown className={`relative z-10 ml-2 size-3 self-center text-muted-foreground transition-[color,opacity] group-hover:text-primary ${contentClass}`} />
                  </>
                )}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" side="bottom" className="inspector-debug-menu">
              <DropdownMenuLabel className="px-2 py-1.5">
                <div className="truncate text-[11px] font-normal text-muted-foreground">
                  {authed.startsWith('anon:') ? `anon:${authed.slice(5, 13)}` : authed} · <NodeCount /> nodes
                </div>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => setShowHidden(!showHidden)}
                className={showHidden ? 'bg-accent text-accent-foreground font-medium' : ''}
              >
                <MenuItemIcon>
                  {showHidden ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                </MenuItemIcon>
                <span className="truncate">Show hidden</span>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleClearCache}>
                <MenuItemIcon>
                  <RotateCcw className="size-3.5" />
                </MenuItemIcon>
                <span className="truncate">Clear cache</span>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onLogout}>
                <MenuItemIcon>
                  {authed.startsWith('anon:') ? <LogIn className="size-3.5" /> : <LogOut className="size-3.5" />}
                </MenuItemIcon>
                <span className="truncate">{authed.startsWith('anon:') ? 'Login' : 'Logout'}</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {!compact && (
          <div className="absolute left-[148px] right-12 top-1/2 flex -translate-y-1/2 items-center gap-2 overflow-hidden">
            {root !== '/' && (
              <Button variant="ghost" size="sm" className="h-5 px-1.5 font-mono text-[10px] text-muted-foreground" onClick={() => onSetRoot('/')}>
                &#8962; {root}
              </Button>
            )}
            {!hasRootNode && (
              <Button variant="ghost" size="sm" className="h-5 text-[10px]" onClick={onRequestCreateRoot}>
                Create root
              </Button>
            )}
          </div>
        )}

        <button
          type="button"
          className={`absolute flex items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-white/[0.04] hover:text-foreground focus-visible:ring-1 focus-visible:ring-primary/50 ${buttonHidden ? 'opacity-0 pointer-events-none' : 'opacity-100'} ${buttonCompact ? 'left-1/2 top-[40px] size-8 -translate-x-1/2' : 'right-3 top-1/2 size-8 -translate-y-1/2'}`}
          onClick={toggleSidebar}
          title={buttonCompact ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          <SidebarToggleIcon collapsed={buttonCompact} />
        </button>
      </div>

      {!collapsed && (
        <div className={`flex items-center gap-1 px-2 pt-2 pb-1.5 shrink-0 overflow-hidden ${contentClass}`}>
          <Input
            ref={searchRef}
            placeholder="Search nodes..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="h-7 text-xs bg-muted/50 border-border"
          />
        </div>
      )}

      {!collapsed && (
        <>
          <div className={`flex-1 overflow-y-auto overflow-x-hidden ${contentClass}`}>
            <Tree
              roots={roots}
              expanded={expanded}
              loaded={loaded}
              selected={selected}
              filter={filter}
              showHidden={showHidden}
              onSelect={handleSelect}
              onExpand={handleExpand}
              onCreateChild={handleCreateChild}
              onDelete={handleDelete}
              onMove={handleMove}
            />
          </div>

          <div className={`flex items-center overflow-hidden px-3 py-1.5 border-t border-border/50 text-[11px] text-muted-foreground shrink-0 ${contentClass}`}>
            <span className="truncate">
              {authed.startsWith('anon:') ? `anon:${authed.slice(5, 13)}` : authed} &middot; <NodeCount /> nodes
            </span>
          </div>
        </>
      )}
      {creatingAt && <TypePicker onSelect={handlePickType} onCancel={() => setCreatingAt(null)} />}
    </ResizablePanel>
  );
}
