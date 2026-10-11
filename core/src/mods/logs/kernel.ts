import { randomUUID } from 'node:crypto';
import { KernelError } from '#errors';
import type { LogEntry } from '#log';
import type { NativeModuleDeployment, NativeModuleHost } from '#kernel/manifest';
import { A, R, W, type ServiceHandler } from '#kernel/types';
import type { LogsInput } from './input';

declare module '#kernel/manifest' {
  interface NativeModuleHost { readonly logs?: LogsInput; }
}

/** Only the admitted service Session writes persistent entries; every batch receives ordinary Writer limits. */
function writer(input: LogsInput): ServiceHandler {
  return async (node, session) => {
    const path = node.$path;
    const lane = session.lane[Symbol.asyncIterator]();
    const welcome = await lane.next();
    if (welcome.done || welcome.value.t !== 'welcome') throw new KernelError('UNAVAILABLE', 'Log writer lane did not open');
    let intake = welcome.value.intake, stopped = false, bytes = 0;
    let wake = () => {};
    let failure: KernelError | undefined;
    let admitted = () => {};
    const ready = new Promise<void>(resolve => { admitted = resolve; });
    const sub = session.sub({ node: path });
    const pending: { entry: LogEntry; bytes: number }[] = [];
    const unsubscribe = input.subscribe(entry => {
      const size = Buffer.byteLength(JSON.stringify(entry));
      if (pending.length === 1000 || bytes + size > 8 * 1024 * 1024) {
        failure = new KernelError('BUDGET', 'Persistent log writer queue is full');
        wake();
        throw failure;
      }
      pending.push({ entry: { ...entry }, bytes: size });
      bytes += size;
      wake();
    });
    const delivery = (async () => {
      try {
        for (;;) {
          const next = await lane.next();
          if (next.done) { stopped = true; admitted(); wake(); return; }
          if (next.value.t === 'end') throw next.value.error;
          if (next.value.t === 'snap' && next.value.sub === sub) admitted();
          if (next.value.t === 'pos' && next.value.coverage !== true && next.value.intake !== undefined)
            intake = next.value.intake;
        }
      } finally { stopped = true; admitted(); wake(); }
    })();
    const work = (async () => {
      try {
        await ready;
        while (!stopped) {
          if (failure !== undefined) throw failure;
          if (pending.length === 0) {
            await new Promise<void>(resolve => { wake = resolve; });
            continue;
          }
          const batch = pending.slice(0, 64);
          await session.commit({
            opId: { epoch: intake, time: Date.now(), nonce: randomUUID() },
            changes: batch.map(({ entry }) => ({ op: 'put', node: {
              $path: `${path}/${entry.t}-${randomUUID()}`, $type: 't.log', ...entry,
            } })),
          }).outcome;
          for (const item of batch) bytes -= item.bytes;
          pending.splice(0, batch.length);
        }
      } finally { unsubscribe(); }
    })();
    const done = Promise.all([delivery, work]).then(() => {});
    return { done, async stop() { stopped = true; session.unsub(sub); unsubscribe(); admitted(); wake(); await done; } };
  };
}

/** Native queries read the admitted persistent Store instead of the process-wide legacy ring buffer. */
export default function logsModule(host: NativeModuleHost): NativeModuleDeployment {
  if (host.logs === undefined) throw new KernelError('UNAVAILABLE', 'Native logs require their deployment-owned input');
  return { manifest: {
    id: '@treenx/core/logs',
    types: [{ name: 't.log', module: '@treenx/core/logs', security: 'ordinary', version: 0, actions: {},
      schema: { type: 'object', required: ['t', 'level', 'msg'], properties: {
        t: { type: 'number' }, level: { enum: ['debug', 'info', 'warn', 'error'] }, msg: { type: 'string' },
        code: { type: 'string' }, sub: { type: 'string' }, userId: { type: 'string' }, method: { type: 'string' }, path: { type: 'string' },
      } } },
    { name: 't.logs', module: '@treenx/core/logs', security: 'user-capability', version: 0, schema: { type: 'object', properties: {} },
      actions: { query: { kind: 'read', args: {}, handler: async ctx => {
        if ((ctx.executor.claims ?? []).includes('admins') === false)
          throw new KernelError('FORBIDDEN', 'Persistent logs require administrator admission');
        const result = await ctx.read.read({ children: ctx.node.$path, sort: [['t', 1]] });
        if (result.next !== undefined) throw new KernelError('BUDGET', 'Persistent logs exceed the requested read window');
        return result;
      } } } }
    ],
    security: [{ type: 't.logs', context: 'acl', handler: input => input.admin ? R | W | A : input.principalGrant },
      { type: 't.logs', context: 'service', handler: writer(host.logs) }],
    open: [],
  } };
}
