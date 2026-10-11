import { KernelError } from '#errors'
import type { Store, StoreCommit, StoreCommitGroup } from '#kernel/types'

/** Distinct handles share atomic effects only through their explicit durable owner. */
export function sameStoreOwner(left: Store, right: Store): boolean {
  return left === right || left.transactionOwner !== undefined &&
    left.transactionOwner === right.transactionOwner && left.domain === right.domain &&
    left.transactionOwner.domain === left.domain
}

/** Enumerates each durable decision owner once while preserving standalone Store identity. */
export function uniqueStoreOwners(stores: Iterable<Store>): Store[] {
  const seen = new Set<Store | NonNullable<Store['transactionOwner']>>(), result: Store[] = [];
  for (const store of stores) {
    const owner = store.transactionOwner ?? store;
    if (store.transactionOwner !== undefined && store.transactionOwner.domain !== store.domain)
      throw new KernelError('INVALID', 'Store transaction owner domain differs');
    if (!seen.has(owner)) { seen.add(owner); result.push(store); }
  }
  return result;
}

/** Refuses mismatched participants or a partition differing from the canonical writes. */
export function assertCommitGroups(store: Store, commit: Pick<StoreCommit, 'writes'>, groups: readonly StoreCommitGroup[]): void {
  if (groups.length < 2 || store.transactionOwner === undefined)
    throw new KernelError('INVALID', 'Grouped commit requires a shared atomic owner');
  const handles = new Set<Store>(), writes = new Map(commit.writes.map(write => [write.path, write]));
  if (writes.size !== commit.writes.length) throw new KernelError('INVALID', 'Duplicate canonical write address');
  for (const group of groups) {
    if (!sameStoreOwner(store, group.store) || handles.has(group.store))
      throw new KernelError('CROSS_DOMAIN', 'Grouped commit spans atomic Store owners');
    handles.add(group.store);
    for (const write of group.writes) {
      const canonical = writes.get(write.path);
      if (canonical === undefined || canonical.node !== write.node)
        throw new KernelError('INVALID', 'Grouped writes differ from canonical commit');
      writes.delete(write.path);
    }
  }
  if (!handles.has(store) || writes.size !== 0)
    throw new KernelError('INVALID', 'Grouped writes do not partition canonical commit');
}
