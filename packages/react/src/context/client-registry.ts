import { observeRegistrations } from '@treenx/core/core/registration';
import type { Registration } from '@treenx/core/core/registration';
import type { ReactHandler } from '#context';
import { normalizeType } from '@treenx/core';

export interface ClientViewDeclaration {
  readonly type: string;
  readonly context: string;
  readonly handler: ReactHandler;
  readonly meta?: Record<string, unknown>;
}

export interface ClientModule {
  readonly id: string;
  readonly views: readonly ClientViewDeclaration[];
  readonly resolveMissing?: (type: string, context: string) => ClientViewDeclaration | undefined;
}

/** Module declarations contain code; each rendering owner owns its mutable publication. */
export function createClientRegistry(initial: readonly ClientModule[] = []) {
  const modules = new Map(initial.map(module => [module.id, module]));
  const listeners = new Set<() => void>();
  let revision = {};
  let entries = new Map<string, ClientViewDeclaration>();

  function rebuild(): void {
    const next = new Map<string, ClientViewDeclaration>();
    for (const module of modules.values()) for (const entry of module.views) {
      const key = `${normalizeType(entry.type)}@${entry.context}`;
      if (next.has(key)) throw new Error(`Duplicate client view: ${key}`);
      next.set(key, entry);
    }
    entries = next;
  }

  rebuild();
  return {
    publish(module: ClientModule): void {
      const previous = modules.get(module.id);
      modules.set(module.id, module);
      try { rebuild(); }
      catch (error) {
        if (previous === undefined) modules.delete(module.id);
        else modules.set(module.id, previous);
        throw error;
      }
      revision = {};
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    getSnapshot: () => revision,
    exact(type: string, context: string): ClientViewDeclaration | null {
      return entries.get(`${normalizeType(type)}@${context}`) ?? null;
    },
    contexts(type: string): string[] {
      const normalized = normalizeType(type);
      const result: string[] = [];
      for (const entry of entries.values()) {
        if (normalizeType(entry.type) === normalized) result.push(entry.context);
      }
      return result;
    },
    resolve(type: string, context: string, notifyMissing = true): ClientViewDeclaration | null {
      const normalized = normalizeType(type);
      let current = context;
      for (;;) {
        const exact = entries.get(`${normalized}@${current}`);
        if (exact !== undefined) return exact;
        if (notifyMissing) for (const module of modules.values()) {
          const loaded = module.resolveMissing?.(normalized, current);
          if (loaded !== undefined) return loaded;
        }
        const fallback = entries.get(`${normalizeType('default')}@${current}`);
        if (fallback !== undefined) return fallback;
        const suffix = current.lastIndexOf(':');
        if (suffix <= 0) return null;
        current = current.slice(0, suffix);
      }
    },
  };
}

export type ClientRegistry = ReturnType<typeof createClientRegistry>;

const declaredModules = new Map<string, ClientModule>();
const owners = new Map<ClientRegistry, number>();

/** Republish one module to the currently mounted rendering owners. */
export function publishClientModule(module: ClientModule): void {
  declaredModules.set(module.id, module);
  for (const owner of owners.keys()) owner.publish(module);
}

export function createDeclaredClientRegistry(): ClientRegistry {
  return createClientRegistry([...declaredModules.values()]);
}

/** Subscribe only while mounted so closed sources retain no publication listeners. */
export function mountClientRegistry(registry: ClientRegistry): () => void {
  for (const module of declaredModules.values()) registry.publish(module);
  owners.set(registry, (owners.get(registry) ?? 0) + 1);
  return () => {
    const count = owners.get(registry);
    if (count === undefined) throw new Error('Client registry is not mounted');
    if (count === 1) owners.delete(registry);
    else owners.set(registry, count - 1);
  };
}

// Existing UI modules still emit declarations through the core registration producer.
const importedViews = new Map<string, Registration>();
observeRegistrations(registration => {
  if (registration.context !== 'react' && !registration.context.startsWith('react:')) return;
  const key = `${registration.type}@${registration.context}`;
  if ('remove' in registration) importedViews.delete(key);
  else if (!importedViews.has(key)) importedViews.set(key, registration);
  publishClientModule({ id: 'imported-views', views: [...importedViews.values()] });
});
