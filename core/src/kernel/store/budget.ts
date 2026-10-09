import { KernelError } from '#errors';
import type { Budget, ScanResult } from '#kernel/types';

/** Caps one Store query by its own allowance and the caller deadline, rejecting late results. */
export async function runStoreQuery<T>(
  parent: Budget,
  queryMs: number,
  run: (budget: Budget) => Promise<T>,
): Promise<T> {
  const budget = { ...parent, deadline: Math.min(parent.deadline, Date.now() + queryMs) };
  /** Refuses query progress beyond the captured deadline. */
  function check(): void {
    if (Date.now() > budget.deadline)
      throw new KernelError('BUDGET', 'Store query deadline exceeded');
  }
  check();
  const result = await run(budget);
  check();
  return result;
}

export interface OperationReadCost {
  readonly budget: () => Budget
  readonly charge: (nodes: number, bytes: number, exprWork?: number) => void
  readonly refuse: (error: unknown) => never
}

/** Transfer a native scan's actual inspected cost into its enclosing operation. */
export async function runStoreScan<T>(
  parent: Budget,
  queryMs: number,
  run: (budget: Budget) => Promise<ScanResult<T>>,
  cost?: OperationReadCost,
): Promise<ScanResult<T>> {
  try {
    const shared = cost?.budget();
    const allowance =
      shared === undefined
        ? parent
        : {
            nodes: Math.min(parent.nodes, shared.nodes),
            bytes: Math.min(parent.bytes, shared.bytes),
            exprWork: Math.min(parent.exprWork, shared.exprWork),
            deadline: Math.min(parent.deadline, shared.deadline),
          };
    const result = await runStoreQuery(allowance, queryMs, run);
    if (cost !== undefined) {
      if (result.cost === undefined)
        throw new KernelError('INVALID', 'Store scan cost is absent');
      cost.charge(result.cost.nodes, result.cost.bytes, result.cost.exprWork);
    }
    return result;
  } catch (error) {
    if (cost !== undefined) cost.refuse(error);
    throw error;
  }
}
