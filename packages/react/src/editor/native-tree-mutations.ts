import { between } from '@treenx/core/kernel/order';
import { KernelError } from '@treenx/core/errors';
import type { ChangeMember, CommitRequest, Node } from '@treenx/core/kernel/types';

/** Address the destination parent without guessing from a cached legacy tree. */
export function parentOf(path: string): string {
  return path.slice(0, path.lastIndexOf('/')) || '/';
}

/** Move before an actual visible sibling, assigning fractional order in the same atomic commit. */
export function moveBefore(
  from: Node,
  target: Node,
  siblings: readonly Node[],
  complete: boolean,
): Omit<CommitRequest, 'opId'> {
  const parent = parentOf(target.$path);
  const name = from.$path.slice(from.$path.lastIndexOf('/') + 1);
  const path = parent === '/' ? `/${name}` : `${parent}/${name}`;
  const remaining = siblings.filter((node) => node.$id !== from.$id);
  const index = remaining.findIndex((node) => node.$id === target.$id);
  if (index < 0) throw new KernelError('CONFLICT', 'The drop target left this child window');
  const previous = remaining[index - 1];
  const changes: ChangeMember[] = [];
  const expected = new Map<string, string>([
    [from.$path, from.$rev],
    [target.$path, target.$rev],
  ]);
  if (path !== from.$path) changes.push({ op: 'move', from: from.$path, to: path });

  if (
    target.$order !== undefined &&
    (previous === undefined || (previous.$order !== undefined && previous.$order < target.$order))
  ) {
    changes.push({
      op: 'patch',
      path,
      ops: { $set: { $order: between(previous?.$order, target.$order) } },
    });
  } else {
    if (!complete)
      throw new KernelError(
        'UNAVAILABLE',
        'Load the remaining children before ordering an unranked list',
      );
    const ordered = [...remaining];
    ordered.splice(index, 0, { ...from, $path: path });
    let order: string | undefined;
    for (const node of ordered) {
      order = between(order);
      expected.set(node.$id === from.$id ? from.$path : node.$path, node.$rev);
      changes.push({ op: 'patch', path: node.$path, ops: { $set: { $order: order } } });
    }
  }

  return { changes, expect: { nodes: [...expected].map(([path, rev]) => ({ path, rev })) } };
}
