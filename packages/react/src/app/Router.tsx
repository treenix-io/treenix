import { useCallback, useMemo } from 'react';
import { LoginScreen, LoginModal } from './Login';
import { RoutedPage } from './RoutedPage';
import { ViewPage } from './ViewPage';
import { Editor } from './Editor';
import { useAuth } from './use-auth';
import { makeEditorHref, makeNavigateApi, NavigateProvider, navigateTo, useLocation } from '#navigate';
import * as cache from '#tree/cache';

type Mode = 'editor' | 'view' | 'routed';

function detectMode(pathname: string): Mode {
  if (pathname.startsWith('/t')) return 'editor';
  if (pathname.startsWith('/v/') || pathname === '/v') return 'view';
  return 'routed';
}

function detectViewPath(pathname: string): string {
  if (pathname.startsWith('/v')) return pathname.slice(2) || '/';
  if (!pathname.startsWith('/t')) return pathname || '/';
  return '/';
}

// Hydrate cache from IDB before first render — RoutedPage/ViewPage also rely on this.
cache.hydrate();

/**
 * Top-level router. Owns the single NavigateProvider for all three modes.
 *
 * - `/`, `/foo/...`    → RoutedPage (public — anonymous visitors render via `public` role)
 * - `/v/<path>`         → ViewPage (direct node render, requires auth)
 * - `/t/<path>`         → Editor (tree inspector, requires auth)
 *
 * Auth model: see useAuth — anonymous → claims=['public'], otherwise trpc.me userId.
 */
export function Router() {
  const { authed, authChecked, showLoginModal, setAuthed, closeLoginModal, logout } = useAuth();
  const { pathname, search } = useLocation();

  const mode = detectMode(pathname);
  const viewPath = detectViewPath(pathname);

  // Per-mode href builders preserve mode-relevant query params (root for editor, ctx for view)
  // so chained navigation inside a view stays in the same scope/context.
  const makeHref = useCallback((path: string) => {
    if (mode === 'editor') {
      const root = new URLSearchParams(search).get('root') || '/';
      return makeEditorHref(path === '/' ? '/' : path, root);
    }
    if (mode === 'view') {
      const ctx = new URLSearchParams(search).get('ctx');
      const base = `/v${path}`;
      return ctx && ctx !== 'react' ? `${base}?ctx=${encodeURIComponent(ctx)}` : base;
    }
    return path;
  }, [mode, search]);

  const navigate = useCallback((path: string) => navigateTo(makeHref(path)), [makeHref]);
  const navCtx = useMemo(() => makeNavigateApi(navigate, makeHref), [navigate, makeHref]);

  if (!authChecked) return null;

  // Public routed pages render for anonymous visitors — no login gate.
  if (mode === 'routed') {
    return (
      <NavigateProvider value={navCtx}>
        <RoutedPage path={viewPath} />
      </NavigateProvider>
    );
  }

  // Protected modes require a real session.
  if (!authed) return <LoginScreen onLogin={setAuthed} />;

  if (mode === 'view') {
    const ctx = new URLSearchParams(search).get('ctx') || 'react';
    return (
      <NavigateProvider value={navCtx}>
        <ViewPage path={viewPath} ctx={ctx} />
      </NavigateProvider>
    );
  }

  // mode === 'editor'
  const isAnon = authed.startsWith('anon:');
  return (
    <NavigateProvider value={navCtx}>
      <Editor authed={authed} onLogout={logout} />
      {showLoginModal && (
        <LoginModal
          onLogin={(uid) => { setAuthed(uid); closeLoginModal(); }}
          onClose={isAnon ? undefined : closeLoginModal}
        />
      )}
    </NavigateProvider>
  );
}
