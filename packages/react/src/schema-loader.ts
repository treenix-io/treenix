// Lazy registry loader — fetches type nodes from /sys/types on demand
import { createElement, type ReactNode, useEffect, useState } from 'react';
import { useSchemaMode } from '#tree/tree-source-context';
import { useClientRegistry } from '#context/client-registry-context';
import { KernelError } from '@treenx/core/errors';
import { usePath, useTreeEffects } from '#hooks';
import type { JsonSchema, Node } from '@treenx/core/kernel/types';
import type { NativeTypeDescription } from '@treenx/core/kernel/type-description';

// ── Schema convenience ────────────────────────────────────────────────────────

/** Read the selected owner's full native schema; an unselected type has no schema. */
export function useSchema(type: string | null | undefined): JsonSchema | null | undefined {
  const description = useNativeTypeDescription(type);
  return type ? description?.schema : null;
}

interface SchemaReaderProps {
  type: string;
  authored?: JsonSchema;
  children: (schema: JsonSchema | null, actions: readonly string[]) => ReactNode;
}

function NativeSchemaReader({ type, children }: SchemaReaderProps) {
  const description = useNativeTypeDescription(type);
  return description === undefined ? null : children(description.schema, Object.keys(description.actions));
}

function DeclaredSchemaReader({ type, authored, children }: SchemaReaderProps) {
  const registry = useClientRegistry();
  const schema = authored ?? registry.schema(type) ?? null;
  return children(schema, Object.keys(schema?.methods ?? {}));
}

/** Detached and reader-only rendering use authored declarations; mounted lanes use native authority. */
export function SchemaReader(props: SchemaReaderProps) {
  return createElement(useSchemaMode() === 'native' ? NativeSchemaReader : DeclaredSchemaReader, props);
}

declare module '#hooks' {
  interface ActionResults {
    't.type': { describe_type: NativeTypeDescription };
  }
}

/** Read the actual registry description through the selected source and live caller. */
export function useNativeTypeDescription(
  type: string | null | undefined,
  revision?: string,
): NativeTypeDescription | undefined {
  const effects = useTreeEffects();
  const { data: ownership, loading, error } = usePath<Node>(type ? `/sys/types/${type}` : null);
  const generation = revision ?? ownership?.$rev;
  const [loaded, setLoaded] = useState<{
    effects: typeof effects;
    type: string;
    generation?: string;
    value: NativeTypeDescription;
  }>();
  const [failure, setFailure] = useState<{
    effects: typeof effects;
    type: string;
    generation?: string;
    error: unknown;
  }>();

  useEffect(() => {
    if (!type || ownership === undefined || error !== null) return;
    let active = true;
    const kernel = effects.kernel;
    if (kernel === undefined) throw new Error('Native schema description requires a native source');
    effects.execute(`/sys/types/${type}`, 'describe_type', {}, 't.type').then(
      (result) => {
        if (active) setLoaded({ effects, type, generation, value: result });
      },
      (error) => {
        if (active) setFailure({ effects, type, generation, error });
      },
    );
    return () => {
      active = false;
    };
  }, [effects, type, generation, ownership === undefined, error]);

  if (error !== null) throw error;
  if (type && !loading && ownership === undefined)
    throw new KernelError('NOT_FOUND', `Type ownership is missing: ${type}`);
  if (failure?.effects === effects && failure.type === type && failure.generation === generation)
    throw failure.error;
  return loaded?.effects === effects && loaded.type === type && loaded.generation === generation
    ? loaded.value
    : undefined;
}
