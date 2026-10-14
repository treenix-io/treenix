import { KernelError } from '#errors';
import { prepareChangeSet } from '#kernel/changeset';
import { comparePositions } from '#kernel/position';
import type { Writer } from '#kernel/writer';
import type {
  BackfillGeneration,
  Budget,
  Limits,
  Registry,
  Store,
  StoreBackfillNode,
} from '#kernel/types';
import type { OperationReadCost } from '#kernel/store/budget';

export interface BackfillOptions {
  readonly writer: Writer;
  readonly store: Store;
  readonly registry: Registry;
  readonly limits: () => Limits;
  readonly budget: () => Budget;
  readonly active?: () => boolean;
}

/** Each accepted cursor shares the migrated write's normal Writer transaction. */
export async function runBackfill(options: BackfillOptions): Promise<void> {
  const { writer, store, registry } = options;
  const native = store.backfill;
  if (native === undefined) return;
  for (const target of registry.migrations) {
    for (;;) {
      if (options.active?.() === false) return;
      const { state } = await native.state(target.type, options.budget());
      if (state?.generation === target.generation && state.complete) break;
      let complete = false;
      await writer.commit(store, [], async (pos) => {
        const limits = options.limits(),
          allowance = options.budget();
        if (limits.changeSet < 1)
          throw new KernelError('BUDGET', 'Backfill ChangeSet allowance is empty');
        const { state: current, cost: stateCost } = await native.state(target.type, allowance);
        const page = await native.page(
          current?.generation === target.generation ? current.after : undefined,
          {
            ...allowance,
            nodes: allowance.nodes - stateCost.nodes,
            bytes: allowance.bytes - stateCost.bytes,
            exprWork: allowance.exprWork - stateCost.exprWork,
          },
          1,
        );
        if (page.cost === undefined)
          throw new KernelError('INVALID', 'Backfill metadata cost is absent');
        const metadata = page.items[0];
        complete = metadata === undefined;
        const changes =
          metadata !== undefined &&
          needsMigration(metadata, target, registry.type(target.type).aliases ?? [])
            ? [{ op: 'patch' as const, path: metadata.$path, ops: {} }]
            : [];
        let remaining = {
          ...allowance,
          nodes: allowance.nodes - stateCost.nodes - page.cost.nodes,
          bytes: allowance.bytes - stateCost.bytes - page.cost.bytes,
          exprWork: allowance.exprWork - stateCost.exprWork - page.cost.exprWork,
        };
        const readCost: OperationReadCost = {
          budget: () => remaining,
          charge(nodes, bytes, exprWork = 0) {
            remaining = {
              ...remaining,
              nodes: remaining.nodes - nodes,
              bytes: remaining.bytes - bytes,
              exprWork: remaining.exprWork - exprWork,
            };
            if (
              remaining.nodes < 0 ||
              remaining.bytes < 0 ||
              remaining.exprWork < 0 ||
              Date.now() >= remaining.deadline
            )
              throw new KernelError('BUDGET', 'Backfill cumulative read allowance exceeded');
          },
          refuse(error) {
            throw error;
          },
        };
        const prepared = await prepareChangeSet(
          { store, cache: writer.cache, registry, limits, readCost, budget: remaining },
          changes,
          pos,
          { executor: 'kernel', caller: 'kernel' },
        );
        if (metadata !== undefined && changes.length !== 0) {
          const before = prepared.transitions.find((change) => change.id === metadata.$id)?.before;
          if (
            before === undefined ||
            before === null ||
            before.$path !== metadata.$path ||
            comparePositions(before.$pos, metadata.$pos) !== 0
          )
            throw new KernelError('CONFLICT', 'Backfill node changed after its metadata page');
        }
        return {
          ...prepared,
          maintenanceLimits: { budget: remaining, changeSet: limits.changeSet },
          record: {
            ...prepared.record,
            kind: 'kernel' as const,
            backfill: { ...target, after: metadata?.$path ?? current?.after, complete },
          },
          check() {
            if (
              registry.migrations.find((item) => item.type === target.type)?.generation !==
              target.generation
            )
              throw new KernelError('CONFLICT', 'Backfill migration generation changed');
            prepared.check?.();
          },
        };
      });
      if (complete) break;
    }
  }
}

/** Main and named components use the same canonical type/version migration contract. */
function needsMigration(
  node: StoreBackfillNode,
  target: BackfillGeneration,
  aliases: readonly string[],
): boolean {
  return [node.main, ...Object.values(node.named)].some(
    (component) =>
      (component.$type === target.type || aliases.includes(component.$type)) &&
      (component.$v ?? 0) < target.version,
  );
}
