// View shell — registered for t.view.shell. Renders the node at the URL tail
// in a chosen RenderContext. /v/foo/bar → reads /foo/bar; ?ctx=react:compact
// switches the rendering context. No mutations, no chrome — read-only.

import { Render, RenderContext, useLocation, usePath, useAutoSave, view } from '@treenx/react';
import { useAuthContext } from '@treenx/react/app/auth-context';
import { LoginScreen } from '@treenx/react/app/Login';
import { useRouteParams } from '@treenx/react/context/route-params';
import { ViewShell } from './types';

const ViewShellView = () => {
  const { authed, authChecked, setAuthed } = useAuthContext();
  const { rest } = useRouteParams();
  const { search } = useLocation();
  const path = '/' + rest;
  const ctx = new URLSearchParams(search).get('ctx') || 'react';

  const { data: node, loading } = usePath(path);
  const { onChange } = useAutoSave(path);

  if (!authChecked) return null;
  if (!authed) return <LoginScreen onLogin={setAuthed} />;

  // Show 404 ONLY when fetch settled with no node. Loading-with-cached-node
  // (e.g. background refetch on SSE reconnect) keeps rendering the node.
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
    <div className="flex flex-col h-screen">
      <div className="flex-1 overflow-auto p-4 has-[.view-full]:p-0">
        <RenderContext name={ctx}>
          <Render value={node} onChange={onChange} />
        </RenderContext>
      </div>
    </div>
  );
};

view(ViewShell, ViewShellView);
