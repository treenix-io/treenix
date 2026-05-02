// Server-safe view for SSR. No auth, no useLocation — reads URL tail from
// RouteParamsContext and the node from TreeSource. Renders target node in
// 'site' context. Per Phase 4, 'site' resolves strictly — child types
// without a site view will surface MissingSiteViewError.
//
// File is .ts (uses createElement, no JSX) so the tsx runner doesn't need
// per-package jsx config to transpile this when loaded by the Node server.

import { createElement } from 'react';
import { Render, RenderContext } from '@treenx/react/context';
import { usePath } from '@treenx/react/hooks';
import { useRouteParams } from '@treenx/react/context/route-params';
import { register } from '@treenx/core';
import { ViewShell } from './types';

const ViewShellSiteView = () => {
  const { rest } = useRouteParams();
  const path = '/' + rest;
  const { data: node } = usePath(path);
  if (!node) return createElement('div', null, 'Not found: ' + path);
  return createElement(
    RenderContext,
    { name: 'site' },
    createElement(Render, { value: node }),
  );
};

register(ViewShell, 'site', ViewShellSiteView);
