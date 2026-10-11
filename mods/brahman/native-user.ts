import { KernelError } from '@treenx/core/errors';
import type { ActionDef } from '@treenx/core/kernel/types';
import { BotConfig, BrahmanUser } from '#brahman/types';
import { component, nativeNode, type NativeSessionState } from '#brahman/native-state';

/** Persist language and blocked delivery state under the bot's ordinary native grants. */
export function userActions(): Readonly<Record<string, ActionDef>> {
  return {
    setLanguage: { kind: 'write', args: { type: 'object', required: ['lang'], additionalProperties: false,
      properties: { lang: { type: 'string' } } }, async handler(context, input) {
      if (typeof input !== 'object' || input === null || !('lang' in input) || typeof input.lang !== 'string')
        throw new KernelError('INVALID', 'User language is required');
      const user = component(context.node, BrahmanUser);
      const botPath = context.node.$path.slice(0, context.node.$path.lastIndexOf('/users/'));
      const config = component(await nativeNode(context.read, botPath), BotConfig);
      if (!config.langs.split(',').map(lang => lang.trim()).includes(input.lang))
        throw new KernelError('INVALID', 'User language is outside the bot configuration');
      const sessionPath = `${botPath}/sessions/${user.tid}`;
      const session = component<NativeSessionState>(await nativeNode(context.read, sessionPath), 'brahman.session');
      context.change.patch(context.node.$path, { $set: { lang: input.lang } });
      context.change.patch(sessionPath, { $set: { data: { ...session.data, langSelected: input.lang } } });
    } },
    setBlocked: { kind: 'write', args: { type: 'object', required: ['blocked'], additionalProperties: false,
      properties: { blocked: { type: 'boolean' } } }, async handler(context, input) {
      if (typeof input !== 'object' || input === null || !('blocked' in input) || typeof input.blocked !== 'boolean')
        throw new KernelError('INVALID', 'User delivery state is required');
      context.change.patch(context.node.$path, { $set: { blocked: input.blocked } });
    } },
  };
}
