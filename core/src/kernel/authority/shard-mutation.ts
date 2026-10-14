import { getComponentField } from '#core/component';
import { isDeepStrictEqual } from 'node:util';
import { KernelError } from '#errors';
import type { ShardClient } from '#kernel/authority/shard-owner';
import type { ForeignActionInput, ForeignCommitInput } from '#kernel/commands';
import { judgeGates } from '#kernel/gates';
import { serializeKernel } from '#kernel/serialization';
import type {
  ActRequest,
  FederationForward,
  Gate,
  Outcome,
  Pending,
  Position,
} from '#kernel/types';
import type { Writer } from '#kernel/writer';

interface ShardMutationOptions {
  readonly writer: Writer;
  readonly mount: FederationForward['mount'];
  readonly gates: readonly Gate[];
  readonly open: () => Promise<ShardClient>;
  readonly active: () => void;
  readonly own: (client: ShardClient, pending: Pending) => { position(): Position | undefined };
}

/** Retains one same-zone mutation under the existing local durable forwarding decision. */
export async function runShardCommit(
  options: ShardMutationOptions & { readonly input: ForeignCommitInput },
): Promise<Outcome> {
  const { input } = options;
  let handle: ShardClient | undefined;
  function check(saved?: FederationForward): void {
    input.signal.throwIfAborted();
    input.cost.budget();
    options.active();
    handle?.active();
    if (saved !== undefined && !isDeepStrictEqual(saved.mount, options.mount))
      throw new KernelError('CONFLICT', 'Shard declaration differs from its retained request');
  }
  async function connection(): Promise<ShardClient> {
    check();
    const current = await input.wait(options.open());
    await input.wait(current.check());
    handle = current;
    check();
    return current;
  }
  async function prepare(): Promise<FederationForward> {
    const current = await connection();
    if (options.writer.intake.shards?.[current.connection.instance] !== current.connection.intake)
      await input.wait(
        options.writer.publishShardIntake(current.connection.instance, current.connection.intake),
      );
    await input.wait(current.check());
    check();
    input.cost.charge(0, Buffer.byteLength(serializeKernel(input.request)));
    return {
      mount: options.mount,
      principal: input.admission.actor.principal,
      request: {
        kind: 'commit',
        value: {
          ...input.request,
          opId: { ...input.request.opId, epoch: options.writer.intake.epoch },
        },
      },
    };
  }
  async function execute(saved: FederationForward): Promise<Outcome> {
    check(saved);
    if (saved.request.kind !== 'commit')
      throw new KernelError('INVALID', 'Retained shard request is not a commit');
    const current = await connection();
    if (saved.principal !== input.admission.actor.principal)
      throw new KernelError('UNAUTHENTICATED', 'Shard actor differs from its retained request');
    const pending = current.connection.commit(saved.request.value, input.signal);
    options.own(current, pending);
    const result = await input.wait(pending.outcome);
    await input.wait(current.check());
    check(saved);
    input.cost.charge(0, Buffer.byteLength(serializeKernel(result)));
    return result;
  }
  check();
  await judgeGates(
    options.gates,
    { kind: 'commit', changes: input.request.changes, origin: input.admission.origin },
    input.admission.actor,
    { signal: input.signal, deadline: input.cost.budget().deadline },
  );
  return options.writer.forward({
    identity: input.identity,
    cost: input.cost,
    check,
    prepare,
    execute,
    wait: input.wait,
  });
}

