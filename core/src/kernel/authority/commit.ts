import { isDeepStrictEqual } from 'node:util';
import { KernelError } from '#errors';
import type { ForeignCommitInput } from '#kernel/commands';
import type { createAuthorityNamespace } from '#kernel/authority/namespace';
import type { FederationClient } from '#kernel/authority/owner';
import { judgeGates } from '#kernel/gates';
import { positionToRev, revToPosition } from '#kernel/position';
import { serializeKernel } from '#kernel/serialization';
import { type ChangeMember, type FederationForward, type Gate, type Outcome } from '#kernel/types';
import type { Writer } from '#kernel/writer';

interface FederationCommitOptions {
  readonly input: ForeignCommitInput;
  readonly namespace: ReturnType<typeof createAuthorityNamespace>;
  readonly mount: FederationForward['mount'];
  readonly writer: Writer;
  readonly gates: readonly Gate[];
  readonly authorize: () => void;
  readonly open: () => Promise<FederationClient>;
}

/** Remote mutations retain one normalized request and key under the origin's canonical decision owner. */
export async function runFederationCommit(options: FederationCommitOptions): Promise<Outcome> {
  const { input, namespace } = options;
  function check(saved?: FederationForward): void {
    input.signal.throwIfAborted();
    input.cost.budget();
    if (saved !== undefined && !isDeepStrictEqual(saved.mount, options.mount))
      throw new KernelError('CONFLICT', 'Federation mount differs from its retained request');
    options.authorize();
  }
  async function connection(): Promise<FederationClient> {
    check();
    const current = await input.wait(options.open());
    await input.wait(current.check());
    check();
    return current;
  }
  function payload(value: Readonly<Record<string, unknown>>) {
    return namespace.foreignPayload(value, input.cost.budget(), (work) =>
      input.cost.charge(0, 0, work),
    );
  }
  function sets(value: Readonly<Record<string, unknown>>) {
    const mapped = payload(value);
    for (const field in value)
      if (Object.hasOwn(value, field)) {
        input.cost.charge(0, 0, 1);
        if (field === '$ref' || field.endsWith('.$ref'))
          mapped[field] = payload({ $ref: value[field] }).$ref;
      }
    return mapped;
  }
  function change(value: ChangeMember): ChangeMember {
    input.cost.charge(0, 0, 1);
    switch (value.op) {
      case 'put':
        return {
          ...value,
          node: {
            ...payload(value.node),
            $type: value.node.$type,
            $path: namespace.foreignPath(value.node.$path),
          },
        };
      case 'patch':
        return {
          ...value,
          path: namespace.foreignPath(value.path),
          ops: {
            ...value.ops,
            ...(value.ops.$set === undefined ? {} : { $set: sets(value.ops.$set) }),
            ...(value.ops.$push === undefined ? {} : { $push: payload(value.ops.$push) }),
          },
        };
      case 'remove':
        return { ...value, path: namespace.foreignPath(value.path) };
      case 'adopt':
      case 'move':
        return {
          ...value,
          from: namespace.foreignPath(value.from),
          to: namespace.foreignPath(value.to),
        };
      case 'restore':
      case 'undo':
        return {
          ...value,
          record: {
            id: namespace.foreignId(value.record.id),
            pos: namespace.foreignPosition(value.record.pos),
          },
        };
    }
  }
  async function prepare(): Promise<FederationForward> {
    const current = await connection();
    const welcome = await input.wait(current.client.ready);
    const request = input.request,
      expect = request.expect;
    if (request.changes.length > input.cost.budget().exprWork)
      throw new KernelError('BUDGET', 'Foreign commit exceeds the mapping allowance');
    const fields =
      request.changes.length +
      (expect?.nodes?.length ?? 0) +
      (expect?.absent?.length ?? 0) +
      (expect?.selectors?.length ?? 0);
    input.cost.charge(0, 0, fields + Math.ceil(serializeKernel(request).length / 8));
    if (expect?.selectors !== undefined)
      for (const expected of expect.selectors) input.cost.charge(0, 0, expected.at.length);
    const key = current.client.key();
    return {
      mount: options.mount,
      principal: welcome.principal,
      request: {
        kind: 'commit',
        value: {
          changes: request.changes.map(change),
          opId: {
            ...key,
            nonce: namespace.nonce(input.identity.actor.principal, input.identity.opId),
          },
          ...(expect === undefined
            ? {}
            : {
                expect: {
                  ...(expect.nodes === undefined
                    ? {}
                    : {
                        nodes: expect.nodes.map((node) => ({
                          path: namespace.foreignPath(node.path),
                          rev: positionToRev(namespace.foreignPosition(revToPosition(node.rev))),
                        })),
                      }),
                  ...(expect.absent === undefined
                    ? {}
                    : { absent: expect.absent.map(namespace.foreignPath) }),
                  ...(expect.selectors === undefined
                    ? {}
                    : {
                        selectors: expect.selectors.map((value) => ({
                          selector: namespace.selector(value.selector),
                          at: value.at.map(namespace.foreignPosition),
                        })),
                      }),
                },
              }),
        },
      },
    };
  }
  async function execute(saved: FederationForward): Promise<Outcome> {
    check(saved);
    if (saved.request.kind !== 'commit')
      throw new KernelError('INVALID', 'Retained request is not a commit');
    const current = await connection();
    const welcome = await input.wait(current.client.ready);
    if (welcome.principal !== saved.principal)
      throw new KernelError(
        'UNAUTHENTICATED',
        'Foreign executor differs from its retained request',
      );
    check(saved);
    const pending = current.client.commit(saved.request.value, input.signal);
    const outcome = await input.wait(pending.outcome);
    await input.wait(current.check());
    check(saved);
    const mapped = namespace.outcome(outcome, input.cost.budget(), (work) =>
      input.cost.charge(0, 0, work),
    );
    input.cost.charge(0, Buffer.byteLength(serializeKernel(mapped)));
    return mapped;
  }
  check();
  await judgeGates(
    options.gates,
    { kind: 'commit', changes: input.request.changes, origin: input.admission.origin },
    input.admission.actor,
    { signal: input.signal, deadline: input.cost.budget().deadline },
  );
  check();
  return options.writer.forward({
    identity: input.identity,
    cost: input.cost,
    check,
    prepare,
    execute,
    wait: input.wait,
  });
}
