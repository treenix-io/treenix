import { register } from '#core/registry';
import { KernelError } from '#errors';
import { registerKernelAction } from '#kernel/manifest';
import type { ActionIoBinding } from '#kernel/types';
import { isRecord } from '#util/is-record';

declare module '#kernel/types' {
  interface Io {
    readonly cliHttp?: { exchange(endpoint: string, input: string): Promise<string> };
  }
}

/** Bind a real external HTTP exchange to the action's owned lifetime. */
export const bindIo: ActionIoBinding = (scope) => ({
  cliHttp: {
    async exchange(endpoint, input) {
      scope.assertActive();
      const response = await fetch(endpoint, { method: 'POST', body: input, signal: scope.signal });
      if (!response.ok) throw new KernelError('UNAVAILABLE', 'External HTTP exchange failed');
      const output = await response.text();
      scope.assertActive();
      return output;
    },
  },
});

register('cli.io', 'schema', () => ({ $id: 'cli.io', type: 'object', properties: {} }));
registerKernelAction('cli.io', 'exchange', {
  kind: 'write',
  io: true,
  args: { endpoint: { type: 'string' }, input: { type: 'string' } },
  async handler(ctx, input) {
    if (!isRecord(input) || typeof input.endpoint !== 'string' || typeof input.input !== 'string')
      throw new KernelError('INVALID', 'Malformed HTTP exchange input');

    const provider = ctx.io?.cliHttp;
    if (provider === undefined)
      throw new KernelError('UNAVAILABLE', 'HTTP exchange is not configured');
    return provider.exchange(input.endpoint, input.input);
  },
});
