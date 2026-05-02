// SSR entry — invoked by @treenx/ssr's handler. Wraps a node render in the
// minimal provider stack (TreeSource + RouteParams + RenderContext='site') and
// returns an HTML string. Render mode picks the React DOM API:
//   'static'  → renderToStaticMarkup (no React markers, smaller output)
//   'hydrate' → renderToString (markers needed for hydrateRoot)
//
// File is .ts (not .tsx) so cross-package importers that go through the `./*`
// exports map don't need the .ts→.tsx array fallback to fire under tsx.

import { createElement } from 'react';
import { renderToStaticMarkup, renderToString } from 'react-dom/server';
import type { NodeData } from '@treenx/core';
import { TreeSourceProvider } from '#tree/tree-source-context';
import type { TreeSource } from '#tree/tree-source';
import { RouteParamsContext } from '#context/route-params';
import { Render, RenderContext } from '#context';

export type RenderMode = 'static' | 'hydrate';

export type RenderArgs = {
  source: TreeSource;
  node: NodeData;
  rest: string;
  mode: RenderMode;
  /** Full URL pathname for context (e.g. "/about"). */
  pathname?: string;
};

export function render({ source, node, rest, mode, pathname = '' }: RenderArgs): string {
  const tree = createElement(
    TreeSourceProvider,
    { source },
    createElement(
      RouteParamsContext.Provider,
      { value: { rest, full: pathname } },
      createElement(
        RenderContext,
        { name: 'site' },
        createElement(Render, { value: node }),
      ),
    ),
  );
  return mode === 'hydrate' ? renderToString(tree) : renderToStaticMarkup(tree);
}
