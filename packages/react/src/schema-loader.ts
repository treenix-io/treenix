// Lazy registry loader — fetches type nodes from /sys/types on demand
import { type ContextHandlers, register, resolve } from '@treenity/core/core';
import type { TypeSchema } from '@treenity/core/schema/types';
import { useEffect, useState } from 'react';
import { trpc } from './trpc';

// ── Fetcher ──────────────────────────────────────────────────────────────────

const fetched = new Set<string>();
const inflight = new Map<string, Promise<void>>();

/** Fetch /sys/types/{type} and register its contexts into the core registry. */
export async function ensureType(type: string): Promise<void> {
  if (fetched.has(type)) return;
  if (inflight.has(type)) return inflight.get(type);

  const promise = trpc.get
    .query({ path: `/sys/types/${type.replace(/\./g, '/')}` })
    .then((node: any) => {
      const schema = node?.schema;
      if (schema?.$id && !resolve(schema.$id, 'schema')) {
        register(schema.$id, 'schema', () => schema);
      }
    })
    .catch(() => {}) // type may have no schema — not an error
    .finally(() => {
      fetched.add(type);
      inflight.delete(type);
    });

  inflight.set(type, promise);
  return promise;
}

// ── Hook ─────────────────────────────────────────────────────────────────────

/**
 * Lazy registry hook — returns the handler itself, not its result.
 * undefined = loading, null = not found, Handler = ready.
 *
 * Calling convention is context-specific:
 *   'react'  — handler IS the component:   useReg(type, 'react') → FC
 *   'schema' — handler is a thunk:          useReg(type, 'schema')?.() → TypeSchema
 *
 * Use useSchema() for the ergonomic schema shortcut.
 */
export function useReg<K extends keyof ContextHandlers>(
  type: string | null | undefined,
  context: K,
): ContextHandlers[K] | null | undefined;
export function useReg<T extends (...args: any[]) => any>(
  type: string | null | undefined,
  context: string,
): T | null | undefined;
export function useReg(type: string | null | undefined, context: string) {
  const get = () => {
    if (!type) return null;
    return resolve(type, context) ?? undefined;
  };

  const [handler, setHandler] = useState(get);

  useEffect(() => {
    if (!type) { setHandler(null); return; }
    const h = resolve(type, context);
    if (h) { setHandler(() => h); return; }
    setHandler(undefined);
    ensureType(type).then(() => {
      const h2 = resolve(type, context);
      setHandler(h2 ? () => h2 : null);
    });
  }, [type, context]);

  return handler;
}

// ── Schema convenience ────────────────────────────────────────────────────────

/** undefined = loading, null = no schema, TypeSchema = ready */
export function useSchema(type: string | null | undefined): TypeSchema | null | undefined {
  const getter = useReg(type, 'schema');
  if (getter === undefined) return undefined;
  return (getter as (() => TypeSchema) | null)?.() ?? null;
}
