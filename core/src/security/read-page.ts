import type { NodeData } from '#core';
import type { Page } from '#tree';
import type { ReadPlan } from '#tree/read-runtime';

export type PageReadPlan = {
  plan: ReadPlan;
  mountDeps: ReadonlySet<string>;
};

const plans = new WeakMap<Page<NodeData>, PageReadPlan>();

export function attachPageReadPlan(page: Page<NodeData>, readPlan: PageReadPlan): void {
  plans.set(page, readPlan);
}

export function getPageReadPlan(page: Page<NodeData>): PageReadPlan | undefined {
  return plans.get(page);
}
