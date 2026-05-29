// Read-only facades used by executeAction when method kind === 'read'.
// Handler may read state but any write (`tree.set`, assignment on `ctx.node`,
// `this.x = …`) throws KIND_VIOLATION.
//
// `wrapReadOnlyTree`   — blocks tree-level mutation methods.
// `readonlyProxy`      — shallow Proxy that throws on assignment/delete.
//                        Sufficient for direct field writes; deeper nested
//                        mutation through returned objects falls outside this
//                        layer (handlers shouldn't reach for it from a read).

import { OpError } from '#errors';
import type { Tree } from '#tree';

function deny(action: string): never {
  throw new OpError('KIND_VIOLATION', `read-only context: ${action} is forbidden`);
}

export function wrapReadOnlyTree(tree: Tree): Tree {
  // Spread forwards the full read surface — get, getChildren, and the optional
  // scanChildren/watch (both pure reads a handler may legitimately use); only
  // mutations are denied. Hand-listing read methods would silently drop
  // scanChildren and break the read runtime if this facade ever fed a source.
  return {
    ...tree,
    set: () => deny('tree.set()'),
    patch: () => deny('tree.patch()'),
    remove: () => deny('tree.remove()'),
  };
}

export function readonlyProxy<T extends object>(target: T): T {
  return new Proxy(target, {
    set: (_t, prop) => deny(`assign ${String(prop)}`),
    deleteProperty: (_t, prop) => deny(`delete ${String(prop)}`),
    defineProperty: (_t, prop) => deny(`defineProperty ${String(prop)}`),
  });
}
