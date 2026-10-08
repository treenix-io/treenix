// Read-only facades used by executeAction when method kind === 'read'.
// Handler may read state but any write (`tree.set`, assignment on `ctx.node`,
// `this.x = …`) throws FORBIDDEN.
//
// `wrapReadOnlyTree`   — blocks tree-level mutation methods.
// `readonlyProxy`      — deep Proxy that throws on mutation.

import { KernelError } from '#errors';
import type { ScanChildrenOpts, Tree, TreeWatchOpts, TreeWatchScope } from '#tree';

function deny(action: string): never {
  throw new KernelError('FORBIDDEN', `read-only context: ${action} is forbidden`);
}

async function* readonlyResults<T extends object>(source: AsyncIterable<T>): AsyncIterable<T> {
  for await (const value of source) yield readonlyProxy(value);
}

export function wrapReadOnlyTree(tree: Tree): Tree {
  // Spread forwards the full read surface — get, getChildren, and the optional
  // capabilities. Returned objects must stay immutable too: reads may share
  // nested data with the cache or another watch consumer.
  const { execute: _execute, ...readSurface } = tree;
  const scanChildren = tree.scanChildren?.bind(tree);
  const watch = tree.watch?.bind(tree);
  // execute is STRIPPED, not denied: it is a write channel (core-pxlu), and
  // capability PRESENCE marks foreign authority — a deny stub would make this
  // facade look exec-capable. Absent key → callers fall back to the local
  // executor, where the kind-stack rejects write actions inside a read frame.
  return {
    ...readSurface,
    get: async (path, ctx) => {
      const node = await tree.get(path, ctx);
      return node ? readonlyProxy(node) : node;
    },
    getChildren: async (path, opts, ctx) => readonlyProxy(await tree.getChildren(path, opts, ctx)),
    ...(scanChildren ? {
      scanChildren: (path: string, opts?: ScanChildrenOpts, ctx?: unknown) => readonlyResults(scanChildren(path, opts, ctx)),
    } : {}),
    ...(watch ? {
      watch: (scope: TreeWatchScope, opts?: TreeWatchOpts, ctx?: unknown) => readonlyResults(watch(scope, opts, ctx)),
    } : {}),
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
      throw new KernelError('CONFLICT', `action aborted: ${verb} after timeout is forbidden — the path lock is no longer held`);
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

function readonlyValue(value: unknown): unknown {
  return value !== null && typeof value === 'object' ? readonlyProxy(value) : value;
}

export function readonlyProxy<T extends object>(target: T): T {
  const hit = proxies.get(target);
  if (hit) return hit as T;
  // A frozen source slot cannot legally return a protected child when the
  // source itself is the proxy target. An empty shadow keeps reads lazy.
  const shadow: T = Array.isArray(target) ? [] : Object.create(Object.getPrototypeOf(target));
  const proxy = new Proxy(shadow, {
    get: (_t, prop, receiver) => readonlyValue(Reflect.get(target, prop, receiver)),
    has: (_t, prop) => Reflect.has(target, prop),
    ownKeys: () => Reflect.ownKeys(target),
    getPrototypeOf: () => Reflect.getPrototypeOf(target),
    getOwnPropertyDescriptor: (_t, prop) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, prop);
      if (!descriptor) return undefined;
      if ('value' in descriptor) {
        const length = Array.isArray(target) && prop === 'length';
        return { ...descriptor, value: readonlyValue(descriptor.value), configurable: !length, writable: length };
      }
      return {
        enumerable: descriptor.enumerable,
        configurable: true,
        get: descriptor.get ? () => readonlyValue(Reflect.get(target, prop, proxy)) : undefined,
        set: descriptor.set ? () => deny(`assign ${String(prop)}`) : undefined,
      };
    },
    set: (_t, prop) => deny(`assign ${String(prop)}`),
    deleteProperty: (_t, prop) => deny(`delete ${String(prop)}`),
    defineProperty: (_t, prop) => deny(`defineProperty ${String(prop)}`),
    setPrototypeOf: () => deny('set prototype'),
    preventExtensions: () => deny('prevent extensions'),
  });
  proxies.set(target, proxy);
  return proxy;
}
