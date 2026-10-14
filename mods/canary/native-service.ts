import { randomUUID } from 'node:crypto';
import { KernelError } from '@treenx/core/errors';
import type { ModuleManifest, OpId, ServiceHandler, Session } from '@treenx/core/kernel/types';

/** Exercise native mutations and exact action dispatch within the running node's grants. */
export async function runNativeCanary(
  session: Session,
  path: string,
  key: () => OpId,
): Promise<void> {
  const itemPath = `${path}/test-item`;
  await session.commit({
    opId: key(),
    changes: [
      { op: 'put', node: { $path: itemPath, $type: 'canary.item', value: 0, label: 'canary' } },
    ],
  }).outcome;
  await session.act({ path: itemPath, action: 'increment', args: {}, opId: key() }).outcome;
  await session.act({ path: itemPath, action: 'setLabel', args: { label: 'updated' }, opId: key() })
    .outcome;
  const result = await session.read({ node: itemPath });
  const copy = result.copies[0];
  if ('error' in copy) throw copy.error;
  if (copy.node.value !== 1 || copy.node.label !== 'updated')
    throw new KernelError('INVALID', 'Native canary action result differs');
  const children = await session.read({ children: path });
  if (!children.list.includes(copy.node.$id))
    throw new KernelError('INVALID', 'Native canary item is missing from children');
  await session.commit({ opId: key(), changes: [{ op: 'remove', path: itemPath }] }).outcome;
}

/** Register a native startup service whose requests remain bound to its own node principal. */
export function nativeCanaryManifest(
  report: () => void = () => console.info('[canary] native checks passed'),
): ModuleManifest {
  const service: ServiceHandler = async (node, session) => {
    const lane = session.lane[Symbol.asyncIterator]();
    const welcome = await lane.next();
    if (welcome.done || welcome.value.t !== 'welcome')
      throw new KernelError('UNAVAILABLE', 'Canary session has no welcome');
    let intake = welcome.value.intake;
    const done = (async () => {
      try {
        for (;;) {
          const frame = await lane.next();
          if (frame.done) return;
          if (frame.value.t === 'fail') throw frame.value.error;
          if (
            frame.value.t === 'pos' &&
            frame.value.coverage !== true &&
            frame.value.intake !== undefined
          )
            intake = frame.value.intake;
        }
      } catch (error) {
        if (
          !(error instanceof KernelError) ||
          (error.code !== 'CANCELLED' && error.code !== 'UNAUTHENTICATED')
        )
          throw error;
      }
    })();
    const key = (): OpId => ({ epoch: intake, time: Date.now(), nonce: randomUUID() });
    await runNativeCanary(session, node.$path, key);
    report();
    return {
      done,
      async stop() {
        await done;
      },
    };
  };
  return {
    id: 'treenix.canary',
    open: [],
    security: [{ type: 'canary.runner', context: 'service', handler: service }],
    types: [
      {
        name: 'canary.runner',
        module: 'treenix.canary',
        security: 'user-capability',
        version: 1,
        actionsOnly: true,
        schema: { type: 'object', additionalProperties: false },
        actions: {},
      },
      {
        name: 'canary.item',
        module: 'treenix.canary',
        security: 'ordinary',
        version: 1,
        schema: {
          type: 'object',
          required: ['value', 'label'],
          additionalProperties: false,
          properties: { value: { type: 'number' }, label: { type: 'string' } },
        },
        actions: {
          increment: {
            kind: 'write',
            args: { type: 'object', additionalProperties: false },
            async handler(context) {
              context.change.patch(context.node.$path, { $inc: { value: 1 } });
            },
          },
          setLabel: {
            kind: 'write',
            args: {
              type: 'object',
              required: ['label'],
              additionalProperties: false,
              properties: { label: { type: 'string' } },
            },
            async handler(context, args) {
              if (
                typeof args !== 'object' ||
                args === null ||
                !('label' in args) ||
                typeof args.label !== 'string'
              )
                throw new KernelError('INVALID', 'Canary label is required');
              context.change.patch(context.node.$path, { $set: { label: args.label } });
            },
          },
        },
      },
    ],
  };
}
