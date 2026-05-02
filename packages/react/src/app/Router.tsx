// Top-level router. Single resolver against /sys/routes drives every URL;
// the legacy /t // /v // public mode switch is gone. Adding a new top-level
// route now means seeding a node, not editing this file.
//
// Flow:
//   pathname → useRouteResolve → /sys/routes/<key> NodeData → <Render value=node>
//
// The route node's registered React view ('react' context) handles the page,
// reading useRouteParams().rest for the URL tail. NavigateProvider preserves
// query params per route flavour (?root= for editor-shell, ?ctx= for view-shell).
// Anything not matched falls through to RoutedPage (today's public catch-all,
// to be replaced by /sys/routes/_index in Phase 6).

import { useCallback, useMemo } from 'react';
import { LoginModal } from './Login';
import { RoutedPage } from './RoutedPage';
import { useAuthContext } from './auth-context';
import { Render, RenderContext } from '#context';
import { RouteParamsContext } from '#context/route-params';
import { makeEditorHref, makeNavigateApi, NavigateProvider, navigateTo, useLocation } from '#navigate';
import * as cache from '#tree/cache';
import { useRouteResolve } from '#tree/use-route-resolve';

// Hydrate cache from IDB before first render — RoutedPage relies on this.
cache.hydrate();

type NavMode = 'editor' | 'view' | 'public';

function navModeFor(type: string | undefined): NavMode {
  if (type === 't.editor.shell') return 'editor';
  if (type === 't.view.shell') return 'view';
  return 'public';
}

export function Router() {
  const { authed, authChecked, showLoginModal, setAuthed, closeLoginModal } = useAuthContext();
  const { pathname, search } = useLocation();

  const { result, loading: routeLoading } = useRouteResolve(pathname);

  // Per-mode href builders preserve query params: ?root= for editor-shell
  // and ?ctx= for view-shell. Other routes get clean URLs.
  const navMode = navModeFor(result?.node.$type);
  const makeHref = useCallback((path: string) => {
    if (navMode === 'editor') {
      const root = new URLSearchParams(search).get('root') || '/';
      return makeEditorHref(path === '/' ? '/' : path, root);
    }
    if (navMode === 'view') {
      const ctx = new URLSearchParams(search).get('ctx');
      const base = `/v${path}`;
      return ctx && ctx !== 'react' ? `${base}?ctx=${encodeURIComponent(ctx)}` : base;
    }
    return path;
  }, [navMode, search]);

  const navigate = useCallback((path: string) => navigateTo(makeHref(path)), [makeHref]);
  const navCtx = useMemo(() => makeNavigateApi(navigate, makeHref), [navigate, makeHref]);

  if (!authChecked) return null;
  // Don't flash the public fallback while route data is still loading.
  if (routeLoading && !result) return null;

  // Resolved: render the route node via the registry. Auth (if needed) is
  // gated by the route's view itself.
  if (result) {
    const isAnon = !!authed && authed.startsWith('anon:');
    return (
      <NavigateProvider value={navCtx}>
        <RouteParamsContext.Provider value={{ rest: result.rest, full: pathname }}>
          <RenderContext name="react">
            <Render value={result.node} />
          </RenderContext>
        </RouteParamsContext.Provider>
        {showLoginModal && (
          <LoginModal
            onLogin={(uid) => { setAuthed(uid); closeLoginModal(); }}
            onClose={isAnon ? undefined : closeLoginModal}
          />
        )}
      </NavigateProvider>
    );
  }

  // Catch-all: today's public path renderer. Phase 6 replaces this with a
  // /sys/routes/_index entry that the resolver matches.
  return (
    <NavigateProvider value={navCtx}>
      <RoutedPage path={pathname || '/'} />
    </NavigateProvider>
  );
}
