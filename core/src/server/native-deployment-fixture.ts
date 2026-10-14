import { KernelError } from '#errors';
import type { NativeModuleDeployment } from '#kernel/manifest';
import type { ServiceHandler } from '#kernel/types';

declare module '#kernel/types' {
  interface Io {
    readonly boot?: { reverse(value: string): string };
  }
}

/** Run one ordinary action through the service's actual node session and owned lane. */
const service: ServiceHandler = async (node, session) => {
  const lane = session.lane[Symbol.asyncIterator]();
  const welcome = await lane.next();
  if (welcome.done || welcome.value.t !== 'welcome') throw new Error('Service lane did not open');
  const delivery = (async () => {
    while (!(await lane.next()).done) {}
  })();
  const action = session.act({
    path: node.$path,
    action: 'reverse',
    args: 'service',
    opId: { epoch: welcome.value.intake, time: Date.now(), nonce: crypto.randomUUID() },
  });
  for await (const _chunk of action.chunks) {
  }
  await action.outcome;
  return {
    done: delivery,
    async stop() {
      await delivery;
    },
  };
};

/** Supply a compiled owning manifest and one explicit lifetime-bound IO port for boot tests. */
export default async function fixture(): Promise<NativeModuleDeployment> {
  return {
    manifest: {
      id: 'native.boot-fixture',
      open: [],
      security: [{ type: 'boot.worker', context: 'service', handler: service }],
      types: [
        {
          name: 'boot.worker',
          module: 'native.boot-fixture',
          security: 'user-capability',
          version: 0,
          schema: { type: 'object', properties: {} },
          actions: {
            reverse: {
              kind: 'write',
              io: true,
              args: { type: 'string' },
              async handler(ctx, input) {
                if (typeof input !== 'string')
                  throw new KernelError('INVALID', 'Reverse requires a string');
                if (ctx.io?.boot === undefined)
                  throw new KernelError('UNAVAILABLE', 'Boot IO is not bound');
                const label = ctx.io.boot.reverse(input);
                ctx.change.patch(`${ctx.node.$path}/state`, { $set: { label } });
                return label;
              },
            },
          },
        },
        {
          name: 'boot.state',
          module: 'native.boot-fixture',
          security: 'ordinary',
          version: 0,
          schema: {
            type: 'object',
            properties: { label: { type: 'string' } },
            required: ['label'],
          },
          actions: {},
        },
      ],
    },
    io: (scope) => ({
      boot: {
        reverse(value) {
          scope.assertActive();
          return [...value].reverse().join('');
        },
      },
    }),
  };
}
