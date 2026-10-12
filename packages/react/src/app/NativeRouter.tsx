import { useEffect, useMemo } from 'react';
import { getComponent } from '@treenx/core';
import { Seo } from '@treenx/ssr/types/seo';
import { NodeProvider, Render, RenderContext } from '#context';
import { RouteParamsContext } from '#context/route-params';
import { makeNavigateApi, NavigateProvider, navigateTo, useLocation } from '#navigate';
import { useRouteResolve } from '#router/use-route-resolve';
import { useTreeEffects } from '#tree/effects';
import { RoutedPage } from '#app/RoutedPage';
import { LoginModal } from '#app/Login';
import { useAuthContext, type AuthState } from '#app/auth-context';

/** Render only the route projection admitted by the current native source. */
export function NativeRouter() {
  return <NativeRoutePage auth={useAuthContext()} />;
}

/** Share route presentation with SSR, where the request-scoped Reader already owns authentication. */
export function NativeRoutePage({ auth }: { auth?: AuthState }) {
  const effects = useTreeEffects();
  const { pathname } = useLocation();
  const { result, target, loading, isPublic, error } = useRouteResolve(pathname);
  const navigation = useMemo(
    () =>
      makeNavigateApi(
        (path) => navigateTo(path),
        (path) => path,
      ),
    [],
  );

  const title = result === null ? undefined : getComponent(result.node, Seo)?.title;
  useEffect(() => {
    const name = (target ?? pathname).replace(/^\/+/, '');
    document.title = title ?? (name ? `${name} | Treenix` : 'Treenix');
  }, [title, target, pathname]);

  if (auth !== undefined && !auth.authChecked) return null;
  const login =
    auth === undefined ? null : (
      <LoginModal
        onLogin={(uid) => {
          auth.setAuthed(uid);
          auth.closeLoginModal();
        }}
        onClose={auth.authed === null ? undefined : auth.closeLoginModal}
      />
    );
  if (auth !== undefined && auth.authed === null && !isPublic)
    return <NavigateProvider value={navigation}>{login}</NavigateProvider>;
  if (error !== null)
    return (
      <div role="alert" className="p-4 text-destructive">
        {error.message}
      </div>
    );
  if (loading && result === null) return null;
  return (
    <NavigateProvider value={navigation}>
      {result === null ? (
        <RoutedPage path={pathname || '/'} />
      ) : (
        <RouteParamsContext.Provider value={{ rest: result.rest, full: pathname }}>
          <RenderContext name="react:route">
            <NodeProvider value={result.node}>
              <Render
                value={result.node}
                ctx={{
                  node: result.node,
                  path: result.node.$path,
                  execute: (action, data) => effects.execute(result.node.$path, action, data),
                }}
              />
            </NodeProvider>
          </RenderContext>
        </RouteParamsContext.Provider>
      )}
      {auth?.showLoginModal && login}
    </NavigateProvider>
  );
}
