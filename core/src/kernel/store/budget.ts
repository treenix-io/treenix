import { KernelError } from '#errors';
import type { Budget } from '#kernel/types';

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
