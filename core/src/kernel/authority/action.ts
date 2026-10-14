import { getComponentField } from '#core/component';
import { isDeepStrictEqual } from 'node:util';
import { KernelError } from '#errors';
import type { FederationClient } from '#kernel/authority/owner';
import type { createAuthorityNamespace } from '#kernel/authority/namespace';
import type { ForeignActionInput } from '#kernel/commands';
import { judgeGates } from '#kernel/gates';
import { revToPosition } from '#kernel/position';
import { serializeKernel } from '#kernel/serialization';
import {
  R,
  W,
  type ActionDescriptor,
  type FederationForward,
  type Gate,
  type Outcome,
} from '#kernel/types';
import type { Writer } from '#kernel/writer';

interface FederationActionOptions {
  readonly input: ForeignActionInput;
  readonly writer: Writer;
  readonly namespace: ReturnType<typeof createAuthorityNamespace>;
  readonly mount: FederationForward['mount'];
  readonly gates: readonly Gate[];
  readonly open: () => Promise<FederationClient>;
  readonly authorize: (required: number) => void;
}

/** The origin retains the first remote definition, key and executor before sending a mutation. */
export async function runFederationAction(options: FederationActionOptions): Promise<Outcome> {
  const { input, namespace } = options;
  let handle: FederationClient | undefined;
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
  function check(forward?: FederationForward): void {
    input.signal.throwIfAborted();
    input.cost.budget();
    const kind = forward?.request.kind === 'act' ? forward.request.value.pre.kind : undefined;
    if (input.onlyRead && kind !== undefined && kind !== 'read')
      throw new KernelError('FORBIDDEN', 'This action may call only read actions');
    if (forward !== undefined && !isDeepStrictEqual(forward.mount, options.mount))
      throw new KernelError('CONFLICT', 'Federation mount differs from its retained request');
    options.authorize(kind === 'write' || forward?.request.kind === 'commit' ? R | W : R);
  }
  async function connection(): Promise<FederationClient> {
    check();
    const current = await input.wait(options.open());
    await input.wait(current.check());
    check();
    handle = current;
    return current;
  }
  async function describe(): Promise<ActionDescriptor> {
    const current = await connection();
    if (input.targetType !== undefined) {
      const response = await input.wait(
        current.client.read(namespace.selector({ node: input.request.path }), input.signal),
      );
      input.cost.charge(response.copies.length, Buffer.byteLength(serializeKernel(response)));
      const copy = response.copies[0];
      if (copy === undefined) throw new KernelError('NOT_FOUND', 'Action target is absent');
      if ('error' in copy) throw copy.error;
      const selected = getComponentField(copy.node, input.targetType, input.request.component);
      if (selected === undefined)
        throw new KernelError('NOT_FOUND', 'Action target type is absent');
      component = selected[1];
    }

    const response = await input.wait(
      current.client.read(
        namespace.selector({
          node: input.request.path,
          action: { name: input.request.action, component },
        }),
        input.signal,
      ),
    );
    input.cost.charge(response.copies.length, Buffer.byteLength(serializeKernel(response)));
    await input.wait(current.check());
    check();
    if (response.action === undefined)
      throw new KernelError('INVALID', 'Foreign action description is absent');
    const expected =
      input.request.pre === undefined
        ? response.action
        : namespace.foreignAction(input.request.pre);
    if (!isDeepStrictEqual(expected, response.action))
      throw new KernelError('CONFLICT', 'Foreign action differs from its admitted description');
    return expected;
  }
  async function prepare(): Promise<FederationForward> {
    const anchor =
      input.request.anchor === undefined
        ? undefined
        : await options.writer.forwardAnchor(
            input.admission.actor.principal,
            input.request.anchor,
            input.cost,
            input.wait,
          );
    if (anchor !== undefined) {
      check(anchor);
      if (
        anchor.request.kind !== 'act' ||
        anchor.request.value.path !== namespace.foreignPath(input.request.path) ||
        anchor.request.value.action !== input.request.action ||
        anchor.request.value.component !== input.request.component
      )
        throw new KernelError('INVALID', 'Forwarding anchor names another action');
    }
    const pre = await describe();
    await judge();
    const current = handle;
    if (current === undefined)
      throw new KernelError('INVALID', 'Foreign action connection is absent');
    const welcome = await input.wait(current.client.ready);
    const key = current.client.key();
    const identity = input.identity;
    const opId =
      identity === undefined
        ? key
        : { ...key, nonce: namespace.nonce(identity.actor.principal, identity.opId) };
    return {
      mount: options.mount,
      principal: welcome.principal,
      request: {
        kind: 'act',
        value: {
          ...input.request,
          component,
          args: namespace.foreignPayload(
            { args: input.request.args },
            input.cost.budget(),
            (work) => input.cost.charge(0, 0, work),
          ).args,
          path: namespace.foreignPath(input.request.path),
          opId,
          pre,
          ...(anchor === undefined ? {} : { anchor: anchor.request.value.opId }),
        },
      },
    };
  }
  async function execute(forward: FederationForward): Promise<Outcome> {
    check(forward);
    if (forward.request.kind !== 'act')
      throw new KernelError('INVALID', 'Retained request is not an action');
    const current = await connection();
    const welcome = await input.wait(current.client.ready);
    if (welcome.principal !== forward.principal)
      throw new KernelError(
        'UNAUTHENTICATED',
        'Foreign executor differs from its retained request',
      );
    check(forward);
    const pending = current.client.act(forward.request.value, input.signal);
    const space = revToPosition(forward.request.value.pre.rev).instance;
    const pieces = (async () => {
      for await (const data of pending.chunks) {
        check(forward);
        if (input.deliver === undefined)
          throw new KernelError('INVALID', 'Streaming action requires an owning delivery channel');
        await input.wait(current.check());
        check(forward);
        const pos = current.client.cache.watermark(space);
        const value = namespace.outcome({ value: data }, input.cost.budget(), (work) =>
          input.cost.charge(0, 0, work),
        );
        input.cost.charge(0, Buffer.byteLength(serializeKernel(value)));
        await input.deliver(
          { data: value.value, ...(pos === undefined ? {} : { pos: namespace.position(pos) }) },
          input.signal,
        );
      }
    })();
    try {
      const [outcome] = await input.wait(Promise.all([pending.outcome, pieces]));
      await input.wait(current.check());
      check(forward);
      const mapped = namespace.outcome(outcome, input.cost.budget(), (work) =>
        input.cost.charge(0, 0, work),
      );
      input.cost.charge(0, Buffer.byteLength(serializeKernel(mapped)));
      return mapped;
    } catch (error) {
      if (current.client.failure() === undefined) current.client.cancel(pending.id);
      void pieces.catch((error) => console.error(error));
      throw error;
    }
  }
  check();
  if (input.targetType === undefined) await judge();
  check();
  if (input.identity === undefined) {
    const request = await prepare();
    if (request.request.kind !== 'act' || request.request.value.pre.kind !== 'read')
      throw new KernelError('INVALID', 'A mutation key is required');
    return execute(request);
  }
  return options.writer.forward({
    identity: input.identity,
    cost: input.cost,
    check,
    prepare,
    execute,
    wait: input.wait,
  });
}
