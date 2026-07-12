// ONE commit envelope for in-process mutation surfaces (core-gk8.15).
// lock → OCC (test ops, evaluated by the pipeline) → apply (ACL/validate/
// $refs/$id/CDC all run inside tree.patch / tree.patchMany) → CONFLICT map.
// Serialization is in-process only — adapters' OCC stays the cross-process
// guard. Kind frames and actor identity are the CALLER's concern (they are
// request-scoped, not commit-scoped).

import { OpError } from '#errors';
import { isSetEntry, type PatchManyEntry, type Tree } from '#tree';
import { PatchTestError } from '#tree/patch';
import { createPathLock } from '#util/path-lock';

/** THE shared mutation-lock scope: executeAction spans and commit() batches
 *  serialize against each other here. Reentrant per async chain — an action's
 *  own commit re-acquires its span path inline. */
export const mutationLock = createPathLock();

/** Commit a batch of patches under the lock envelope. N=1 compiles to
 *  tree.patch (what executeAction's commit block always was); N>1 dispatches
 *  tree.patchMany under `ancestor` (all-or-nothing, stage A). */
export async function commit(tree: Tree, ancestor: string, entries: PatchManyEntry[], ctx?: unknown): Promise<void> {
  if (!entries.length) throw new OpError('BAD_REQUEST', 'commit: empty batch');

  const apply = async (): Promise<void> => {
    try {
      if (entries.length === 1) {
        const only = entries[0];
        if (isSetEntry(only)) await tree.set(only.node, ctx);
        else await tree.patch(only.path, only.ops, ctx);
      } else {
        if (!tree.patchMany) {
          throw new OpError('BAD_REQUEST', 'commit: tree does not support patchMany');
        }
        await tree.patchMany(ancestor, entries, ctx);
      }
    } catch (e) {
      // Single-patch path propagates raw PatchTestError (pipeline contract);
      // inside the envelope a failed test op IS a concurrency loss.
      if (e instanceof PatchTestError) {
        throw new OpError('CONFLICT', `commit: ${entries[0].path} changed concurrently (test op failed)`);
      }
      throw e;
    }
  };

  await lockPaths(entries.map(e => e.path), apply);
}

/** Acquire the mutationLock on every path (dedup, sorted) around fn.
 *  Sorted acquisition: two batches sharing members always lock in the same
 *  order — no deadlock; reentrancy covers an enclosing action span that
 *  already holds one of the paths. Fold builds outermost = first sorted path. */
export function lockPaths<T>(paths: string[], fn: () => Promise<T>): Promise<T> {
  let run = fn;
  for (const p of [...new Set(paths)].sort().reverse()) {
    const inner = run;
    run = () => mutationLock(p, inner);
  }
  return run();
}

/** Route every in-process mutation verb through the mutationLock
 *  (core-anz4.4). Composed in createPipeline between audit and withExecute,
 *  so wire verbs, foreign-path ctx.tree.* writes, stream writes and the full
 *  soft-remove span (trash copy → remove — policy sits below) serialize with
 *  executeAction spans and commit() batches. Closes the write→stored-reread
 *  windows in sub events and audit spans: a second write can no longer land
 *  inside them and poison the first write's event/row with a foreign
 *  after-image. Reads pass through — this is in-process serialization only;
 *  adapters' OCC stays the cross-process guard. */
export function withCommitEnvelope(tree: Tree): Tree {
  return {
    ...tree,

    set: (node, ctx) => mutationLock(node.$path, () => tree.set(node, ctx)),

    remove: (path, ctx) => mutationLock(path, () => tree.remove(path, ctx)),

    patch: (path, ops, ctx) => mutationLock(path, () => tree.patch(path, ops, ctx)),

    ...(tree.patchMany ? {
      patchMany: (ancestor: string, entries: PatchManyEntry[], ctx?: unknown) =>
        lockPaths(entries.map(e => e.path), () => tree.patchMany!(ancestor, entries, ctx)),
    } : {}),
  };
}
