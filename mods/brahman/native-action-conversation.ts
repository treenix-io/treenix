import { KernelError } from '@treenx/core/errors';
import type { ActionDef, Node, Reader } from '@treenx/core/kernel/types';
import type { PropertySchema } from '@treenx/core/schema/types';
import { BrahmanSession, BrahmanUser, BotConfig } from '#brahman/types';
import { brahmanRunSchema } from '#brahman/native-ports';
import { component, nativeNode, runArguments, telegram, type NativeSessionState } from '#brahman/native-state';

/** Read an optional conversation record without hiding any other refusal. */
async function optionalNode(reader: Reader, path: string): Promise<Node | undefined> {
  try {
    const copy = (await reader.read({ node: path })).copies[0];
    if ('node' in copy) return copy.node;
    throw copy.error;
  } catch (error) {
    if (error instanceof KernelError && error.code === 'NOT_FOUND') return undefined;
    throw error;
  }
}

/** A session's owning bot follows its declared conversation address. */
export function conversationBot(path: string): string {
  const separator = path.lastIndexOf('/sessions/');
  if (separator < 0) throw new KernelError('INVALID', 'Conversation session has no bot address');
  return path.slice(0, separator);
}

/** Initialize user and conversation state with the bot's own executor grants. */
export function initializeConversation(): ActionDef {
  return { kind: 'write', args: brahmanRunSchema, async handler(context, input) {
    const args = runArguments(input);
    if (args.botPath !== context.node.$path) throw new KernelError('INVALID', 'Update targets another bot');
    const config = component(context.node, BotConfig);
    for (const name of ['pages', 'users', 'sessions']) {
      const path = `${args.botPath}/${name}`;
      if (await optionalNode(context.read, path) === undefined) context.change.put({ $path: path, $type: 't.dir' });
    }
    const userPath = `${args.botPath}/users/${args.userId}`;
    const existing = await optionalNode(context.read, userPath);
    if (existing === undefined) {
      context.change.put({ $path: userPath, $type: 'brahman.user', ...new BrahmanUser(),
        tid: args.userId, firstName: args.update.firstName ?? '', lastName: args.update.lastName ?? '',
        username: args.update.username ?? '', lang: args.lang === '' ? config.langs.split(',')[0] : args.lang });
    } else if (component(existing, BrahmanUser).blocked) {
      context.change.patch(userPath, { $set: { blocked: false } });
    }
    const sessionPath = `${args.botPath}/sessions/${args.userId}`;
    if (await optionalNode(context.read, sessionPath) === undefined)
      context.change.put({ $path: sessionPath, $type: 'brahman.session', ...new BrahmanSession(), tid: args.userId });
  } };
}

/** Preserve the typed reserved conversation fields while allowing authored user data. */
export const conversationDataSchema: PropertySchema = { type: 'object', additionalProperties: true, properties: {
  wait: { type: 'object', additionalProperties: false,
    required: ['type', 'saveTo', 'deleteMessages', 'sentMsgId', 'remaining'], properties: {
      type: { type: 'string', enum: ['text', 'photo'] }, saveTo: { type: 'string' }, deleteMessages: { type: 'boolean' },
      sentMsgId: { type: 'integer' }, remaining: { type: 'array', items: { type: 'string' } },
    } },
  error: { type: 'object', required: ['message'], additionalProperties: false, properties: { message: { type: 'string' } } },
  param: { type: 'string' }, text: { type: 'string' }, params: { type: 'array', items: { type: 'string' } },
  _lastMsgId: { type: 'integer' }, _lastMenu: { type: 'string' }, _emittedText: { type: 'string' },
} };

/** Explicit coordinator transitions remain ordinary native actions. */
export function conversationActions(): Readonly<Record<string, ActionDef>> {
  return {
    enterPage: { kind: 'write', args: { type: 'object', additionalProperties: false,
      required: ['page'], properties: { page: { type: 'string' }, param: { type: 'string' } } }, async handler(context, input) {
      if (typeof input !== 'object' || input === null || !('page' in input) || typeof input.page !== 'string')
        throw new KernelError('INVALID', 'Conversation page is required');
      const root = `${conversationBot(context.node.$path)}/pages`;
      if (input.page !== root && !input.page.startsWith(`${root}/`)) throw new KernelError('NOT_FOUND', 'Page is outside the bot');
      await nativeNode(context.read, input.page);
      const session = component<NativeSessionState>(context.node, 'brahman.session');
      const data = { ...session.data };
      if ('param' in input) {
        if (typeof input.param !== 'string') throw new KernelError('INVALID', 'Command parameter must be text');
        data.param = input.param;
      }
      context.change.patch(context.node.$path, { $set: { data, history: [...session.history, input.page] } });
    } },

    saveResult: { kind: 'write', args: { type: 'object', additionalProperties: false,
      required: ['field', 'value'], properties: { field: { type: 'string' }, value: {} } }, async handler(context, input) {
      if (typeof input !== 'object' || input === null || !('field' in input) || typeof input.field !== 'string'
        || !('value' in input) || input.value === undefined) throw new KernelError('INVALID', 'Conversation result is required');
      const session = component<NativeSessionState>(context.node, 'brahman.session');
      context.change.patch(context.node.$path, { $set: { data: { ...session.data, [input.field]: input.value } } });
    } },

    queueWait: { kind: 'write', args: { type: 'object', required: ['remaining'], additionalProperties: false,
      properties: { remaining: { type: 'array', items: { type: 'string' } } } }, async handler(context, input) {
      if (typeof input !== 'object' || input === null || !('remaining' in input) || !Array.isArray(input.remaining)
        || !input.remaining.every((path: unknown) => typeof path === 'string')) throw new KernelError('INVALID', 'Remaining actions must be paths');
      const session = component<NativeSessionState>(context.node, 'brahman.session');
      if (session.data.wait === undefined) throw new KernelError('CONFLICT', 'Question no longer waits for input');
      context.change.patch(context.node.$path, { $set: { data: { ...session.data,
        wait: { ...session.data.wait, remaining: input.remaining } } } });
    } },

    resumeWait: { kind: 'write', io: true, args: brahmanRunSchema, async handler(context, input) {
      const args = runArguments(input);
      if (context.node.$path !== `${args.botPath}/sessions/${args.userId}`)
        throw new KernelError('INVALID', 'Update targets another conversation');
      const session = component<NativeSessionState>(context.node, 'brahman.session');
      const wait = session.data.wait;
      if (wait === undefined) throw new KernelError('CONFLICT', 'Question no longer waits for input');
      const value = wait.type === 'text' ? args.update.text : args.update.photo;
      if (value === undefined) throw new KernelError('INVALID', 'Update does not answer the question');
      if (wait.deleteMessages) {
        await telegram(context).remove(args.botPath, args.chatId, wait.sentMsgId);
        if (args.update.messageId !== undefined) await telegram(context).remove(args.botPath, args.chatId, args.update.messageId);
      }
      const data = { ...session.data, [wait.saveTo]: value };
      delete data.wait;
      context.change.patch(context.node.$path, { $set: { data } });
    } },
  };
}
