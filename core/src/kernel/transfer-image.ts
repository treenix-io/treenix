import { createHash } from 'node:crypto';
import { KernelError } from '#errors';
import type { BlobReferenceWork } from '#kernel/blob-references';
import type { Budget, StoredNode } from '#kernel/types';
import { isRecord } from '#util/is-record';

/** Pins the complete admitted image without retaining a second node body. */
export function transferImageDigest(
  node: StoredNode,
  budget: Budget,
  work: BlobReferenceWork,
): string {
  const hash = createHash('sha256');

  /** Charge traversal and key sorting before allocating or hashing each unit. */
  function charge(amount: number): void {
    work.exprWork += amount;
    if (work.exprWork > budget.exprWork || Date.now() > budget.deadline)
      throw new KernelError('BUDGET', 'Transfer image validation exceeded its allowance');
  }

  /** Encode exact JSON values with stable object order and explicit separators. */
  function visit(value: unknown): void {
    charge(1);
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))
    ) {
      if (typeof value === 'string') charge(value.length);
      hash.update(JSON.stringify(value));
      return;
    }
    if (Array.isArray(value)) {
      hash.update('[');
      for (const item of value) {
        visit(item);
        hash.update(',');
      }
      hash.update(']');
      return;
    }
    if (!isRecord(value)) throw new KernelError('INVALID', 'Transfer image is not canonical JSON');
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      throw new KernelError('INVALID', 'Transfer image contains a non-JSON object');
    let count = 0;
    for (const key in value)
      if (Object.hasOwn(value, key)) {
        charge(1);
        count++;
      }
    charge(count * Math.ceil(Math.log2(Math.max(1, count))));
    const keys = Object.keys(value).sort();
    hash.update('{');
    for (const key of keys) {
      charge(key.length);
      hash.update(JSON.stringify(key));
      hash.update(':');
      visit(value[key]);
      hash.update(',');
    }
    hash.update('}');
  }

  visit(node);
  return hash.digest('hex');
}
