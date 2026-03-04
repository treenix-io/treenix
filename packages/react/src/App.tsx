import { isOfType, type NodeData } from '@treenity/core/core';
import { applyPatch, type Operation } from 'fast-json-patch';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import * as cache from './cache';
import { tree } from './client';
import { NavigateProvider } from './hooks';
import { Inspector } from './Inspector';
import { Tree } from './Tree';
import { AUTH_EXPIRED_EVENT, clearToken, getToken, setToken, trpc } from './trpc';
import { ViewPage } from './ViewPage';

// Hydrate from IDB before first render — fires bump() when done → reactive re-render
cache.hydrate();

type TypeInfo = { type: string; label: string };

async function loadTypes(): Promise<TypeInfo[]> {
  const { items } = (await trpc.getChildren.query({ path: '/sys/types', limit: 0, depth: 99 })) as {
    items: NodeData[];
    total: number;
  };
  return items
    .filter((n) => isOfType(n, 'type'))
    .map((n) => {
      const schema = n.schema as { $type: string; title?: string } | undefined;
      const typeName = n.$path.slice('/sys/types/'.length).replace(/\//g, '.');
      return { type: typeName, label: schema?.title ?? typeName };
    });
}

function TypePicker({
  onSelect,
  onCancel,
  title = 'Create Node',
  nameLabel = 'Node name',
  action = 'Create',
}: {
  onSelect: (name: string, type: string) => void;
  onCancel: () => void;
  title?: string;
  nameLabel?: string;
  action?: string;
}) {
  const [types, setTypes] = useState<TypeInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [name, setName] = useState('');
  const [selectedType, setSelectedType] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadTypes()
      .then(setTypes)
      .catch((err) => {
        console.error('Failed to load types:', err);
        setError('Failed to load types');
      })
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const lf = filter.toLowerCase();
  const filtered = types.filter(
    (t) => t.type.toLowerCase().includes(lf) || t.label.toLowerCase().includes(lf),
  );

  return (
    <div className="type-picker-overlay" onClick={onCancel}>
      <div className="type-picker" onClick={(e) => e.stopPropagation()}>
        <div className="type-picker-header">{title}</div>
        <div className="type-picker-search">
          <input
            ref={nameRef}
            placeholder={nameLabel}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <input
            placeholder="Filter types..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
        <div className="type-picker-list">
          {filtered.map((t) => (
            <div
              key={t.type}
              className={`type-picker-item${selectedType === t.type ? ' active' : ''}`}
              onClick={() => setSelectedType(t.type)}
            >
              <span className="type-name">{t.type}</span>
              {t.label !== t.type && <span className="type-label">{t.label}</span>}
            </div>
          ))}
          {loading && (
            <div className="p-3 text-[--text-3] text-[13px]">Loading types...</div>
          )}
          {error && (
            <div className="p-3 text-[--danger] text-[13px]">{error}</div>
          )}
          {!loading && !error && filtered.length === 0 && (
            <div className="p-3 text-[--text-3] text-[13px]">No types found</div>
          )}
        </div>
        <div className="type-picker-footer">
          <button onClick={onCancel}>Cancel</button>
          <button
            className="primary"
            disabled={!name || !selectedType}
            onClick={() => onSelect(name, selectedType!)}
          >
            {action}
            {name ? ` "${name}"` : ''}
            {selectedType ? ` as ${selectedType}` : ''}
          </button>
        </div>
      </div>
    </div>
  );
}

function LoginForm({ onLogin }: { onLogin: (userId: string) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [userId, setUserId] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!userId.trim() || !password) return;
    setLoading(true);
    setErr(null);
    try {
      const fn = mode === 'register' ? trpc.register : trpc.login;
      const res = await fn.mutate({ userId: userId.trim(), password });
      setToken(res.token);
      onLogin(res.userId);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <form className="login-box" onSubmit={handleSubmit}>
      <div className="login-logo">
        <img src="/treenity.svg" alt="" width="32" height="32" />
        Treenity
      </div>
      <div className="field">
        <label>User ID</label>
        <input
          autoFocus
          placeholder="Enter your user ID"
          value={userId}
          onChange={(e) => setUserId(e.target.value)}
        />
      </div>
      <div className="field">
        <label>Password</label>
        <input
          type="password"
          placeholder="Enter password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>
      {err && <div className="login-error">{err}</div>}
      <button className="primary" type="submit" disabled={loading || !userId.trim() || !password}>
        {loading ? '...' : mode === 'register' ? 'Create account' : 'Sign in'}
      </button>
      <button
        type="button"
        className="ghost"
        onClick={() => {
          setMode((m) => (m === 'login' ? 'register' : 'login'));
          setErr(null);
        }}
      >
        {mode === 'login' ? 'No account? Register' : 'Have an account? Sign in'}
      </button>
    </form>
  );
}

function LoginScreen({ onLogin }: { onLogin: (userId: string) => void }) {
  return (
    <div className="login-screen">
      <LoginForm onLogin={onLogin} />
    </div>
  );
}

function LoginModal({ onLogin, onClose }: { onLogin: (userId: string) => void; onClose: () => void }) {
  return (
    <div className="login-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="login-modal">
        <button className="login-modal-close" onClick={onClose}>&times;</button>
        <LoginForm onLogin={onLogin} />
      </div>
    </div>
  );
}

// Isolated component — global subscription re-renders only this, not the entire App
function NodeCount() {
  return <>{useSyncExternalStore(cache.subscribeGlobal, cache.size)}</>;
}

export function App() {
  const [authed, setAuthed] = useState<string | null>(null);
  const [authChecked, setAuthChecked] = useState(false);

  useEffect(() => {
    (async () => {
      const token = getToken();
      if (!token) {
        // Auto-create anonymous session
        const { token: anonToken, userId } = await trpc.anonLogin.mutate();
        setToken(anonToken);
        setAuthed(userId);
        setAuthChecked(true);
        return;
      }
      try {
        const res = await trpc.me.query();
        setAuthed(res?.userId ?? null);
        if (!res) clearToken();
      } catch {
        clearToken();
      } finally {
        setAuthChecked(true);
      }
    })();
  }, []);

  // ── Route detection ──
  const [mode, setMode] = useState<'editor' | 'view' | 'preview'>(() => {
    const p = location.pathname;
    if (p.startsWith('/t')) return 'editor';
    if (p.startsWith('/v/') || p === '/v') return 'preview';
    return 'view';
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
    const base = selected ? `/t${selected === '/' ? '' : selected}` : '/';
    const search = root !== '/' ? `?root=${encodeURIComponent(root)}` : '';
    const url = base + search;
    if (location.pathname + location.search !== url) {
      if (navFromPopstate.current) navFromPopstate.current = false;
      else history.pushState(null, '', url);
    }
  }, [selected, root, mode]);

  // Handle browser back/forward
  useEffect(() => {
    const onPop = () => {
      const p = location.pathname;
      navFromPopstate.current = true;
      if (p.startsWith('/t')) {
        setMode('editor');
        setSelected(p.slice(2) || '/');
        setRoot(new URLSearchParams(location.search).get('root') || '/');
      } else if (p.startsWith('/v/') || p === '/v') {
        setMode('preview');
        setViewPath(p.slice(2) || '/');
      } else {
        setMode('view');
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
      if (document.querySelector('.type-picker-overlay')) return;
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
    const { items: children } = (await trpc.getChildren.query({
      path,
      watch: true,
      watchNew: true,
    })) as { items: NodeData[]; total: number };
    cache.putMany(children, path); // Use specific parent path so query mounts index them correctly
    setLoaded((prev) => new Set(prev).add(path));
  }, []);

  useEffect(() => {
    if (!authed) return;
    if (mode === 'view') return; // ViewPage fetches its own node
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

  // Live subscription — server push → cache
  useEffect(() => {
    if (!authed) return;
    const sub = trpc.events.subscribe(undefined as void, {
      onData(event) {
        if (event.type === 'reconnect') {
          if (!event.preserved) {
            // Watches lost — force useChildren hooks to re-fetch and re-register
            cache.signalReconnect();
            // Re-register tree watches for expanded paths (editor mode)
            for (const path of expandedRef.current) loadChildren(path);
            // Re-watch the currently selected node
            if (selectedRef.current) {
              trpc.get.query({ path: selectedRef.current, watch: true }).then(n => {
                if (n) cache.put(n as NodeData);
              });
            }
          }
          return;
        }
        if (event.type === 'set') {
          cache.put({ $path: event.path, ...event.node } as NodeData);
          if (event.addVps) event.addVps.forEach((vp: string) => cache.addToParent(event.path, vp));
          if (event.rmVps) event.rmVps.forEach((vp: string) => cache.removeFromParent(event.path, vp));
        } else if (event.type === 'patch') {
          const existing = cache.get(event.path);
          if (existing && event.patches) {
            try {
              const { newDocument } = applyPatch(structuredClone(existing), event.patches as Operation[]);
              cache.put(newDocument as NodeData);
            } catch (e) {
              console.error('Failed to apply patches, fetching full node:', e);
              trpc.get.query({ path: event.path }).then((n) => {
                if (n) cache.put(n as NodeData);
              });
            }
          } else {
            trpc.get.query({ path: event.path }).then((n) => {
              if (n) cache.put(n as NodeData);
            });
          }
          if (event.addVps) event.addVps.forEach((vp: string) => cache.addToParent(event.path, vp));
          if (event.rmVps) event.rmVps.forEach((vp: string) => cache.removeFromParent(event.path, vp));
        } else if (event.type === 'remove') {
          // Try to remove from anywhere
          if (event.rmVps && event.rmVps.length > 0) {
            event.rmVps.forEach((vp: string) => cache.removeFromParent(event.path, vp));
          } else {
            cache.remove(event.path);
          }
        }
      },
    });
    return () => sub.unsubscribe();
  }, [authed, loadChildren]);

  const handleSelect = useCallback(
    async (path: string) => {
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
      await tree.set({ $path: childPath, $type: type } as NodeData);
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
      const node = cache.get(path);
      if (!node) return;
      const updated = { ...node, [name]: { $type: type } };
      cache.put(updated);
      await tree.set(updated);
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

  const roots = hasRootNode ? [root] : [];

  const handleCreateRoot = useCallback(async () => {
    const type = prompt('Root node $type:', 'root');
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
  const [menuOpen, setMenuOpen] = useState(false);
  const [showLoginModal, setShowLoginModal] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Re-auth as anon + show login modal when session expires mid-use
  useEffect(() => {
    const handler = async () => {
      if (showLoginModal) return;
      clearToken();
      const { token, userId } = await trpc.anonLogin.mutate();
      setToken(token);
      setAuthed(userId);
      setShowLoginModal(true);
    };
    window.addEventListener(AUTH_EXPIRED_EVENT, handler);
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, handler);
  }, [showLoginModal]);

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as HTMLElement)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  const handleLogout = async () => {
    clearToken();
    setMenuOpen(false);
    const { token, userId } = await trpc.anonLogin.mutate();
    setToken(token);
    setAuthed(userId);
    setShowLoginModal(true);
  };

  const handleClearCache = () => {
    cache.clear();
    setMenuOpen(false);
    showToast('Cache cleared');
    location.reload();
  };

  const navigate = useCallback((path: string) => {
    if (mode === 'editor') {
      handleSelect(path);
    } else {
      setViewPath(path);
      const prefix = mode === 'preview' ? '/v' : '';
      history.pushState(null, '', prefix + path);
    }
  }, [mode, handleSelect]);

  if (!authChecked) return null;
  if (!authed || authed.startsWith('anon:')) return <LoginScreen onLogin={(uid) => setAuthed(uid)} />;
  if (mode === 'view') return <NavigateProvider value={navigate}><ViewPage path={viewPath} /></NavigateProvider>;
  if (mode === 'preview') return <NavigateProvider value={navigate}><ViewPage path={viewPath} editorLink /></NavigateProvider>;

  const handleSetRoot = (path: string) => {
    setRoot(path);
  };

  if (error) {
    return (
      <div className="app">
        <div className="editor">
          <div className="editor-empty">
            <div className="icon">&#9888;</div>
            <p className="text-[--danger]">{error}</p>
            <button onClick={() => location.reload()}>Retry</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <NavigateProvider value={navigate}>
    <div className="app">
      <div className={`sidebar${sidebarCollapsed ? ' collapsed' : ''}`}>
        <div className="sidebar-header">
          <span className="logo">
            <img src="/treenity.svg" alt="" width="20" height="20" />
            {!sidebarCollapsed && 'Treenity'}
          </span>
          {!sidebarCollapsed && root !== '/' && (
            <button
              className="sm ghost font-mono text-[11px]"
              onClick={() => setRoot('/')}
              title="Back to global root"
            >
              &#8962; {root}
            </button>
          )}
          {!sidebarCollapsed && roots.length === 0 && (
            <button className="sm" onClick={handleCreateRoot}>
              Create root
            </button>
          )}
          <button
            className="sm ghost sidebar-collapse-btn"
            onClick={() => setSidebarCollapsed(v => !v)}
            title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {sidebarCollapsed ? '\u25B6' : '\u25C0'}
          </button>
        </div>
        <div className="sidebar-search">
          <input
            ref={searchRef}
            placeholder="Search nodes..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <button
            className="sidebar-search-toggle"
            data-active={showHidden || undefined}
            onClick={() => setShowHidden(v => !v)}
            title={showHidden ? 'Hide _ prefixed nodes' : 'Show _ prefixed nodes'}
          >
            _
          </button>
        </div>
        <div className="sidebar-tree">
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
        <div className="sidebar-footer" ref={menuRef}>
          <span>
            {authed?.startsWith('anon:') ? `anon:${authed.slice(5, 13)}` : authed} &middot; <NodeCount /> nodes
          </span>
          <button className="sm ghost" onClick={() => setMenuOpen(v => !v)}>
            &#9776;
          </button>
          {menuOpen && (
            <div className="sidebar-menu">
              <button onClick={handleLogout}>
                {authed?.startsWith('anon:') ? 'Login' : 'Logout'}
              </button>
              <button onClick={handleClearCache}>
                Clear cache
              </button>
            </div>
          )}
        </div>
      </div>

      <Inspector
        path={selected}
        currentUserId={authed ?? undefined}
        onDelete={handleDelete}
        onAddComponent={handleAddComponent}
        onSelect={handleSelect}
        onSetRoot={handleSetRoot}
        toast={showToast}
      />

      {creatingAt && <TypePicker onSelect={handlePickType} onCancel={() => setCreatingAt(null)} />}

      {addingComponentAt && (
        <TypePicker
          title="Add Component"
          nameLabel="Component name"
          action="Add"
          onSelect={handlePickComponent}
          onCancel={() => setAddingComponentAt(null)}
        />
      )}

      {showLoginModal && (
        <LoginModal
          onLogin={(uid) => { setAuthed(uid); setShowLoginModal(false); }}
          onClose={() => setShowLoginModal(false)}
        />
      )}

      {toastMsg && <div className={`toast ${toastMsg.type === 'error' ? 'toast-error' : ''}`}>{toastMsg.text}</div>}
    </div>
    </NavigateProvider>
  );
}
