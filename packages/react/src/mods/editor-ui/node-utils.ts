import { getComponents as getComps, getContextsForType, type NodeData, resolve } from '@treenx/core';
import type { PropertySchema, TypeSchema } from '@treenx/core/schema/types';

export function getComponents(node: NodeData): [string, Record<string, unknown>][] {
  return getComps(node).slice(1);
}

export function getPlainFields(node: NodeData): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (k.startsWith('$')) continue;
    if (typeof v === 'object' && v !== null && '$type' in v) continue;
    out[k] = v;
  }
  return out;
}

export function getSchema(type: string): TypeSchema | null {
  const h = resolve(type, 'schema');
  return h ? (h() as TypeSchema) : null;
}

const INTERNAL_CONTEXTS = new Set(['schema', 'mount', 'class']);

export function getViewContexts(type: string, node?: NodeData): string[] {
  const ctxs = getContextsForType(type).filter(
    (c) => !INTERNAL_CONTEXTS.has(c) && !c.startsWith('action:'),
  );
  // Also collect view contexts from component types present on the node
  if (node) {
    for (const [, comp] of getComponents(node)) {
      for (const c of getContextsForType((comp as any).$type)) {
        if (!INTERNAL_CONTEXTS.has(c) && !c.startsWith('action:') && !ctxs.includes(c)) {
          ctxs.push(c);
        }
      }
    }
  }
  return ctxs;
}

export function getActions(type: string, schema?: TypeSchema | null): string[] {
  const actions = getContextsForType(type)
    .filter((c) => c.startsWith('action:') && !c.includes(':', 'action:'.length))
    .map((c) => c.slice('action:'.length))
    .filter((a) => !a.startsWith('_'));

  // Schema is the client-side contract: server-only actions declared in schema.methods
  // are discoverable by all clients (browser, MCP, external) without the implementation
  if (schema?.methods) {
    for (const name of Object.keys(schema.methods)) {
      if (!name.startsWith('_') && !actions.includes(name)) actions.push(name);
    }
  }

  return actions;
}

// Returns action param schema from generated schema.methods[action].arguments[0].
// null  → no schema info (show JSON textarea fallback)
// properties={} → confirmed no params (hide params section)
// properties={…} → typed form fields
export function getActionSchema(type: string, action: string): TypeSchema | null {
  const schema = getSchema(type);
  if (!schema?.methods) return null;
  const method = schema.methods[action];
  if (!method) return null;
  if (method.arguments.length === 0) return { title: action, type: 'object', properties: {} };
  const arg = method.arguments[0];
  if (arg.type !== 'object' || !arg.properties || Object.keys(arg.properties).length === 0)
    return { title: action, type: 'object', properties: {} };
  return {
    title: method.title ?? action,
    type: 'object',
    properties: arg.properties as Record<string, PropertySchema>,
  };
}

export function pickDefaultContext(_type: string): string {
  return 'react:layout';
}
