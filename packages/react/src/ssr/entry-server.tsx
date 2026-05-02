// SSR entry — invoked by @treenx/ssr's handler. Wraps a node render in the
// minimal provider stack (TreeSource + RouteParams + RenderContext='site') and
// returns an HTML string. Render mode picks the React DOM API:
//   'static'  → renderToStaticMarkup (no React markers, smaller output)
//   'hydrate' → renderToString (markers needed for hydrateRoot)

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
  const tree = (
    <TreeSourceProvider source={source}>
      <RouteParamsContext.Provider value={{ rest, full: pathname }}>
        <RenderContext name="site">
          <Render value={node} />
        </RenderContext>
      </RouteParamsContext.Provider>
    </TreeSourceProvider>
  );
  return mode === 'hydrate' ? renderToString(tree) : renderToStaticMarkup(tree);
}
