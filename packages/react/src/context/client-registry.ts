import type { ReactHandler } from '#context';
import { normalizeType, type Class, type ContextHandler, type Handler, type TypeId } from '@treenx/core';
import { declareOpenModule } from '@treenx/core/kernel/module-declaration';
import type { OpenModule, OpenRegistration } from '@treenx/core/kernel/types';
import type { ClientTypeDeclaration, ClientSchemaDeclaration } from '@treenx/core/comp/client-declaration';
import type { TextHandler, TextOpenRegistration } from '@treenx/core/contexts/text';
import { formatContext, matchesContext, parseContext, parseRegistration, prefersContext, registrationContext,
  type ContextSelector } from '#context/selectors';

export interface ClientViewDeclaration extends OpenRegistration<ReactHandler> {
  readonly binding?: 'react';
  readonly meta?: Record<string, unknown>;
}

export interface ClientModule extends OpenModule<ReactHandler | TextHandler> {
  readonly open: readonly (ClientViewDeclaration | TextOpenRegistration)[];
  readonly resolveMissing?: (type: string, context: string) => ClientViewDeclaration | undefined;
  readonly types?: readonly ClientTypeDeclaration[];
}

interface OwnedSchema {
  readonly declaration: ClientSchemaDeclaration;
  readonly value: ClientSchemaDeclaration;
}

interface ClientVariant {
  readonly entry: ClientViewDeclaration;
  readonly selector: ContextSelector;
}

function variant(entry: ClientViewDeclaration): ClientVariant {
  const selector = parseRegistration(entry.context);
  return { selector, entry: { ...entry, type: normalizeType(entry.type), context: registrationContext(selector) } };
}

function selectVariant(candidates: readonly ClientVariant[] | undefined, request: ContextSelector): ClientVariant | undefined {
  let best: ClientVariant | undefined;
  for (const candidate of candidates ?? []) {
    if (matchesContext(candidate.selector, request) && (!best || prefersContext(candidate.selector, best.selector, request)))
      best = candidate;
  }
  return best;
}

function duplicateView(key: string): never {
  throw Object.assign(new Error(`Duplicate client view: ${key}`), { code: 'DUPLICATE_VIEW' });
}

export function declareView<T>(type: Class<T>, context: string, handler: ContextHandler<'react', T>, meta?: Record<string, unknown>): ClientViewDeclaration;
export function declareView(type: string, context: string, handler: ContextHandler<'react'>, meta?: Record<string, unknown>): ClientViewDeclaration;
export function declareView(type: TypeId, context: string, handler: ContextHandler<'react'>, meta?: Record<string, unknown>): ClientViewDeclaration;
export function declareView(type: TypeId, context: string, handler: Handler, meta?: Record<string, unknown>): ClientViewDeclaration {
  return { type: normalizeType(type), context, handler, ...(meta === undefined ? {} : { meta }) };
}

export function declareClientModule(id: string, open: readonly ClientViewDeclaration[],
  resolveMissing?: ClientModule['resolveMissing'], types?: readonly ClientTypeDeclaration[]): ClientModule {
  return { ...declareOpenModule(id, open, types), ...(resolveMissing === undefined ? {} : { resolveMissing }) };
}

/** Publish the declarations exported by the owning client module. */
export function publishClientExports(entry: { readonly clientModules: readonly ClientModule[] }): void {
  for (const module of entry.clientModules) publishClientModule(module);
}

