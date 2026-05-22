// Write-Barrier — validates node components against their schemas before tree.set()
// Rejects writes with malformed data. AI agents get "compilation errors" instead of garbage in DB.

import { validateNode } from '#comp/validate';
import type { Tree } from '#tree';
import { patchViaSet } from '#tree';
import { OpError } from '#errors';

export function withValidation(tree: Tree): Tree {
  const wrapper: Tree = {
    ...tree,
    async set(node, ctx) {
      const errors = validateNode(node);
      if (errors.length) {
        const msg = errors.map(e => `${e.path}: ${e.message}`).join('; ');
        throw new OpError('BAD_REQUEST', `Validation: ${msg}`);
      }
      return tree.set(node, ctx);
    },
    async patch(path, ops, ctx) {
      return patchViaSet(wrapper, path, ops, ctx);
    },
  };
  return wrapper;
}
