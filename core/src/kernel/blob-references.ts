import { KernelError } from '#errors';
import type { BlobRef, Budget, JournalCommit } from '#kernel/types';
import { isRecord } from '#util/is-record';

/** Shared traversal counter for reference validation and maintenance work. */
export interface BlobReferenceWork { exprWork: number }

/** Decodes a reference at the node-write boundary, where binary data is forbidden. */
export function decodeReference(value: unknown): BlobRef {
  if (
    !isRecord(value) ||
    typeof value.$blob !== 'string' ||
    typeof value.type !== 'string' ||
    typeof value.size !== 'number' ||
    !Number.isSafeInteger(value.size) ||
    value.size < 0 ||
    Object.keys(value).some((key) => key !== '$blob' && key !== 'size' && key !== 'type')
  )
    throw new KernelError('INVALID', 'Malformed blob reference');
  return { $blob: value.$blob, size: value.size, type: value.type };
}

/** Walks admitted JSON values once, with an explicit budget at node-write boundaries. */
function visitReferences(value: unknown, accept: (item: Record<string, unknown>) => void,
  budget?: Budget, work: BlobReferenceWork = { exprWork: 0 }): void {

  /** Finds binary references without permitting embedded binary values. */
  function visit(item: unknown): void {
    work.exprWork++;
    if (budget !== undefined && (work.exprWork > budget.exprWork || Date.now() > budget.deadline))
      throw new KernelError('BUDGET', 'Blob reference validation exceeded its budget');
    if (item === null || typeof item !== 'object') return;
    if (ArrayBuffer.isView(item) || item instanceof ArrayBuffer || item instanceof SharedArrayBuffer)
      throw new KernelError('INVALID', 'Binary content belongs in a blob');
    if (Array.isArray(item)) {
      for (const child of item) visit(child);
      return;
    }
    if (!isRecord(item)) throw new KernelError('INVALID', 'Malformed node data');
    if (Object.hasOwn(item, '$blob')) {
      accept(item);
      return;
    }
    // Visit own values incrementally so a refused walk never allocates an unbounded values array.
    for (const key in item) if (Object.hasOwn(item, key)) visit(item[key]);
  }

  visit(value);
}

/** Validates each distinct reference's metadata at the authored node-write boundary. */
export function blobReferences(value: unknown, budget?: Budget, work?: BlobReferenceWork): ReadonlyMap<string, BlobRef> {
  const references = new Map<string, BlobRef>();
  visitReferences(value, item => {
    const ref = decodeReference(item);
    const previous = references.get(ref.$blob);
    if (previous !== undefined && (previous.size !== ref.size || previous.type !== ref.type))
      throw new KernelError('INVALID', 'Conflicting blob reference metadata');
    references.set(ref.$blob, ref);
  }, budget, work);
  return references;
}

/** Holds identities in accepted data, including externally detected unresolved references. */
export function blobIds(value: unknown, budget?: Budget, work?: BlobReferenceWork): readonly string[] {
  const ids = new Set<string>();
  visitReferences(value, item => {
    if (typeof item.$blob !== 'string') throw new KernelError('INVALID', 'Blob identity is malformed');
    ids.add(item.$blob);
  }, budget, work);
  return [...ids];
}

/** Retains references on both sides of every canonical journal transition. */
export function journalBlobIds(record: JournalCommit, budget?: Budget, work?: BlobReferenceWork): readonly string[] {
  return blobIds(record.entries, budget, work);
}
