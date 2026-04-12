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
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '#components/ui/dropdown-menu';
import { Input } from '#components/ui/input';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '#components/ui/resizable';
import { TypePicker } from '#mods/editor-ui/type-picker';
import type { NodeData } from '@treenity/core';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import * as cache from '#tree/cache';
import { tree } from '#tree/client';
import { SSE_CONNECTED, SSE_DISCONNECTED, startEvents, stopEvents } from '#tree/events';
import { addComponent, createNode } from '#hooks';
import { checkBeforeNavigate, NavigateProvider, pushHistory } from '#navigate';
import { Inspector } from '#editor/Inspector';
import { LoginModal, LoginScreen } from './Login';
import { Tree } from '#editor/Tree';
import { AUTH_EXPIRED_EVENT, clearToken, getToken, setToken, trpc } from '#tree/trpc';
import { getModErrors } from '#tree/load-client';
import { RoutedPage } from './RoutedPage';
import { ViewPage } from './ViewPage';

// Hydrate from IDB before first render — fires bump() when done → reactive re-render
cache.hydrate();

// Isolated component — global subscription re-renders only this, not the entire App
function NodeCount() {
  return <>{useSyncExternalStore(cache.subscribeGlobal, cache.size)}</>;
}

export function App() {
  const [authed, setAuthed] = useState<string | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const retryTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const initAuth = useCallback(async () => {
    const token = getToken();
    if (!token) {
      try {
        const login = import.meta.env.VITE_DEV_LOGIN ? trpc.devLogin : trpc.anonLogin;
        const { token: anonToken, userId } = await login.mutate();
        setToken(anonToken);
        setAuthed(userId);
        setAuthChecked(true);
      } catch {
        toast.error('Server unavailable, retrying…');
        retryTimer.current = setTimeout(initAuth, 3000);
      }
      return;
    }
    try {
      const res = await trpc.me.query();
      setAuthed(res?.userId ?? null);
      if (!res) clearToken();
      setAuthChecked(true);
    } catch (e: any) {
      const isAuthError = e?.data?.code === 'UNAUTHORIZED' || e?.data?.httpStatus === 401;
      if (isAuthError) {
        clearToken();
        setAuthChecked(true);
      } else {
        toast.error('Server unavailable, retrying…');
        retryTimer.current = setTimeout(initAuth, 3000);
      }
    }
  }, []);

  useEffect(() => {
    initAuth();
    return () => clearTimeout(retryTimer.current);
  }, []);

  // ── Notify about failed mods ──
  useEffect(() => {
    const errors = getModErrors();
    if (!errors.size) return;
    for (const [name, msg] of errors) {
      toast.warning(`Mod "${name}" skipped`, { description: msg, duration: 10_000 });
    }
  }, []);

  // ── Route detection ──
  // /t/...  → editor (tree inspector)
  // /v/...  → view (direct node render by path)
  // /*      → routed (dynamic router via /sys/routes refs)
  const [mode, setMode] = useState<'editor' | 'view' | 'routed'>(() => {
    const p = location.pathname;
    if (p.startsWith('/t')) return 'editor';
    if (p.startsWith('/v/') || p === '/v') return 'view';
    return 'routed';
  });
  const [viewPath, setViewPath] = useState<string>(() => {
    const p = location.pathname;
    if (p.startsWith('/v')) return p.slice(2) || '/';
    if (!p.startsWith('/t')) return p || '/';
    return '/';
  });
  const [root, setRoot] = useState<string>(() =>
    new URLSearchParams(location.search).get('root') || '/',
  );

  const [selected, setSelected] = useState<string | null>(() => {
    const p = location.pathname;
    if (!p.startsWith('/t')) return null;
    const rest = p.slice(2); // strip "/t"
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

  // TODO: remove debounce, extract from App code, remove debounce
  // SSE connection indicator — debounce disconnect by 2s to avoid flicker
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

  // Granular: only re-render App when root node appears/disappears
  const hasRootNode = useSyncExternalStore(
    useCallback((cb: () => void) => cache.subscribePath(root, cb), [root]),
    useCallback(() => cache.has(root), [root]),
  );

  const searchRef = useRef<HTMLInputElement>(null);

  // Sync selected path to URL (push, not replace, so back/forward works)
  const navFromPopstate = useRef(false);
  useEffect(() => {
    if (mode !== 'editor') return;
    if (navFromPopstate.current) { navFromPopstate.current = false; return; }
    const base = selected ? `/t${selected === '/' ? '' : selected}` : '/';
    const search = root !== '/' ? `?root=${encodeURIComponent(root)}` : '';
    const url = base + search;
    if (location.pathname + location.search !== url) {
      pushHistory(url);
    }
  }, [selected, root, mode]);

  // Handle browser back/forward
  useEffect(() => {
    const onPop = () => {
      if (!checkBeforeNavigate()) {
        pushHistory(location.href);
        return;
      }
      const p = location.pathname;
      navFromPopstate.current = true;
      if (p.startsWith('/t')) {
        setMode('editor');
        setSelected(p.slice(2) || '/');
        setRoot(new URLSearchParams(location.search).get('root') || '/');
      } else if (p.startsWith('/v/') || p === '/v') {
        setMode('view');
        setViewPath(p.slice(2) || '/');
      } else {
        setMode('routed');
        setViewPath(p || '/');
      }
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // Keyboard shortcuts: Cmd+/ add component
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

  // Catch unhandled promise rejections (e.g. tRPC 403/500 errors)
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
    if (!authed) return;
    if (mode !== 'editor') return; // RoutedPage/ViewPage fetch their own data
    cache.clear();
    setLoaded(new Set());
    (async () => {
      try {
        const rootNode = (await trpc.get.query({ path: root, watch: true })) as NodeData | undefined;
        if (rootNode) cache.put(rootNode);
        await loadChildren(root);

        // Restore path from URL, expand ancestors
        const p = location.pathname;
        const target = p.startsWith('/t') ? p.slice(2) || '/' : root;
        const toExpand = new Set([root]);

        // Expand ancestors between root and target
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
  }, [authed, loadChildren, root, mode]);

  // Server event subscription — module-level, refs provide stable access to current state
  useEffect(() => {
    if (!authed) return;
    startEvents({
      loadChildren,
      getExpanded: () => expandedRef.current,
      getSelected: () => selectedRef.current,
    });
    return stopEvents;
  }, [authed, loadChildren]);

  const handleSelect = useCallback(
    async (path: string) => {
      if (!checkBeforeNavigate()) return;
      setSelected(path);
      if (!cache.has(path)) {
        const node = (await trpc.get.query({ path, watch: true })) as NodeData | undefined;
        if (node) cache.put(node);
      }
      // Preload children so editor can derive them from cache
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
        // Unsubscribe: prefix watch + exact watches on children
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

  const handleCreateRoot = useCallback(async (type: string) => {
    if (!type) return;
    try {
      await tree.set({ $path: '/', $type: type } as NodeData);
      const root = await tree.get('/');
      if (root) cache.put(root);
      setSelected('/');
      setExpanded(new Set(['/']));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create root');
    }
  }, []);

  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [showLoginModal, setShowLoginModal] = useState(false);

  // Re-auth as anon + show login modal when session expires mid-use
  useEffect(() => {
    const handler = async () => {
      if (showLoginModal) return;
      clearToken();
      try {
        const { token, userId } = await trpc.anonLogin.mutate();
        setToken(token);
        setAuthed(userId);
        setShowLoginModal(true);
      } catch {
        toast.error('Server unavailable');
      }
    };
    window.addEventListener(AUTH_EXPIRED_EVENT, handler);
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, handler);
  }, [showLoginModal]);

  const handleLogout = async () => {
    clearToken();
    const { token, userId } = await trpc.anonLogin.mutate();
    setToken(token);
    setAuthed(userId);
    setShowLoginModal(true);
  };

  const handleClearCache = () => {
    cache.clear();
    showToast('Cache cleared');
    location.reload();
  };

  const navigate = useCallback((path: string) => {
    if (!checkBeforeNavigate()) return;
    if (mode === 'editor') {
      handleSelect(path);
    } else {
      setViewPath(path);
      const prefix = mode === 'view' ? '/v' : '';
      pushHistory(prefix + path);
    }
  }, [mode, handleSelect]);

  if (!authChecked) return null;
  if (!authed) return <LoginScreen onLogin={(uid) => setAuthed(uid)} />;

  const isAnon = authed.startsWith('anon:');
  const needsLogin = showLoginModal;
  if (mode === 'routed') return <NavigateProvider value={navigate}><RoutedPage path={viewPath} /></NavigateProvider>;
  if (mode === 'view') return <NavigateProvider value={navigate}><ViewPage path={viewPath} /></NavigateProvider>;

  const handleSetRoot = (path: string) => {
    setRoot(path);
  };

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
    <NavigateProvider value={navigate}>
    {sseDown && (
      <div className="fixed top-0 inset-x-0 z-50 bg-yellow-500 text-black text-center text-sm py-1">
        Reconnecting to server…
      </div>
    )}
    <div className="flex h-screen bg-background text-foreground overflow-hidden">
      <ResizablePanelGroup orientation="horizontal" className="h-full">
        <ResizablePanel
          defaultSize={28}
          minSize={150}
          maxSize={450}
          className="flex flex-col border-r border-border"
        >
          {/* Header */}
          <div className="flex items-center gap-2 px-3 py-2.5 border-b border-border/50 shrink-0">
            <img src="/treenity.svg" alt="" width="20" height="20" />
            {!sidebarCollapsed && <span className="text-sm font-semibold tracking-tight">Treenity</span>}
            {!sidebarCollapsed && root !== '/' && (
              <Button variant="ghost" size="sm" className="h-5 px-1.5 font-mono text-[10px] text-muted-foreground" onClick={() => setRoot('/')}>
                &#8962; {root}
              </Button>
            )}
            {!sidebarCollapsed && roots.length === 0 && (
              <Button variant="ghost" size="sm" className="h-5 text-[10px]" onClick={() => { setRootPromptType('root'); setRootPromptOpen(true); }}>
                Create root
              </Button>
            )}
          </div>

          {/* Search */}
          {!sidebarCollapsed && (
            <div className="flex items-center gap-1 px-2 py-1.5 shrink-0">
              <Input
                ref={searchRef}
                placeholder="Search nodes..."
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                className="h-7 text-xs bg-muted/50 border-border"
              />
              <Button
                variant={showHidden ? 'secondary' : 'ghost'}
                size="sm"
                className="h-7 w-7 p-0 text-xs text-muted-foreground shrink-0"
                onClick={() => setShowHidden(v => !v)}
                title={showHidden ? 'Hide _ prefixed nodes' : 'Show _ prefixed nodes'}
              >
                _
              </Button>
            </div>
          )}

          {/* Tree */}
          <div className="flex-1 overflow-y-auto overflow-x-hidden">
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

          {/* Footer */}
          <div className="flex items-center justify-between px-3 py-1.5 border-t border-border/50 text-[11px] text-muted-foreground shrink-0">
            <span className="truncate">
              {authed?.startsWith('anon:') ? `anon:${authed.slice(5, 13)}` : authed} &middot; <NodeCount /> nodes
            </span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="h-5 w-5 p-0 text-muted-foreground hover:text-foreground">
                  &#9776;
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" side="top" className="w-36">
                <DropdownMenuItem onClick={handleLogout}>
                  {authed?.startsWith('anon:') ? 'Login' : 'Logout'}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={handleClearCache}>
                  Clear cache
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </ResizablePanel>

        <ResizableHandle withHandle />

        <ResizablePanel defaultSize={72} minSize={40}>
          <Inspector
            path={selected}
            currentUserId={authed ?? undefined}
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

      {needsLogin && (
        <LoginModal
          onLogin={(uid) => { setAuthed(uid); setShowLoginModal(false); }}
          onClose={isAnon ? undefined : () => setShowLoginModal(false)}
        />
      )}

      {toastMsg && (
        <div className={`fixed bottom-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg text-sm ${toastMsg.type === 'error' ? 'bg-destructive/20 text-destructive border border-destructive/30' : 'bg-primary/20 text-primary border border-primary/30'}`}>
          {toastMsg.text}
        </div>
      )}
    </div>
    </NavigateProvider>
  );
}
