// TreeSourceProvider — mandatory. Hooks (usePath, useChildren) throw a
// TreeSourceMissingError when no Provider is in the tree. Tests that mount
// hooks must wrap; the SPA root mounts a principal-owned LaneTreeSource here, and
// the SSR entry mounts a per-request ServerTreeSource.
//
// Implementation note: this file is .ts (not .tsx) so the tsx-runner-based
// test suite resolves `#tree/tree-source-context` cleanly. The package.json
// imports field's `.ts → .tsx` array fallback only fires under Vite/build,
// not under the test runner.

import { createContext, createElement, type ReactNode, useContext, useEffect, useMemo } from 'react';
import { ClientRegistryContext } from '#context/client-registry-context';
import { createDeclaredClientRegistry, mountClientRegistry, type ClientRegistry } from '#context/client-registry';
import { type TreeSource, TreeSourceMissingError } from './tree-source';

const Ctx = createContext<TreeSource | null>(null);
const registries = new WeakMap<TreeSource, ClientRegistry>();

function sourceRegistry(source: TreeSource): ClientRegistry {
  let registry = registries.get(source);
  if (registry === undefined) {
    registry = createDeclaredClientRegistry();
    registries.set(source, registry);
  }
  return registry;
}

export function TreeSourceProvider({
  source,
  registry: suppliedRegistry,
  children,
}: {
  source: TreeSource;
  registry?: ClientRegistry;
  children: ReactNode;
}) {
  const registry = useMemo(() => suppliedRegistry ?? sourceRegistry(source), [source, suppliedRegistry]);
  useEffect(() => suppliedRegistry === undefined ? mountClientRegistry(registry) : undefined,
    [registry, suppliedRegistry]);
  return createElement(Ctx.Provider, { value: source },
    createElement(ClientRegistryContext.Provider, { value: registry }, children));
}

export function useTreeSource(): TreeSource {
  const source = useContext(Ctx);
  if (!source) throw new TreeSourceMissingError();
  return source;
}

/** Read-only action controls can render without installing a data or mutation source. */
export function useOptionalTreeSource(): TreeSource | null {
  return useContext(Ctx);
}
