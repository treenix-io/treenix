// ONE commit envelope for in-process mutation surfaces (core-gk8.15).
// lock → OCC (test ops, evaluated by the pipeline) → apply (ACL/validate/
// $refs/$id/CDC all run inside tree.patch / tree.patchMany) → CONFLICT map.
// Serialization is in-process only — adapters' OCC stays the cross-process
// guard. Kind frames and actor identity are the CALLER's concern (they are
// request-scoped, not commit-scoped).

import { OpError } from '#errors';
import { type PatchManyEntry, type Tree } from '#tree';
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
        await tree.patch(entries[0].path, entries[0].ops, ctx);
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

  // Sorted acquisition: two commits sharing members always lock in the same
  // order — no deadlock; reentrancy covers an enclosing action span that
  // already holds one of the paths. Fold builds outermost = first sorted path.
  const paths = [...new Set(entries.map(e => e.path))].sort();
  let run = apply;
  for (const p of paths.reverse()) {
    const inner = run;
    run = () => mutationLock(p, inner);
  }
  await run();
}
