import { getComponent } from '@treenx/core';
import { KernelError } from '@treenx/core/errors';
import type { Node, Reader } from '@treenx/core/kernel/types';

export interface NativeBranchIndex {
  readonly paths: readonly string[];
}

/** Tracks sparse delta addresses; older unindexed branches retain their existing wrapper traversal. */
export async function nativeBranchPaths(root: Node, read: Reader): Promise<readonly string[]> {
  const index = getComponent<NativeBranchIndex>(root, 't.branch.index');
  if (index !== undefined) return index.paths;
  const paths: string[] = [];
  if (
    getComponent(root, 't.branch.delta') !== undefined ||
    getComponent(root, 't.branch.whiteout') !== undefined
  )
    paths.push('');
  const pending = [root.$path];
  for (let i = 0; i < pending.length; i++) {
    let after: string | undefined;
    do {
      const result = await read.read({
        children: pending[i],
        window: { limit: 100, ...(after === undefined ? {} : { after }) },
      });
      for (const copy of result.copies) {
        if ('error' in copy) throw copy.error;
        if (copy.node.$type !== 't.branch.delta' && copy.node.$type !== 't.branch.whiteout')
          throw new KernelError('CONFLICT', 'Branch upper contains a foreign wrapper');
        paths.push(copy.node.$path.slice(root.$path.length));
        pending.push(copy.node.$path);
      }
      after = result.next;
    } while (after !== undefined);
  }
  return paths;
}
