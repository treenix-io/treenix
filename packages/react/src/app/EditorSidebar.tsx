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
import * as cache from '#tree/cache';
import { ChevronDown, Eye, EyeOff, LogIn, LogOut, RotateCcw } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';
import type { PanelImperativeHandle } from 'react-resizable-panels';

const SIDEBAR_EXPAND_MS = 200;
const SIDEBAR_COLLAPSE_MS = 500;

type SidebarPhase = 'expanded' | 'expanding' | 'collapsing' | 'collapsed';

type EditorSidebarProps = {
  authed: string;
  roots: string[];
  root: string;
  expanded: Set<string>;
  loaded: Set<string>;
  selected: string | null;
  filter: string;
  showHidden: boolean;
  onFilterChange: (value: string) => void;
  onShowHiddenChange: (value: boolean) => void;
  onSelect: (path: string) => void;
  onExpand: (path: string) => void;
  onCreateChild: (parentPath: string) => void;
  onDelete: (path: string) => void;
  onMove: (fromPath: string, toPath: string) => void;
  onSetRoot: (path: string) => void;
  onRequestCreateRoot: () => void;
  onClearCache: () => void;
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
  roots,
  root,
  expanded,
  loaded,
  selected,
  filter,
  showHidden,
  onFilterChange,
  onShowHiddenChange,
  onSelect,
  onExpand,
  onCreateChild,
  onDelete,
  onMove,
  onSetRoot,
  onRequestCreateRoot,
  onClearCache,
  onLogout,
}: EditorSidebarProps) {
  const panelRef = useRef<PanelImperativeHandle | null>(null);
  const animationTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const searchRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<SidebarPhase>('expanded');

  useEffect(() => () => {
    if (animationTimer.current) clearTimeout(animationTimer.current);
  }, []);

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
      defaultSize="28%"
      minSize="240px"
      maxSize="450px"
      collapsible
      collapsedSize="50px"
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
                onClick={() => onShowHiddenChange(!showHidden)}
                className={showHidden ? 'bg-accent text-accent-foreground font-medium' : ''}
              >
                <MenuItemIcon>
                  {showHidden ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                </MenuItemIcon>
                <span className="truncate">Show hidden</span>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onClearCache}>
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
            {roots.length === 0 && (
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
            onChange={(e) => onFilterChange(e.target.value)}
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
              onSelect={onSelect}
              onExpand={onExpand}
              onCreateChild={onCreateChild}
              onDelete={onDelete}
              onMove={onMove}
            />
          </div>

          <div className={`flex items-center overflow-hidden px-3 py-1.5 border-t border-border/50 text-[11px] text-muted-foreground shrink-0 ${contentClass}`}>
            <span className="truncate">
              {authed.startsWith('anon:') ? `anon:${authed.slice(5, 13)}` : authed} &middot; <NodeCount /> nodes
            </span>
          </div>
        </>
      )}
    </ResizablePanel>
  );
}
