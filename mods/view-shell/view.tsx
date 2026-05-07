// View shell — registered for t.view.shell. Public read-only view of any node
// at the URL tail. Works in both `react` (client) and `site` (SSR) contexts:
// no auth gate (SSR is anonymous-only by design), no mutations, no chrome.
// Editor / authenticated flows live behind /t/* (t.editor.shell), not here.
//
// Render context comes from ?ctx=<name> (default 'react') and is preserved
// across navigations via useRouteShell's preserveQuery.

import { EMPTY, RouteParamsContext, useRouteParams } from '@treenx/react/context/route-params';
import {
  NavigateProvider,
  Render,
  RenderContext,
  useAutoSave,
  useLocation,
  usePath,
  type View,
  view,
} from '@treenx/react';
import { register } from '@treenx/core';
import { useRouteShell } from '@treenx/react/router/use-route-shell';
import { ViewShell } from './types';

const ViewShellView: View<ViewShell> = ({ ctx }) => {
  const { target, nav } = useRouteShell(ctx!.node, { preserveQuery: { ctx: 'react' } });
  const { search } = useLocation();
  const renderCtx = new URLSearchParams(search).get('ctx') || 'react';

  const { data: node, loading } = usePath(target);
  const { onChange } = useAutoSave(target);

  if (!node && !loading) {
    return (
      <div className="flex flex-col items-center justify-center h-screen gap-4 text-[--text-3]">
        <div className="text-4xl">404</div>
        <p>
          Node not found: <span className="font-mono">{target}</span>
        </p>
      </div>
    );
  }
  if (!node) {
    return (
      <div className="flex flex-col items-center justify-center h-screen gap-2 text-[--text-3]">
        <div className="text-sm">Loading…</div>
      </div>
    );
  }

  return (
    <RouteParamsContext value={EMPTY}>
      <NavigateProvider value={nav}>
        <div className="flex flex-col h-screen">
          <div className="flex-1 overflow-auto p-4 has-[.view-full]:p-0">
            <RenderContext name={renderCtx}>
              <Render value={node} onChange={onChange} />
            </RenderContext>
          </div>
        </div>
      </NavigateProvider>
    </RouteParamsContext>
  );
};

view(ViewShell, ViewShellView);
register(ViewShell, 'site', ViewShellView);
