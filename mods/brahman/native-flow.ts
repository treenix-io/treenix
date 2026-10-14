import { KernelError } from '@treenx/core/errors';
import type { BrahmanFlow } from '#brahman/native-ports';

/** Decode the dynamic action-result boundary; malformed directives fail as a whole. */
export function decodeFlow(value: unknown): BrahmanFlow | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null)
    throw new KernelError('INVALID', 'Action flow must be an object');
  const page = 'page' in value ? value.page : undefined;
  const action = 'action' in value ? value.action : undefined;
  const stop = 'stop' in value ? value.stop : undefined;
  const emittedText = 'emittedText' in value ? value.emittedText : undefined;
  if (
    (page !== undefined && typeof page !== 'string') ||
    (action !== undefined && typeof action !== 'string') ||
    (stop !== undefined && typeof stop !== 'boolean') ||
    (emittedText !== undefined && typeof emittedText !== 'string')
  )
    throw new KernelError('INVALID', 'Action flow directive has an invalid value');

  let broadcast: BrahmanFlow['broadcast'];
  if ('broadcast' in value && value.broadcast !== undefined) {
    if (!Array.isArray(value.broadcast))
      throw new KernelError('INVALID', 'Broadcast targets must be an array');
    broadcast = value.broadcast.map((target: unknown) => {
      if (
        typeof target !== 'object' ||
        target === null ||
        !('action' in target) ||
        typeof target.action !== 'string' ||
        !('userId' in target) ||
        typeof target.userId !== 'number' ||
        !Number.isSafeInteger(target.userId) ||
        !('chatId' in target) ||
        typeof target.chatId !== 'number' ||
        !Number.isSafeInteger(target.chatId) ||
        !('lang' in target) ||
        typeof target.lang !== 'string'
      )
        throw new KernelError('INVALID', 'Broadcast target is invalid');
      return {
        action: target.action,
        userId: target.userId,
        chatId: target.chatId,
        lang: target.lang,
      };
    });
  }
  let call: BrahmanFlow['call'];
  if ('call' in value && value.call !== undefined) {
    const target = value.call;
    if (
      typeof target !== 'object' ||
      target === null ||
      !('path' in target) ||
      typeof target.path !== 'string' ||
      !('action' in target) ||
      typeof target.action !== 'string' ||
      !('args' in target)
    )
      throw new KernelError('INVALID', 'Called action is invalid');
    const component = 'component' in target ? target.component : undefined;
    const saveTo = 'saveTo' in target ? target.saveTo : undefined;
    if (
      (component !== undefined && typeof component !== 'string') ||
      (saveTo !== undefined && typeof saveTo !== 'string')
    )
      throw new KernelError('INVALID', 'Called action target is invalid');
    call = { path: target.path, action: target.action, args: target.args, component, saveTo };
  }
  return { page, action, stop, emittedText, broadcast, call };
}
