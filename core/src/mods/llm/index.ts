// Treenity LLM Context — Layer 6
// Schema export + tree description for LLM consumption
// Type: t.llm — node at /llm, actions: schema, describe

import { getContextsForType, getRegisteredTypes, register, resolve } from '#core';
import { basename } from '#core/path';
import { type ActionCtx } from '#server/actions';

export type TypeInfo = {
  type: string;
  schema: Record<string, unknown> | null;
  contexts: string[];
  actions: string[];
};

export type SchemaExport = { types: TypeInfo[] };

export function exportSchemaForLLM(): SchemaExport {
  const types = getRegisteredTypes();
  return {
    types: types.map((type) => {
      const contexts = getContextsForType(type);
      const schemaHandler = resolve(type, 'schema');
      return {
        type,
        schema: schemaHandler ? (schemaHandler() as Record<string, unknown>) : null,
        contexts: contexts.filter((c) => !c.startsWith('action:')),
        actions: contexts.filter((c) => c.startsWith('action:')).map((c) => c.slice(7)),
      };
    }),
  };
}

export async function describeTree(ctx: ActionCtx, data: unknown): Promise<string> {
  const { depth = 3 } = (data as { depth?: number }) ?? {};
  const path = ctx.node.$path;
  const lines: string[] = [];

  async function walk(p: string, indent: number, remaining: number): Promise<void> {
    if (remaining <= 0) return;
    const { items } = await ctx.store.getChildren(p);
    items.sort((a, b) => a.$path.localeCompare(b.$path));
    for (const child of items) {
      lines.push(`${'  '.repeat(indent)}${basename(child.$path)} (${child.$type})`);
      await walk(child.$path, indent + 1, remaining - 1);
    }
  }

  lines.push(`${path} (${ctx.node.$type})`);
  await walk(path, 1, depth);
  return lines.join('\n');
}

/** @description Export all registered types with schemas, contexts, and actions for LLM consumption */
register('t.llm', 'action:schema', () => exportSchemaForLLM());
/** @description Describe the subtree under this node as indented text (depth-limited) */
register('t.llm', 'action:describe', describeTree);
