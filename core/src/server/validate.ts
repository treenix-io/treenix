// Write-Barrier — validates node components against their schemas before store.set()
// Rejects writes with malformed data. AI agents get "compilation errors" instead of garbage in DB.

import { validateNode } from '#comp/validate';
import type { Tree } from '#tree';

export function withValidation(store: Tree): Tree {
  return {
    ...store,
    async set(node) {
      const errors = validateNode(node);
      if (errors.length) {
        const msg = errors.map(e => `${e.path}#${e.field}.${e.prop}: ${e.message}`).join('; ');
        throw new Error(`Validation: ${msg}`);
      }
      return store.set(node);
    },
    async patch(path, ops, ctx) {
      return store.patch(path, ops, ctx);
    },
  };
}
