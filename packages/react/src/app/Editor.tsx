import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '#components/ui/alert-dialog';
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
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '#components/ui/resizable';
import { TypePicker } from '#mods/editor-ui/type-picker';
import type { NodeData } from '@treenx/core';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';
import type { PanelImperativeHandle } from 'react-resizable-panels';
import { ChevronDown, Eye, EyeOff, LogIn, LogOut, RotateCcw } from 'lucide-react';
import * as cache from '#tree/cache';
import { tree } from '#tree/client';
import { SSE_CONNECTED, SSE_DISCONNECTED, startEvents, stopEvents } from '#tree/events';
import { addComponent, createNode } from '#hooks';
import { checkBeforeNavigate, makeNavigateApi, NavigateProvider, pushHistory } from '#navigate';
import { Inspector } from '#editor/Inspector';
import { Tree } from '#editor/Tree';
import { trpc } from '#tree/trpc';
import { getModErrors } from '#tree/load-client';
import { toast } from 'sonner';

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

const SIDEBAR_EXPAND_MS = 200;
const SIDEBAR_COLLAPSE_MS = 500;

export interface EditorProps {
  authed: string;
  onLogout: () => void;
}

export function Editor({ authed, onLogout }: EditorProps) {
  const [root, setRoot] = useState<string>(() =>
    new URLSearchParams(location.search).get('root') || '/',
  );

  const [selected, setSelected] = useState<string | null>(() => {
    const p = location.pathname;
    if (!p.startsWith('/t')) return null;
    const rest = p.slice(2);
    return rest || '/';
  });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const [loaded, setLoaded] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [creatingAt, setCreatingAt] = useState<string | null>(null);
  const [addingComponentAt, setAddingComponentAt] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [showHidden, setShowHidden] = useState(false);
  const [toastMsg, setToastMsg] = useState<{ text: string; type: 'success' | 'error' } | null>(null);
  const [sseDown, setSseDown] = useState(false);
  const sseDownTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Notify about failed mods once
  useEffect(() => {
    const errors = getModErrors();
    if (!errors.size) return;
    for (const [name, msg] of errors) {
      toast.warning(`Mod "${name}" skipped`, { description: msg, duration: 10_000 });
    }
  }, []);

  // SSE connection indicator
  useEffect(() => {
    const onConnect = () => {
      if (sseDownTimer.current) { clearTimeout(sseDownTimer.current); sseDownTimer.current = undefined; }
      setSseDown(false);
    };
    const onDisconnect = () => {
      if (!sseDownTimer.current) {
        sseDownTimer.current = setTimeout(() => { sseDownTimer.current = undefined; setSseDown(true); }, 2000);
      }
    };
    window.addEventListener(SSE_CONNECTED, onConnect);
    window.addEventListener(SSE_DISCONNECTED, onDisconnect);
    return () => {
      window.removeEventListener(SSE_CONNECTED, onConnect);
      window.removeEventListener(SSE_DISCONNECTED, onDisconnect);
      if (sseDownTimer.current) clearTimeout(sseDownTimer.current);
    };
  }, []);

  const hasRootNode = useSyncExternalStore(
    useCallback((cb: () => void) => cache.subscribePath(root, cb), [root]),
    useCallback(() => cache.has(root), [root]),
  );

  const searchRef = useRef<HTMLInputElement>(null);

  // Sync selected path to /t/ URL
  const navFromPopstate = useRef(false);
  useEffect(() => {
    if (navFromPopstate.current) { navFromPopstate.current = false; return; }
    const base = selected ? `/t${selected === '/' ? '' : selected}` : '/';
    const search = root !== '/' ? `?root=${encodeURIComponent(root)}` : '';
    const url = base + search;
    if (location.pathname + location.search !== url) {
      pushHistory(url);
    }
  }, [selected, root]);

  // Editor-local popstate: keep selected/root in sync when user back/forwards within /t/*
  useEffect(() => {
    const onPop = () => {
      const p = location.pathname;
      if (!p.startsWith('/t')) return; // Router will handle mode switch
      navFromPopstate.current = true;
      setSelected(p.slice(2) || '/');
      setRoot(new URLSearchParams(location.search).get('root') || '/');
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      if (document.querySelector('[data-slot="dialog-overlay"]')) return;
      if (e.key === '/' && selected) {
        e.preventDefault();
        setAddingComponentAt(selected);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selected]);

  const showToast = useCallback((msg: string, type: 'success' | 'error' = 'success') => {
    setToastMsg({ text: msg, type });
    setTimeout(() => setToastMsg(null), type === 'error' ? 5000 : 2000);
  }, []);

  useEffect(() => {
    const handler = (e: PromiseRejectionEvent) => {
      const msg = e.reason?.message || String(e.reason);
      showToast(msg, 'error');
    };
    window.addEventListener('unhandledrejection', handler);
    return () => window.removeEventListener('unhandledrejection', handler);
  }, [showToast]);

  const loadChildren = useCallback(async (path: string) => {
    const { items: children } = await tree.getChildren(path, { watch: true, watchNew: true });
    cache.replaceChildren(path, children);
    setLoaded((prev) => new Set(prev).add(path));
  }, []);

  useEffect(() => {
    cache.clear();
    setLoaded(new Set());
    (async () => {
      try {
        const rootNode = (await trpc.get.query({ path: root, watch: true })) as NodeData | undefined;
        if (rootNode) cache.put(rootNode);
        await loadChildren(root);

        const p = location.pathname;
        const target = p.startsWith('/t') ? p.slice(2) || '/' : root;
        const toExpand = new Set([root]);

        if (target !== root && target.startsWith(root === '/' ? '/' : root + '/')) {
          const relative = root === '/' ? target : target.slice(root.length);
          const parts = relative.split('/').filter(Boolean);
          let cur = root === '/' ? '' : root;
          for (let i = 0; i < parts.length - 1; i++) {
            cur += '/' + parts[i];
            toExpand.add(cur);
            await loadChildren(cur);
          }
          const parent = cur || root;
          if (!toExpand.has(parent)) await loadChildren(parent);
        }
        setExpanded(toExpand);
        setSelected(target);
        if (target !== root) {
          const node = (await trpc.get.query({ path: target, watch: true })) as
            | NodeData
            | undefined;
          if (node) cache.put(node);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to connect to server');
      }
    })();
  }, [loadChildren, root]);

  useEffect(() => {
    startEvents({
      loadChildren,
      getExpanded: () => expandedRef.current,
      getSelected: () => selectedRef.current,
    });
    return stopEvents;
  }, [loadChildren]);

  const handleSelect = useCallback(
    async (path: string) => {
      if (!checkBeforeNavigate()) return;
      setSelected(path);
      if (!cache.has(path)) {
        const node = (await trpc.get.query({ path, watch: true })) as NodeData | undefined;
        if (node) cache.put(node);
      }
      await loadChildren(path);
    },
    [loadChildren],
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
        const childPaths = cache.getChildren(path).map(n => n.$path).filter(p => p !== path);
        trpc.unwatchChildren.mutate({ paths: [path] });
        if (childPaths.length) trpc.unwatch.mutate({ paths: childPaths });
      }
    },
    [expanded, loadChildren],
  );

  const handleDelete = useCallback(
    async (path: string) => {
      await tree.remove(path);
      cache.remove(path);
      const parent = path === '/' ? null : path.slice(0, path.lastIndexOf('/')) || '/';
      if (parent) await loadChildren(parent);
      setSelected(parent);
    },
    [loadChildren],
  );

  const handleCreateChild = useCallback((parentPath: string) => {
    setCreatingAt(parentPath);
  }, []);

  const handlePickType = useCallback(
    async (name: string, type: string) => {
      const parentPath = creatingAt!;
      setCreatingAt(null);
      const childPath = parentPath === '/' ? `/${name}` : `${parentPath}/${name}`;
      await createNode(childPath, type);
      await loadChildren(parentPath);
      if (!expanded.has(parentPath)) {
        setExpanded((prev) => new Set(prev).add(parentPath));
      }
      setSelected(childPath);
      const node = (await trpc.get.query({ path: childPath, watch: true })) as NodeData | undefined;
      if (node) cache.put(node);
      showToast(`Created ${name}`);
    },
    [creatingAt, loadChildren, expanded, showToast],
  );

  const handleAddComponent = useCallback((path: string) => {
    setAddingComponentAt(path);
  }, []);

  const handlePickComponent = useCallback(
    async (name: string, type: string) => {
      const path = addingComponentAt!;
      setAddingComponentAt(null);
      await addComponent(path, name, type);
      showToast(`Added ${name}`);
    },
    [addingComponentAt, showToast],
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
      const oldParent =
        fromPath === '/' ? '/' : fromPath.slice(0, fromPath.lastIndexOf('/')) || '/';
      await loadChildren(oldParent);
      await loadChildren(toParent);
      setSelected(newPath);
      showToast(`Moved to ${newPath}`);
    },
    [loadChildren, showToast],
  );

  const roots = hasRootNode ? [root, '/local'] : ['/local'];

  const [rootPromptOpen, setRootPromptOpen] = useState(false);
  const [rootPromptType, setRootPromptType] = useState('root');
  const sidebarPanelRef = useRef<PanelImperativeHandle | null>(null);
  const sidebarAnimationTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const handleCreateRoot = useCallback(async (type: string) => {
    if (!type) return;
    try {
      await tree.set({ $path: '/', $type: type } as NodeData);
      const rootNode = await tree.get('/');
      if (rootNode) cache.put(rootNode);
      setSelected('/');
      setExpanded(new Set(['/']));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create root');
    }
  }, []);

  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarContentHidden, setSidebarContentHidden] = useState(false);
  const [sidebarFadeContent, setSidebarFadeContent] = useState(false);
  const [sidebarAnimating, setSidebarAnimating] = useState(false);
  const [sidebarButtonCollapsed, setSidebarButtonCollapsed] = useState(false);
  const [sidebarButtonHidden, setSidebarButtonHidden] = useState(false);
  const [sidebarAnimationMode, setSidebarAnimationMode] = useState<'expanding' | 'collapsing' | null>(null);

  useEffect(() => () => {
    if (sidebarAnimationTimer.current) clearTimeout(sidebarAnimationTimer.current);
  }, []);

  const toggleSidebar = useCallback(() => {
    if (sidebarAnimationTimer.current) clearTimeout(sidebarAnimationTimer.current);

    if (sidebarCollapsed) {
      setSidebarCollapsed(false);
      setSidebarButtonCollapsed(false);
      setSidebarContentHidden(true);
      setSidebarFadeContent(false);
      setSidebarButtonHidden(true);
      setSidebarAnimating(true);
      setSidebarAnimationMode('expanding');
      sidebarPanelRef.current?.expand();
      sidebarAnimationTimer.current = setTimeout(() => {
        setSidebarContentHidden(false);
        setSidebarButtonHidden(false);
        setSidebarAnimating(false);
        setSidebarAnimationMode(null);
        sidebarAnimationTimer.current = undefined;
      }, SIDEBAR_EXPAND_MS);
      return;
    }

    flushSync(() => {
      setSidebarFadeContent(false);
      setSidebarContentHidden(true);
      setSidebarButtonCollapsed(true);
      setSidebarButtonHidden(false);
      setSidebarAnimating(true);
      setSidebarAnimationMode('collapsing');
    });
    sidebarPanelRef.current?.collapse();
    sidebarAnimationTimer.current = setTimeout(() => {
      setSidebarCollapsed(true);
      setSidebarFadeContent(false);
      setSidebarAnimating(false);
      setSidebarAnimationMode(null);
      sidebarAnimationTimer.current = undefined;
    }, SIDEBAR_COLLAPSE_MS);
  }, [sidebarCollapsed]);

  const handleClearCache = () => {
    cache.clear();
    showToast('Cache cleared');
    location.reload();
  };

  const handleSetRoot = (path: string) => setRoot(path);
  const sidebarCompact = sidebarCollapsed || sidebarAnimating;
  const sidebarButtonCompact = sidebarButtonCollapsed;
  const sidebarContentClass = sidebarContentHidden
    ? `${sidebarFadeContent ? 'transition-opacity duration-[120ms] ease-out' : ''} opacity-0 pointer-events-none`
    : `${sidebarFadeContent ? 'transition-opacity duration-[120ms] ease-out' : ''} opacity-100`;

  // Editor owns in-subtree navigation — children call navigate(path), we select it.
  const makeHref = useCallback((path: string) => `/t${path === '/' ? '' : path}`, []);

  const navigate = useCallback((path: string) => {
    if (!checkBeforeNavigate()) return;
    handleSelect(path);
  }, [handleSelect]);

  const navCtx = useMemo(() => makeNavigateApi(navigate, makeHref), [navigate, makeHref]);

  if (error) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3 text-center">
          <span className="text-4xl">&#9888;</span>
          <p className="text-sm text-red-400">{error}</p>
          <Button variant="outline" size="sm" onClick={() => location.reload()}>Retry</Button>
        </div>
      </div>
    );
  }

  return (
    <NavigateProvider value={navCtx}>
      {sseDown && (
        <div className="fixed top-0 inset-x-0 z-50 bg-yellow-500 text-black text-center text-sm py-1">
          Reconnecting to server…
        </div>
      )}
      <div className="flex h-screen bg-background text-foreground overflow-hidden">
        <ResizablePanelGroup orientation="horizontal" className="h-full">
          <ResizablePanel
            data-editor-sidebar-panel
            data-sidebar-animation={sidebarAnimationMode ?? undefined}
            panelRef={sidebarPanelRef}
            defaultSize="28%"
            minSize="240px"
            maxSize="450px"
            collapsible
            collapsedSize="50px"
            className="flex flex-col border-r border-border"
          >
            <div className={`relative shrink-0 overflow-hidden border-b border-border ${sidebarCompact ? 'h-[74px]' : 'h-[44px]'}`}>
              <div className="absolute left-0 top-1">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      className={`group relative flex h-9 min-w-0 shrink-0 select-none items-center overflow-hidden rounded-lg text-left outline-none transition-colors focus-visible:ring-1 focus-visible:ring-primary/50 ${sidebarCompact ? 'w-[50px] hover:bg-white/[0.035]' : 'w-auto pr-3 before:absolute before:inset-y-0 before:left-2 before:right-0 before:rounded-lg before:transition-colors hover:before:bg-white/[0.035]'}`}
                      title="System menu"
                    >
                      <span className="relative z-10 flex h-9 w-[50px] shrink-0 items-center justify-center">
                        <img src="/treenix.svg" alt="" width="22" height="22" className="shrink-0" />
                      </span>
                      {!sidebarCompact && (
                        <>
                          <span className={`relative z-10 -ml-1 text-[17px] font-semibold leading-none tracking-tight ${sidebarContentClass}`}>Treenix</span>
                          <ChevronDown className={`relative z-10 ml-2 size-3 self-center text-muted-foreground transition-[color,opacity] group-hover:text-primary ${sidebarContentClass}`} />
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
                      onClick={() => setShowHidden((value) => !value)}
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

              {!sidebarCompact && (
                <div className="absolute left-[148px] right-12 top-1/2 flex -translate-y-1/2 items-center gap-2 overflow-hidden">
                  {root !== '/' && (
                    <Button variant="ghost" size="sm" className="h-5 px-1.5 font-mono text-[10px] text-muted-foreground" onClick={() => setRoot('/')}>
                      &#8962; {root}
                    </Button>
                  )}
                  {roots.length === 0 && (
                    <Button variant="ghost" size="sm" className="h-5 text-[10px]" onClick={() => { setRootPromptType('root'); setRootPromptOpen(true); }}>
                      Create root
                    </Button>
                  )}
                </div>
              )}

              <button
                type="button"
                className={`absolute flex items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-white/[0.04] hover:text-foreground focus-visible:ring-1 focus-visible:ring-primary/50 ${sidebarButtonHidden ? 'opacity-0 pointer-events-none' : 'opacity-100'} ${sidebarButtonCompact ? 'left-1/2 top-[40px] size-8 -translate-x-1/2' : 'right-3 top-1/2 size-8 -translate-y-1/2'}`}
                onClick={toggleSidebar}
                title={sidebarButtonCompact ? 'Expand sidebar' : 'Collapse sidebar'}
              >
                <SidebarToggleIcon collapsed={sidebarButtonCompact} />
              </button>
            </div>

            {!sidebarCollapsed && (
              <div className={`flex items-center gap-1 px-2 pt-2 pb-1.5 shrink-0 overflow-hidden ${sidebarContentClass}`}>
                <Input
                  ref={searchRef}
                  placeholder="Search nodes..."
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  className="h-7 text-xs bg-muted/50 border-border"
                />
              </div>
            )}

            {!sidebarCollapsed && (
              <>
                <div className={`flex-1 overflow-y-auto overflow-x-hidden ${sidebarContentClass}`}>
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

                <div className={`flex items-center overflow-hidden px-3 py-1.5 border-t border-border/50 text-[11px] text-muted-foreground shrink-0 ${sidebarContentClass}`}>
                  <span className="truncate">
                    {authed.startsWith('anon:') ? `anon:${authed.slice(5, 13)}` : authed} &middot; <NodeCount /> nodes
                  </span>
                </div>
              </>
            )}
          </ResizablePanel>

          <ResizableHandle withHandle />

          <ResizablePanel defaultSize={72} minSize={40}>
            <Inspector
              path={selected}
              currentUserId={authed}
              onDelete={handleDelete}
              onAddComponent={handleAddComponent}
              onSelect={handleSelect}
              onSetRoot={handleSetRoot}
              toast={showToast}
            />
          </ResizablePanel>
        </ResizablePanelGroup>

        {creatingAt && <TypePicker onSelect={handlePickType} onCancel={() => setCreatingAt(null)} />}

        {addingComponentAt && (
          <TypePicker
            title="Add Component"
            nameLabel="Component name"
            action="Add"
            autoName
            onSelect={handlePickComponent}
            onCancel={() => setAddingComponentAt(null)}
          />
        )}

        <AlertDialog open={rootPromptOpen} onOpenChange={setRootPromptOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Create root node</AlertDialogTitle>
            </AlertDialogHeader>
            <Input
              value={rootPromptType}
              onChange={(e) => setRootPromptType(e.target.value)}
              placeholder="$type"
              className="font-mono"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  setRootPromptOpen(false);
                  handleCreateRoot(rootPromptType);
                }
              }}
            />
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => handleCreateRoot(rootPromptType)}>Create</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {toastMsg && (
          <div className={`fixed bottom-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg text-sm ${toastMsg.type === 'error' ? 'bg-destructive/20 text-destructive border border-destructive/30' : 'bg-primary/20 text-primary border border-primary/30'}`}>
            {toastMsg.text}
          </div>
        )}
      </div>
    </NavigateProvider>
  );
}
