// Top-level router. Single resolver against /sys/routes drives every URL.
// Adding a new top-level route now means seeding a node, not editing this file.
//
// Flow:
//   pathname → useRouteResolve → /sys/routes/<key> NodeData → <Render value=node>
//
// Each shell view (t.editor.shell / t.view.shell / …) reads its own route
// component (prefix/index) via useRouteShell and provides its own NavigateProvider
// — Router only supplies a default identity nav for catch-all / login modal.

import { useMemo } from 'react';
import { LoginModal } from './Login';
import { RoutedPage } from './RoutedPage';
import { useAuthContext } from './auth-context';
import { Render, RenderContext } from '#context';
import { RouteParamsContext } from '#context/route-params';
import { makeNavigateApi, NavigateProvider, navigateTo, useLocation } from '#navigate';
import * as cache from '#tree/cache';
import { useRouteResolve } from '#router/use-route-resolve';

// Hydrate cache from IDB before first render — RoutedPage relies on this.
cache.hydrate();

export function Router() {
  const { authed, authChecked, showLoginModal, setAuthed, closeLoginModal } = useAuthContext();
  const { pathname } = useLocation();

  const { result, loading: routeLoading, isPublic } = useRouteResolve(pathname);

  // Default identity nav for catch-all / login modal. Shell views override
  // this via inner <NavigateProvider> with route-aware makeHref.
  const defaultNav = useMemo(
    () => makeNavigateApi(p => navigateTo(p), p => p),
    [],
  );

  if (!authChecked) return null;
  // Don't flash the public fallback while route data is still loading.
  if (routeLoading && !result) return null;

  // Global auth gate: unauth user sees only the login modal — unless the
  // matched route opts in via t.route.public, then it renders for anon.
  if (!authed && !isPublic) {
    return (
      <NavigateProvider value={defaultNav}>
        <LoginModal onLogin={(uid) => { setAuthed(uid); closeLoginModal(); }} />
      </NavigateProvider>
    );
  }

  const isAnon = !!authed && authed.startsWith('anon:');
  const modalCloseable = !!authed && !isAnon;
  const modal = showLoginModal && (
    <LoginModal
      onLogin={(uid) => { setAuthed(uid); closeLoginModal(); }}
      onClose={modalCloseable ? closeLoginModal : undefined}
    />
  );

  if (result) {
    return (
      <NavigateProvider value={defaultNav}>
        <RouteParamsContext.Provider value={{ rest: result.rest, full: pathname }}>
          <RenderContext name="react:route">
            <Render value={result.node} />
          </RenderContext>
        </RouteParamsContext.Provider>
        {modal}
      </NavigateProvider>
    );
  }

  return (
    <NavigateProvider value={defaultNav}>
      <RoutedPage path={pathname || '/'} />
      {modal}
    </NavigateProvider>
  );
}
