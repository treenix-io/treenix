import { randomUUID } from 'node:crypto';
import { Bot, type Context } from 'grammy';
import { run } from '@grammyjs/runner';
import { KernelError } from '@treenx/core/errors';
import type { ActionIoBinding, ModuleManifest, OpId, ServiceHandler } from '@treenx/core/kernel/types';
import { BotConfig, BrahmanUser, MessageAction, type MenuButton } from '#brahman/types';
import { checkTags, formatTString } from '#brahman/helpers';
import { component, nativeNode } from '#brahman/native-state';
import { NativeConversation } from '#brahman/native-coordinator';
import { nativeBrahmanManifest } from '#brahman/native-module';
import { telegramOwner } from '#brahman/native-telegram';
import type { BrahmanRunArgs } from '#brahman/native-ports';

export interface NativeBrahmanOptions {
  readonly bot?: (token: string) => Bot;
  readonly start?: (bot: Bot) => { stop(): Promise<void> | void };
}

/** Bind the module and its Telegram capability to one deployment owner. */
export async function createNativeBrahman(options: NativeBrahmanOptions = {}): Promise<{
  readonly manifest: ModuleManifest;
  readonly io: ActionIoBinding;
}> {
  const owner = telegramOwner();
  const service: ServiceHandler = async (node, session) => {
    const lane = session.lane[Symbol.asyncIterator]();
    const welcome = await lane.next();
    if (welcome.done || welcome.value.t !== 'welcome') throw new KernelError('UNAVAILABLE', 'Bot session has no welcome');
    let intake = welcome.value.intake;
    const key = (): OpId => ({ epoch: intake, time: Date.now(), nonce: randomUUID() });
    const conversation = new NativeConversation(session, key);
    let config = component(node, BotConfig);
    if (!config.running) {
      const done = (async () => {
        for await (const frame of { [Symbol.asyncIterator]: () => lane })
          if (frame.t === 'end' || frame.t === 'fail' && frame.req === undefined) throw frame.error;
      })();
      return { done, async stop() { await done; } };
    }
    if (config.token === '') throw new KernelError('INVALID', 'Bot token is not configured');
    const bot = options.bot === undefined ? new Bot(config.token) : options.bot(config.token);
    const unregister = owner.register(node.$path, session.actor.principal, bot);
    const queues = new Map<number, Promise<void>>();
    let runner: ReturnType<NonNullable<NativeBrahmanOptions['start']>> | undefined;
    let active = true;
    let configuration = Promise.resolve();
    let rejectService = (_error: unknown) => {};
    const failed = new Promise<never>((_resolve, reject) => { rejectService = reject; });

    /** Apply the protected running flag to the adapter's actual runner. */
    async function refresh(): Promise<void> {
      config = component(await nativeNode(session, node.$path), BotConfig);
      if (config.running && runner === undefined && active) runner = options.start === undefined ? run(bot) : options.start(bot);
      else if (!config.running && runner !== undefined) {
        const previous = runner;
        runner = undefined;
        await previous.stop();
      }
    }

    /** Resolve an authored button through the current owner's grants and tag policy. */
    async function button(selected: MenuButton, args: BrahmanRunArgs, tags: string[]): Promise<void> {
      if (!checkTags(tags, selected.tags ?? [])) throw new KernelError('FORBIDDEN', 'Menu button requires user tags');
      if (selected.action === undefined || selected.action.target === undefined)
        throw new KernelError('INVALID', 'Menu button has no action target');
      if (selected.action.type === 'brahman.action.page') await conversation.page(selected.action.target, args);
      else await conversation.actions([selected.action.target], args);
    }

    /** Translate Telegram input at the external boundary, then invoke native operations. */
    async function update(context: Context): Promise<void> {
      if (!active) throw new KernelError('UNAVAILABLE', 'Bot service stopped');
      if (context.from === undefined || context.chat === undefined) return;
      const textInput = context.message?.text;
      const messageId = context.msg?.message_id;
      const photo = context.message?.photo?.at(-1)?.file_id;
      const callbackData = context.callbackQuery?.data;
      const firstName = context.from.first_name, lastName = context.from.last_name, username = context.from.username;
      const voice = context.message?.voice, audio = context.message?.audio;
      const args: BrahmanRunArgs = { botPath: node.$path, userId: context.from.id, chatId: context.chat.id,
        lang: context.from.language_code ?? config.langs.split(',')[0].trim(), update: {
          ...(textInput === undefined ? {} : { text: textInput }), ...(messageId === undefined ? {} : { messageId }),
          ...(photo === undefined ? {} : { photo }), ...(callbackData === undefined ? {} : { callbackData }),
          firstName, ...(lastName === undefined ? {} : { lastName }), ...(username === undefined ? {} : { username }),
          ...(voice === undefined ? {} : { voice: { fileId: voice.file_id, mime: voice.mime_type ?? 'audio/ogg' } }),
          ...(audio === undefined ? {} : { audio: { fileId: audio.file_id, mime: audio.mime_type ?? 'audio/ogg' } }),
        } };
      await conversation.act(node.$path, 'initialize', args);
      const user = component(await nativeNode(session, `${node.$path}/users/${args.userId}`), BrahmanUser);
      if (user.banned) return;
      const current = { ...args, lang: user.lang };
      try {
        if (config.maintenance !== '') { await context.reply(config.maintenance); return; }
        if (await conversation.resume(current)) return;
        const data = current.update.callbackData;
        if (data !== undefined) {
          if (data.startsWith('page:')) {
            const target = data.slice(5), split = target.indexOf(':');
            await conversation.page(split < 0 ? target : target.slice(0, split), current, split < 0 ? undefined : target.slice(split + 1));
          } else if (data.startsWith('lang:')) {
            const lang = data.slice(5);
            await conversation.act(`${node.$path}/users/${args.userId}`, 'setLanguage', { lang });
            const page = await conversation.command(current, 'start');
            if (page === undefined) throw new KernelError('NOT_FOUND', 'Bot has no start page');
            await conversation.page(page, { ...current, lang });
          } else if (data.startsWith('btn:')) {
            const id = Number(data.slice(4));
            if (!Number.isSafeInteger(id)) throw new KernelError('INVALID', 'Menu button identity is invalid');
            const menuPath = (await conversation.state(current)).data._lastMenu;
            if (menuPath === undefined) throw new KernelError('NOT_FOUND', 'Conversation menu is missing');
            const menu = component(await nativeNode(session, menuPath), MessageAction);
            const selected = menu.rows.flatMap(row => row.buttons).find(item => item.id === id);
            if (selected === undefined) throw new KernelError('NOT_FOUND', 'Menu button is missing');
            await button(selected, current, user.tags);
          } else throw new KernelError('INVALID', 'Unknown bot callback');
          await context.answerCallbackQuery();
          return;
        }
        const text = current.update.text;
        if (text !== undefined) {
          await conversation.act(`${node.$path}/sessions/${args.userId}`, 'saveResult', { field: 'text', value: text });
          if (!text.startsWith('/')) {
            const menuPath = (await conversation.state(current)).data._lastMenu;
            if (menuPath !== undefined) {
              const menu = component(await nativeNode(session, menuPath), MessageAction);
              if (menu.menuType === 'keyboard') {
                const selected = menu.rows.flatMap(row => row.buttons).find(item => formatTString(item.title, current.lang) === text);
                if (selected !== undefined) { await button(selected, current, user.tags); return; }
              }
            }
          }
        }
        const command = text === undefined ? undefined : /^\/([^\s@]+)(?:@[^\s]+)?(?:\s+(.*))?$/.exec(text);
        let page = command === null || command === undefined ? undefined : await conversation.command(current, command[1]);
        if (page === undefined) page = await conversation.command(current, 'start');
        if (page === undefined) throw new KernelError('NOT_FOUND', 'Bot has no matching or start page');
        await conversation.page(page, current, command?.[2]);
      } catch (error) {
        console.error('[brahman] native conversation failed', error);
        await conversation.act(`${node.$path}/sessions/${args.userId}`, 'saveResult', {
          field: 'error', value: { message: error instanceof Error ? error.message : String(error) },
        });
        const page = await conversation.command(current, 'error');
        if (page === undefined) throw error;
        await conversation.page(page, current);
      }
    }

    bot.use(async context => {
      if (context.from === undefined) return;
      const userId = context.from.id;
      const previous = queues.get(userId) ?? Promise.resolve();
      const pending = previous.catch(error => console.error('[brahman] preceding update failed', error)).then(() => update(context));
      queues.set(userId, pending);
      try { await pending; } finally { if (queues.get(userId) === pending) queues.delete(userId); }
    });
    bot.catch(error => console.error('[brahman] Telegram update failed', error.error));
    const sub = session.sub({ node: node.$path });
    const pump = (async () => {
      try {
        for (;;) {
          const item = await lane.next();
          if (item.done) return;
          const frame = item.value;
          // Each pending outcome owns its request failure; an admission failure closes the service.
          if (frame.t === 'fail' && frame.req === undefined) throw frame.error;
          if (frame.t === 'end' && frame.sub === sub) throw frame.error;
          if (frame.t === 'pos' && frame.coverage !== true) {
            if (frame.intake !== undefined) intake = frame.intake;
            if (frame.changes.some(change => change.op === 'put' ? ('node' in change.copy ? change.copy.node.$id : change.copy.id) === node.$id
              : change.op === 'patch' || change.op === 'del' ? change.id === node.$id : false))
              configuration = configuration.then(refresh).catch(error => {
                if (!active && error instanceof KernelError && (error.code === 'CANCELLED' || error.code === 'UNAUTHENTICATED')) return;
                active = false;
                unregister();
                rejectService(error);
              });
          }
        }
      } catch (error) {
        if (!(error instanceof KernelError) || (error.code !== 'CANCELLED' && error.code !== 'UNAUTHENTICATED')) throw error;
      } finally {
        active = false;
        unregister();
        if (runner !== undefined) await runner.stop();
      }
    })();
    const done = Promise.race([pump, failed]);
    await bot.init();
    await refresh();
    return { done, async stop() { active = false; unregister(); await done; await configuration; await Promise.all(queues.values()); } };
  };
  const manifest = await nativeBrahmanManifest(service, {
    async telegram(io, input) {
      if (typeof input !== 'object' || input === null || !('botPath' in input) || typeof input.botPath !== 'string'
        || !('chatId' in input) || typeof input.chatId !== 'number' || !Number.isSafeInteger(input.chatId)
        || !('text' in input) || typeof input.text !== 'string') throw new KernelError('INVALID', 'Guest Telegram message is invalid');
      if (io.brahman === undefined) throw new KernelError('UNAVAILABLE', 'Telegram capability is unavailable');
      return io.brahman.send(input.botPath, input.chatId, input.text, {});
    },
  });
  return { manifest, io: owner.io };
}
