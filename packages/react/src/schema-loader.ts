// Lazy registry loader — fetches type nodes from /sys/types on demand
import { type ContextHandlers, getComponent, type NodeData, register, resolve } from '@treenx/core';
import type { TypeSchema } from '@treenx/core/schema/types';
import { useEffect, useState } from 'react';
import { treeClient } from '#tree/tree-client';

// ── Fetcher ──────────────────────────────────────────────────────────────────

const fetched = new Set<string>();
const inflight = new Map<string, Promise<void>>();

function isNotFound(e: unknown): boolean {
  return typeof e === 'object' && e !== null && 'data' in e
    && typeof e.data === 'object' && e.data !== null && 'code' in e.data && e.data.code === 'NOT_FOUND';
}

/** Fetch /sys/types/{type} and register its contexts into the core registry. A failed fetch rejects and
 *  leaves the type unfetched, so the next caller asks again. */
export async function ensureType(type: string): Promise<void> {
  if (fetched.has(type)) return;
  const running = inflight.get(type);
  if (running) return running;

  const promise = treeClient
    .read({ kind: 'node', path: `/sys/types/${type.replace(/\./g, '/')}` })
    .then(
      (node: NodeData | undefined) => {
        // Named components live under '#' keys (namespace migration) — never read node.schema
        const schema = node && getComponent<TypeSchema & { $id: string }>(node, 'schema');
        if (schema?.$id && !resolve(schema.$id, 'schema')) {
          register(schema.$id, 'schema', () => schema);
        }
        fetched.add(type);
      },
      (e: unknown) => {
        // A type without a type node has no schema
        if (!isNotFound(e)) throw e;
        fetched.add(type);
      },
    )
    .finally(() => inflight.delete(type));

  inflight.set(type, promise);
  return promise;
}

// ── Hook ─────────────────────────────────────────────────────────────────────

/**
 * Lazy registry hook — returns the handler itself, not its result.
 * undefined = loading, null = not found, Handler = ready. A failed type fetch throws to the error boundary.
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
  const [failed, setFailed] = useState<{ error: unknown } | null>(null);

  useEffect(() => {
    if (!type) { setHandler(null); return; }
    const h = resolve(type, context);
    if (h) { setHandler(() => h); return; }
    setHandler(undefined);
    let cancelled = false;
    ensureType(type).then(
      () => {
        if (cancelled) return; // type changed mid-flight — don't clobber the current handler
        const h2 = resolve(type, context);
        setHandler(h2 ? () => h2 : null);
      },
      (error: unknown) => {
        if (!cancelled) setFailed({ error });
      },
    );
    return () => { cancelled = true; };
  }, [type, context]);

  if (failed) throw failed.error;
  return handler;
}

// ── Schema convenience ────────────────────────────────────────────────────────

/** undefined = loading, null = no schema, TypeSchema = ready */
export function useSchema(type: string | null | undefined): TypeSchema | null | undefined {
  const getter = useReg(type, 'schema');
  if (getter === undefined) return undefined;
  return (getter as (() => TypeSchema) | null)?.() ?? null;
}
