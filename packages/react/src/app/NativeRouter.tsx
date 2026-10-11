import { useMemo } from 'react';
import { NodeProvider, Render, RenderContext } from '#context';
import { RouteParamsContext } from '#context/route-params';
import { makeNavigateApi, NavigateProvider, navigateTo, useLocation } from '#navigate';
import { useRouteResolve } from '#router/use-route-resolve';
import { useTreeEffects } from '#tree/effects';
import { RoutedPage } from '#app/RoutedPage';

/** Render only the route projection admitted by the current native source. */
export function NativeRouter() {
  const effects = useTreeEffects();
  const { pathname } = useLocation();
  const { result, loading } = useRouteResolve(pathname);
  const navigation = useMemo(() => makeNavigateApi(path => navigateTo(path), path => path), []);
  if (loading && result === null) return null;
  return <NavigateProvider value={navigation}>
    {result === null ? <RoutedPage path={pathname || '/'} /> :
      <RouteParamsContext.Provider value={{ rest: result.rest, full: pathname }}>
        <RenderContext name="react:route"><NodeProvider value={result.node}><Render value={result.node} ctx={{ node: result.node, path: result.node.$path,
          execute: (action, data) => effects.execute(result.node.$path, action, data) }} /></NodeProvider></RenderContext>
      </RouteParamsContext.Provider>}
  </NavigateProvider>;
}
