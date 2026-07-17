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

const EXEMPT = ['/sys', '/auth', '/proc'];

export function isTrashExempt(path: string): boolean {
  return path === '/' || EXEMPT.some(p => path === p || path.startsWith(p + '/'));
}

/** Register an additional hard-delete namespace (core-anz4.7). Trusted-mod
 *  surface (same in-process trust as register()). Returns the unregister. */
export function addTrashExempt(prefix: string): () => void {
  assertSafePath(prefix);
  if (!EXEMPT.includes(prefix)) EXEMPT.push(prefix);
  return () => {
    const i = EXEMPT.indexOf(prefix);
    if (i >= 0) EXEMPT.splice(i, 1);
  };
}
