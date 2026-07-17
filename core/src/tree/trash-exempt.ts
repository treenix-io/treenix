// Trash-exempt namespace registry (core-gk8.8 / core-anz4.7). Split out of
// policy.ts so mods can register an exemption WITHOUT the pipeline wrapper
// (withStoragePolicy) becoming public API — this file is a public door, policy.ts
// stays private.
//
// System namespaces (/sys/**, /auth/**, /proc/**, and / itself) hard-delete —
// infra, session secrets, and /sys/trash must purge without recursion.
// Everything else soft-deletes into /sys/trash. Overlay mods (branch) add their
// write-isolated namespaces here: the policy trash step judges a remove by its
// VIEW path, so without the exemption a branch-view remove copies isolated
// content into the real /sys/trash — the delta whiteout is already the safety copy.

import { assertSafePath } from '#core/path';

// Built-ins are immutable; dynamic registrations are reference-counted so a
// duplicate registration's unregister cannot strip someone else's exemption.
const BUILTIN = ['/sys', '/auth', '/proc'];
const DYNAMIC = new Map<string, number>();

export function isTrashExempt(path: string): boolean {
  if (path === '/') return true;
  const hit = (p: string) => path === p || path.startsWith(p + '/');
  return BUILTIN.some(hit) || [...DYNAMIC.keys()].some(hit);
}

/** Register an additional hard-delete namespace (core-anz4.7). Trusted-mod
 *  surface (same in-process trust as register()). Returns the unregister. */
export function addTrashExempt(prefix: string): () => void {
  assertSafePath(prefix);
  if (BUILTIN.includes(prefix)) return () => {};
  DYNAMIC.set(prefix, (DYNAMIC.get(prefix) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const n = DYNAMIC.get(prefix) ?? 0;
    if (n <= 1) DYNAMIC.delete(prefix);
    else DYNAMIC.set(prefix, n - 1);
  };
}
