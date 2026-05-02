// TreeSourceProvider — mandatory. Hooks (usePath, useChildren) throw a
// TreeSourceMissingError when no Provider is in the tree. Tests that mount
// hooks must wrap; the SPA root mounts a single ClientTreeSource here, and
// the SSR entry mounts a per-request ServerTreeSource.
//
// Implementation note: this file is .ts (not .tsx) so the tsx-runner-based
// test suite resolves `#tree/tree-source-context` cleanly. The package.json
// imports field's `.ts → .tsx` array fallback only fires under Vite/build,
// not under the test runner.

import { createContext, createElement, type ReactNode, useContext } from 'react';
import { type TreeSource, TreeSourceMissingError } from './tree-source';

const Ctx = createContext<TreeSource | null>(null);

export function TreeSourceProvider({
  source,
  children,
}: {
  source: TreeSource;
  children: ReactNode;
}) {
  return createElement(Ctx.Provider, { value: source }, children);
}

export function useTreeSource(): TreeSource {
  const source = useContext(Ctx);
  if (!source) throw new TreeSourceMissingError();
  return source;
}