/** Module declarations contain code; each rendering owner owns its mutable publication. */
export function createClientRegistry(initial: readonly ClientModule[] = []) {
  const modules = new Map(initial.map(module => [module.id, module]));
  const listeners = new Set<() => void>();
  let revision = {};
  let entries = new Map<string, ClientViewDeclaration>();
  let variants = new Map<string, ClientVariant[]>();
  let types = new Map<string, ClientTypeDeclaration>();
  let schemas = new Map<string, OwnedSchema>();

  function rebuild(): void {
    const next = new Map<string, ClientViewDeclaration>();
    const nextVariants = new Map<string, ClientVariant[]>();
    const nextTypes = new Map<string, ClientTypeDeclaration>();
    const nextSchemas = new Map<string, OwnedSchema>();
    for (const module of modules.values()) for (const type of module.types ?? []) {
      if (type.kind === 'class') {
        if (nextTypes.has(type.type)) throw new Error(`Duplicate client class: ${type.type}`);
        nextTypes.set(type.type, type);
      } else {
        if (nextSchemas.has(type.type)) throw new Error(`Duplicate client schema: ${type.type}`);
        const previous = schemas.get(type.type);
        nextSchemas.set(type.type, previous?.declaration === type ? previous : {
          declaration: type, value: { ...type, ...type.createReader() },
        });
      }
    }
    for (const module of modules.values()) for (const entry of module.open) {
      let candidate: ClientVariant;
      if (entry.binding === 'text') {
        const text = entry.handler;
        candidate = variant({ type: entry.type, context: entry.context, handler: ({ value }) => text(value) });
      } else candidate = variant(entry);
      const key = `${candidate.entry.type}@${candidate.entry.context}`;
      if (next.has(key)) duplicateView(key);
      next.set(key, candidate.entry);
      const baseKey = `${candidate.entry.type}@${candidate.selector.base}`;
      const bucket = nextVariants.get(baseKey);
      if (bucket) bucket.push(candidate);
      else nextVariants.set(baseKey, [candidate]);
    }
    entries = next;
    variants = nextVariants;
    types = nextTypes;
    schemas = nextSchemas;
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
      return entries.get(`${normalizeType(type)}@${registrationContext(parseRegistration(context))}`) ?? null;
    },
    type(type: string): ClientTypeDeclaration | undefined {
      const normalized = normalizeType(type);
      return types.get(normalized) ?? schemas.get(normalized)?.value;
    },
    schema(type: string) {
      return schemas.get(normalizeType(type))?.value.schema();
    },
    typesForContext(context: string): string[] {
      const canonical = registrationContext(parseRegistration(context));
      const names: string[] = [];
      for (const entry of entries.values())
        if (entry.context === canonical) names.push(normalizeType(entry.type));
      return names;
    },
    allContexts(type: string): string[] {
      const normalized = normalizeType(type);
      const declared = types.get(normalized);
      const result = declared === undefined ? [] : [...declared.contexts];
      for (const entry of entries.values())
        if (normalizeType(entry.type) === normalized && !result.includes(entry.context)) result.push(entry.context);
      const schema = schemas.get(normalized);
      if (schema !== undefined) for (const context of schema.declaration.contexts)
        if (!result.includes(context)) result.push(context);
      return result;
    },
    contexts(type: string): string[] {
      const normalized = normalizeType(type);
      const result: string[] = [];
      for (const entry of entries.values()) {
        if (normalizeType(entry.type) === normalized) result.push(entry.context);
      }
      return result;
    },
    resolve(type: string, context: string | ContextSelector, notifyMissing = true): ClientViewDeclaration | null {
      const normalized = normalizeType(type);
      const request = typeof context === 'string' ? parseContext(context) : context;
      let current = request.base;
      for (;;) {
        let exact = selectVariant(variants.get(`${normalized}@${current}`), request);
        if (!exact && notifyMissing) {
          const loaded: ClientVariant[] = [];
          const keys = new Set<string>();
          for (const module of modules.values()) {
            const declaration = module.resolveMissing?.(normalized, current);
            if (declaration === undefined) continue;
            const candidate = variant(declaration);
            if (candidate.entry.type !== normalized || candidate.selector.base !== current)
              throw new TypeError(`Lazy view does not match ${normalized}@${current}`);
            const key = `${normalized}@${candidate.entry.context}`;
            if (keys.has(key) || entries.has(key)) duplicateView(key);
            keys.add(key);
            loaded.push(candidate);
          }
          exact = selectVariant(loaded, request);
        }
        const fallback = selectVariant(variants.get(`${normalizeType('default')}@${current}`), request);
        if (exact && (!fallback || exact.selector.modifiers.size >= fallback.selector.modifiers.size)) return exact.entry;
        if (fallback) return fallback.entry;
        const suffix = current.lastIndexOf(':');
        if (suffix <= 0) {
          if ([...request.modifiers.values()].includes(true))
            throw Object.assign(new Error(`Missing required view variant: ${normalized}@${formatContext(request)}`), {
              code: 'MISSING_REQUIRED_VARIANT',
            });
          return null;
        }
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
