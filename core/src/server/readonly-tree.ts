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
  const { execute: _execute, ...readSurface } = tree;
  // execute is STRIPPED, not denied: it is a write channel (core-pxlu), and
  // capability PRESENCE marks foreign authority — a deny stub would make this
  // facade look exec-capable. Absent key → callers fall back to the local
  // executor, where the kind-stack rejects write actions inside a read frame.
  return {
    ...readSurface,
    set: () => deny('tree.set()'),
    patch: () => deny('tree.patch()'),
    remove: () => deny('tree.remove()'),
    // Conditional: patchMany is an optional capability — an unconditional stub
    // would make every read facade LOOK batch-capable to probing wrappers.
    ...(tree.patchMany ? { patchMany: () => deny('tree.patchMany()') } : {}),
  };
}

/** Abort guard for a mutating action's ctx.tree. When the action timeout fires, the executor
 *  rejects the caller and the path lock is released — but the handler promise keeps running and
 *  cannot be killed. A resumed handler would then write against state a later action has already
 *  replaced, which silently breaks the per-path serialization other code relies on (core-gk8.15).
 *  Writes are denied from the moment the signal aborts; reads stay open so the handler can unwind. */
export function wrapAbortGuardTree(tree: Tree, signal: AbortSignal): Tree {
  const gate = (verb: string) => {
    if (signal.aborted) {
      throw new OpError('CONFLICT', `action aborted: ${verb} after timeout is forbidden — the path lock is no longer held`);
    }
  };
  return {
    ...tree,
    set: (node, ctx) => { gate('tree.set()'); return tree.set(node, ctx); },
    patch: (path, ops, ctx) => { gate('tree.patch()'); return tree.patch(path, ops, ctx); },
    remove: (path, ctx) => { gate('tree.remove()'); return tree.remove(path, ctx); },
    // Conditional for the same reason as the read facade: an unconditional stub would make
    // every guarded tree LOOK batch/exec-capable to wrappers that probe for the capability.
    ...(tree.patchMany ? { patchMany: (a, e, ctx) => { gate('tree.patchMany()'); return tree.patchMany!(a, e, ctx); } } : {}),
    ...(tree.execute ? { execute: (p, a, d, o, ctx) => { gate('tree.execute()'); return tree.execute!(p, a, d, o, ctx); } } : {}),
  };
}

// Deep: nodes handed to handlers are the node cache's live objects, so a
// shallow guard let `ctx.node.box.list.push(x)` rewrite cached data that other
// readers then saw, unpersisted. One proxy per object keeps identity stable.
const proxies = new WeakMap<object, object>();

export function readonlyProxy<T extends object>(target: T): T {
  const hit = proxies.get(target);
  if (hit) return hit as T;
  const proxy = new Proxy(target, {
    get: (t, prop, receiver) => {
      const v: unknown = Reflect.get(t, prop, receiver);
      if (v === null || typeof v !== 'object') return v;
      // Proxy invariant: a non-configurable, non-writable slot (frozen
      // parent) must return its exact value — it is immutable anyway.
      const d = Reflect.getOwnPropertyDescriptor(t, prop);
      return d && !d.configurable && !d.writable ? v : readonlyProxy(v);
    },
    set: (_t, prop) => deny(`assign ${String(prop)}`),
    deleteProperty: (_t, prop) => deny(`delete ${String(prop)}`),
    defineProperty: (_t, prop) => deny(`defineProperty ${String(prop)}`),
  });
  proxies.set(target, proxy);
  return proxy;
}