/** Uses the receiver's genuine action definition and accepted stream pieces without a projected mirror. */
export async function runShardAction(
  options: ShardMutationOptions & { readonly input: ForeignActionInput },
): Promise<Outcome> {
  const { input } = options;
  let handle: ShardClient | undefined;
  let component = input.request.component,
    judged = false;
  async function judge(selected = component): Promise<void> {
    if (judged) return;
    await judgeGates(
      options.gates,
      {
        kind: 'act',
        path: input.request.path,
        component: selected ?? '',
        action: input.request.action,
        args: input.request.args,
        origin: input.admission.origin,
      },
      input.admission.actor,
      { signal: input.signal, deadline: input.cost.budget().deadline },
    );
    judged = true;
  }
  function check(saved?: FederationForward): void {
    input.signal.throwIfAborted();
    input.cost.budget();
    options.active();
    handle?.active();
    if (saved !== undefined && !isDeepStrictEqual(saved.mount, options.mount))
      throw new KernelError('CONFLICT', 'Shard declaration differs from its retained request');
  }
  async function connection(): Promise<ShardClient> {
    check();
    const current = await input.wait(options.open());
    await input.wait(current.check());
    handle = current;
    check();
    return current;
  }
  async function describe() {
    const current = await connection();
    if (input.targetType !== undefined) {
      const receipt = await input.wait(
        current.connection.readOwned(
          { node: input.request.path },
          input.cost.budget(),
          input.signal,
        ),
      );
      input.cost.charge(receipt.cost.nodes, receipt.cost.bytes, receipt.cost.exprWork);
      input.cost.request(receipt.cost.requestBytes);
      if ('error' in receipt) throw receipt.error;
      const response = receipt.result;
      const copy = response.copies[0];
      if (copy === undefined) throw new KernelError('NOT_FOUND', 'Action target is absent');
      if ('error' in copy) throw copy.error;
      const selected = getComponentField(copy.node, input.targetType, input.request.component);
      if (selected === undefined)
        throw new KernelError('NOT_FOUND', 'Action target type is absent');
      component = selected[1];
    }

    const receipt = await input.wait(
      current.connection.readOwned(
        { node: input.request.path, action: { name: input.request.action, component } },
        input.cost.budget(),
        input.signal,
      ),
    );
    input.cost.charge(receipt.cost.nodes, receipt.cost.bytes, receipt.cost.exprWork);
    input.cost.request(receipt.cost.requestBytes);
    if ('error' in receipt) throw receipt.error;
    const result = receipt.result;
    input.cost.charge(0, Buffer.byteLength(serializeKernel(result)));
    await input.wait(current.check());
    check();
    const pre = result.action;
    if (pre === undefined) throw new KernelError('INVALID', 'Shard action description is absent');
    if (input.request.pre !== undefined && !isDeepStrictEqual(input.request.pre, pre))
      throw new KernelError('CONFLICT', 'Shard action differs from its admitted description');
    if (input.onlyRead && pre.kind !== 'read')
      throw new KernelError('FORBIDDEN', 'This action may call only read actions');
    return pre;
  }
  async function execute(request: ActRequest, saved?: FederationForward): Promise<Outcome> {
    check(saved);
    const current = await connection();
    if (saved !== undefined && saved.principal !== input.admission.actor.principal)
      throw new KernelError('UNAUTHENTICATED', 'Shard actor differs from its retained request');
    const pending = current.connection.act(request, input.signal);
    const owned = options.own(current, pending);
    const pieces = (async () => {
      for await (const data of pending.chunks) {
        check(saved);
        if (input.deliver === undefined)
          throw new KernelError('INVALID', 'Streaming action requires an owning delivery channel');
        await input.wait(current.check());
        check(saved);
        input.cost.charge(0, Buffer.byteLength(serializeKernel({ data })));
        const pos = owned.position();
        await input.deliver({ data, ...(pos === undefined ? {} : { pos }) }, input.signal);
      }
    })();
    try {
      const [outcome] = await input.wait(Promise.all([pending.outcome, pieces]));
      await input.wait(current.check());
      check(saved);
      input.cost.charge(0, Buffer.byteLength(serializeKernel(outcome)));
      return outcome;
    } catch (error) {
      current.connection.cancel(pending.id);
      void pieces.catch((error) => console.error(error));
      throw error;
    }
  }
  async function prepare(): Promise<FederationForward> {
    const pre = await describe();
    await judge();
    const current = handle;
    if (current === undefined || input.identity === undefined)
      throw new KernelError('INVALID', 'Shard mutation identity is absent');
    const anchor =
      input.request.anchor === undefined
        ? undefined
        : await options.writer.forwardAnchor(
            input.admission.actor.principal,
            input.request.anchor,
            input.cost,
            input.wait,
          );
    if (
      anchor !== undefined &&
      (anchor.request.kind !== 'act' ||
        anchor.request.value.path !== input.request.path ||
        anchor.request.value.action !== input.request.action ||
        anchor.request.value.component !== input.request.component)
    )
      throw new KernelError('INVALID', 'Forwarding anchor names another action');
    if (options.writer.intake.shards?.[current.connection.instance] !== current.connection.intake)
      await input.wait(
        options.writer.publishShardIntake(current.connection.instance, current.connection.intake),
      );
    await input.wait(current.check());
    check(anchor);
    return {
      mount: options.mount,
      principal: input.admission.actor.principal,
      request: {
        kind: 'act',
        value: {
          ...input.request,
          component,
          pre,
          opId: { ...input.identity.opId, epoch: options.writer.intake.epoch },
          ...(anchor === undefined || anchor.request.kind !== 'act'
            ? {}
            : { anchor: anchor.request.value.opId }),
        },
      },
    };
  }
  check();
  if (input.targetType === undefined) await judge();
  if (input.identity === undefined) {
    const pre = await describe();
    await judge();
    if (pre.kind !== 'read') throw new KernelError('INVALID', 'A mutation key is required');
    return execute({ ...input.request, component, pre });
  }
  return options.writer.forward({
    identity: input.identity,
    cost: input.cost,
    check,
    prepare,
    execute(saved) {
      if (saved.request.kind !== 'act')
        throw new KernelError('INVALID', 'Retained shard request is not an action');
      return execute(saved.request.value, saved);
    },
    wait: input.wait,
  });
}
