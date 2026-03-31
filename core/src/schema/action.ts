// $schema — default action for introspecting any node
// Returns type schema, available actions, and schemas of all components on the node.

import { isComponent, register, resolve } from '#core';
import type { ActionCtx } from '#server/actions';

register('default', 'action:$schema', (ctx: ActionCtx) => {
  const node = ctx.node;
  const nodeType = node.$type;

  // Node's own type schema
  const typeSchema = (resolve(nodeType, 'schema') as (() => unknown) | null)?.() ?? null;

  // Collect component schemas from named keys
  const components: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(node)) {
    if (key.startsWith('$')) continue;
    if (!isComponent(val)) continue;
    const compSchema = (resolve(val.$type, 'schema') as (() => unknown) | null)?.() ?? null;
    components[key] = { $type: val.$type, schema: compSchema };
  }

  return { type: nodeType, schema: typeSchema, components };
});
