// View shell — registered for t.view.shell. Public read-only view of any node
// at the URL tail. Works in both `react` (client) and `site` (SSR) contexts:
// no auth gate (SSR is anonymous-only by design), no mutations, no chrome.
// Editor / authenticated flows live behind /t/* (t.editor.shell), not here.

import { Render, RenderContext, usePath, useAutoSave, view } from '@treenx/react';
import { EMPTY, RouteParamsContext, useRouteParams } from '@treenx/react/context/route-params';
import { register } from '@treenx/core';
import { ViewShell } from './types';

const ViewShellView = () => {
  const { rest } = useRouteParams();
  const path = '/' + rest;

  const { data: node, loading } = usePath(path);
  const { onChange } = useAutoSave(path);

  if (!node && !loading) {
    return (
      <div className="flex flex-col items-center justify-center h-screen gap-4 text-[--text-3]">
        <div className="text-4xl">404</div>
        <p>Node not found: <span className="font-mono">{path}</span></p>
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
      <div className="flex flex-col h-screen">
        <div className="flex-1 overflow-auto p-4 has-[.view-full]:p-0">
          <RenderContext name="react">
            <Render value={node} onChange={onChange} />
          </RenderContext>
        </div>
      </div>
    </RouteParamsContext>
  );
};

view(ViewShell, ViewShellView);
register(ViewShell, 'site', ViewShellView);
