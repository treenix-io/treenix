import { createContext, useContext, useSyncExternalStore } from 'react';
import { createDeclaredClientRegistry, mountClientRegistry, type ClientRegistry } from './client-registry';

const detached = createDeclaredClientRegistry();
mountClientRegistry(detached);
export const ClientRegistryContext = createContext<ClientRegistry>(detached);

/** Resolve against the mounted source's publication and observe module replacements. */
export function useClientRegistry(): ClientRegistry {
  const registry = useContext(ClientRegistryContext);
  useSyncExternalStore(registry.subscribe, registry.getSnapshot, registry.getSnapshot);
  return registry;
}
