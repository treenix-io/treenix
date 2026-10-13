import {
  compKey,
  getComponent,
  getComponentByName,
  getDefaults,
  getMeta,
  resolve,
} from '@treenx/core';
import { predictionCtx } from '@treenx/core/comp';
import { createDeclaredClientRegistry, type ClientRegistry } from '#context/client-registry';
import type { TwpClient } from '@treenx/core/client/twp';
import { KernelError } from '@treenx/core/errors';
import type { Node, OpId, Pending, UpdateOps } from '@treenx/core/kernel/types';
import { applyUpdateOps } from '@treenx/core/kernel/update-ops';
import { parseURI } from '@treenx/core/uri';
import type { ActionChunks, ActionResults } from '#hooks';
import type { ClientAction, TreeEffects } from '#tree/effects';
import { mergeToOps, type OnChange } from '#tree/on-change';
import { createPredictionGroups } from '#tree/prediction-group';

/** Bind public mutation and presentation effects to one actual admitted canonical client. */
export function createLaneEffects(client: TwpClient, registry: ClientRegistry = createDeclaredClientRegistry()) {
  let closed = false;
  const groups = createPredictionGroups<Node>(
    (error) => {
      if (error instanceof Error && 'code' in error && error.code === 'CTX_UNAVAILABLE') {
        console.info('[treenix] prediction needs server context');
      } else console.warn('[treenix] prediction failed', error);
    },
    () => console.info('[treenix] asynchronous prediction remains server-owned'),
  );

  /** Retained callbacks cannot act through a source which has released its principal ownership. */
  function available(): void {
    if (closed) throw new KernelError('CANCELLED', 'Lane effects are closed');
  }

  /** Resolve a pure registered prediction from the actual canonical component without metadata conversion. */
  function prediction(
    path: string,
    action: string,
    data: unknown,
    key: string | undefined,
    opId: OpId,
  ) {
    const copy = client.cache.at(path);
    if (copy === undefined || 'error' in copy) return undefined;
    const type = key === undefined ? copy.node.$type : getComponentByName(copy.node, key)?.$type;
    if (type === undefined) return undefined;
    const declaration = registry.type(type);
    // Unmigrated producers retain their existing behavior until they declare an owner.
    if (declaration === undefined) {
      const metadata = getMeta(type, `action:${action}`);
      if (metadata?.noOptimistic || metadata?.needs || metadata?.stream) return undefined;
      const cls = resolve(type, 'class');
      const handler = resolve(type, `action:${action}`, false);
      if (cls === null || handler === null) return undefined;
      return groups.push(copy.node, JSON.stringify(opId), candidate => {
        const component = getComponent(candidate, cls, key);
        if (component === undefined) throw new KernelError('INVALID', 'Prediction lost its owning component');
        return handler(predictionCtx(candidate, component), data);
      });
    }
    const predict = declaration.predictions[action];
    if (predict === undefined) return undefined;

    return groups.push(copy.node, JSON.stringify(opId), (candidate) => {
      const component = getComponent(candidate, type, key);
      if (component === undefined)
        throw new KernelError('INVALID', 'Prediction lost its owning component');
      return predict(candidate, component, data);
    });
  }

  function execute<T extends keyof ActionResults, A extends keyof ActionResults[T] & string>(
    pathOrUri: string,
    action: A,
    data: unknown,
    type: T,
    key?: string,
  ): Promise<ActionResults[T][A]>;
  function execute(
    pathOrUri: string,
    action: string,
    data?: unknown,
    type?: string,
    key?: string,
  ): Promise<unknown>;
  async function execute(
    pathOrUri: string,
    action: string,
    data?: unknown,
    _type?: string,
    key?: string,
  ): Promise<unknown> {
    available();
    await client.ready;
    available();
    const parsed = parseURI(pathOrUri);
    const component = key ?? parsed.key;
    // Zero-argument UI methods still need an explicit JSON payload on the native wire.
    const opId = client.key(),
      args = data === undefined ? {} : structuredClone(data);
    const predicted = prediction(parsed.path, action, args, component, opId);
    try {
      const outcome = await client.act({
        path: parsed.path,
        action,
        args,
        ...(component === undefined ? {} : { component: compKey(component) }),
        opId,
      }).outcome;
      predicted?.settle(true);
      available();
      return outcome.value;
    } catch (error) {
      predicted?.settle(false);
      throw error;
    }
  }

  /** Use the existing partial-key validation and canonical update operators as one atomic commit. */
  async function patchNode(path: string, partial: OnChange): Promise<void> {
    available();
    const changes = mergeToOps(partial);
    if (changes.length === 0) return;
    const set: Record<string, unknown> = {},
      unset: Record<string, true> = {};
    for (const change of changes) {
      if (change[0] === 'r') set[change[1]] = change[2];
      else unset[change[1]] = true;
    }
    const ops: UpdateOps = structuredClone({
      ...(Object.keys(set).length === 0 ? {} : { $set: set }),
      ...(Object.keys(unset).length === 0 ? {} : { $unset: unset }),
    });
    await client.ready;
    available();
    const opId = client.key(),
      copy = client.cache.at(path);
    const predicted =
      copy === undefined || 'error' in copy
        ? undefined
        : groups.push(copy.node, JSON.stringify(opId), (candidate) => {
            const next = applyUpdateOps(candidate, ops);
            for (const field of Object.keys(candidate))
              if (!Object.hasOwn(next, field)) Reflect.deleteProperty(candidate, field);
            Object.assign(candidate, next);
          });
    try {
      await client.commit({ changes: [{ op: 'patch', path, ops }], opId }).outcome;
      predicted?.settle(true);
      available();
    } catch (error) {
      predicted?.settle(false);
      throw error;
    }
  }

  /** Keep cancellation attached to the actual Pending owner even while next() is waiting for a piece. */
  function stream<T extends keyof ActionChunks, A extends keyof ActionChunks[T] & string>(
    action: ClientAction & { type: T; action: A },
  ): AsyncIterableIterator<ActionChunks[T][A]>;
  function stream(action: ClientAction): AsyncIterableIterator<unknown>;
  function stream(action: ClientAction): AsyncIterableIterator<unknown> {
    let pending: Pending | undefined,
      finished = false,
      cancelled = false,
      cancellationSent = false;
    function cancelPending(): void {
      if (pending === undefined || finished || cancellationSent || client.failure() !== undefined)
        return;
      cancellationSent = true;
      client.cancel(pending.id);
    }
    const pieces = (async function* () {
      available();
      await client.ready;
      available();
      if (cancelled) return;
      const parsed = parseURI(action.path),
        component = action.component ?? parsed.key;
      pending = client.act({
        path: parsed.path,
        action: action.action,
        args: action.args === undefined ? {} : action.args,
        ...(component === undefined ? {} : { component: compKey(component) }),
      });
      void pending.outcome.then(
        () => {
          finished = true;
        },
        () => {
          finished = true;
        },
      );
      try {
        for await (const chunk of pending.chunks) {
          available();
          yield chunk;
        }
        await pending.outcome;
      } catch (error) {
        if (!(cancelled && error instanceof KernelError && error.code === 'CANCELLED')) throw error;
      } finally {
        cancelPending();
      }
    })();
    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: () => pieces.next(),
      async return() {
        cancelled = true;
        cancelPending();
        return pieces.return(undefined);
      },
      async throw(error) {
        cancelled = true;
        cancelPending();
        return pieces.throw(error);
      },
    };
  }

  async function createNode(
    path: string,
    type: string,
    data?: Record<string, unknown>,
  ): Promise<void> {
    available();
    await client.ready;
    available();
    await client.commit({
      changes: [{ op: 'put', node: { $path: path, $type: type,
        ...(registry.type(type)?.defaults() ?? getDefaults(type)), ...data } }],
    }).outcome;
    available();
  }

  async function removeNode(path: string): Promise<void> {
    available();
    await client.ready;
    available();
    await client.commit({ changes: [{ op: 'remove', path }] }).outcome;
    available();
  }

  const effects: TreeEffects = {
    lane: true,
    execute,
    patchNode,
    createNode,
    removeNode,
    stream,
    presentation: groups,
    kernel: {
      async commit(request) {
        available();
        await client.ready;
        available();
        const outcome = await client.commit(request).outcome;
        available();
        return outcome;
      },
      async read(selector) {
        available();
        await client.ready;
        available();
        const result = await client.read(selector);
        available();
        return result;
      },
    },
    bits(path) {
      const copy = closed ? undefined : client.cache.at(path);
      return copy === undefined || 'error' in copy ? undefined : copy.bits;
    },
  };

  return {
    effects,
    presentation: groups,
    /** Drop captured presentation while leaving the canonical client's connection with its caller. */
    close() {
      if (closed) return;
      closed = true;
      groups.clear();
    },
  };
}
