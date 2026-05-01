// TreeSourceProvider — mandatory. Hooks (usePath, useChildren) throw a
// TreeSourceMissingError when no Provider is in the tree. Tests that mount
// hooks must wrap; the SPA root mounts a single ClientTreeSource here, and
// the SSR entry mounts a per-request ServerTreeSource.

import { createContext, type ReactNode, useContext } from 'react';
import { type TreeSource, TreeSourceMissingError } from './tree-source';

const Ctx = createContext<TreeSource | null>(null);

export function TreeSourceProvider({
  source,
  children,
}: {
  source: TreeSource;
  children: ReactNode;
}) {
  return <Ctx.Provider value={source}>{children}</Ctx.Provider>;
}

export function useTreeSource(): TreeSource {
  const source = useContext(Ctx);
  if (!source) throw new TreeSourceMissingError();
  return source;
}
