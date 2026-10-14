import type { LaneMember } from '@treenx/core/client/twp';
import { KernelError } from '@treenx/core/errors';
import type { NodeCopy, ReadResult, SubSelector } from '@treenx/core/kernel/types';
import type { NativeSnapshot } from '#tree/native-source';

export interface NativeHydrationState {
  readonly reads: readonly { readonly selector: SubSelector; readonly result: ReadResult }[];
}

/** Present a request-owned read without admitting copies or claims to a lane cache. */
export function readSnapshot(result: ReadResult): NativeSnapshot {
  const copies = new Map(
    result.copies.map((copy) => ['node' in copy ? copy.node.$id : copy.id, copy]),
  );
  const computed = new Map(result.computed?.map((node) => [node.$id, node]));
  const errors = new Map(result.viewErrors?.map((copy) => [copy.id, copy]));
  const output: LaneMember[] = [];
  const members: NodeCopy[] = [];
  const memberIds = new Set(result.list);
  for (const id of result.list) {
    const node = computed.get(id);
    if (node !== undefined) output.push({ kind: 'computed', node });
    else {
      const copy = copies.get(id) ?? errors.get(id);
      if (copy === undefined) throw new KernelError('INVALID', 'Read member has no owned payload');
      output.push({ kind: 'copy', copy });
      members.push(copy);
    }
  }
  const included: NodeCopy[] = [];
  const computedIncluded = [];
  const viewErrorsIncluded = [];
  for (const [id, node] of computed) if (!memberIds.has(id)) computedIncluded.push(node);
  for (const [id, copy] of errors) if (!memberIds.has(id)) viewErrorsIncluded.push(copy);
  for (const [id, copy] of copies) if (!memberIds.has(id)) included.push(copy);
  return {
    phase: 'ready',
    generations: [],
    members,
    included,
    output,
    viewOwner: result.viewOwner,
    computed: result.computed,
    rows: result.rows,
    viewErrors: result.viewErrors,
    computedIncluded,
    viewErrorsIncluded,
    next: result.next,
  };
}
