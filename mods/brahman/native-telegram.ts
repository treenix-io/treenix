import { AbortController as TelegramAbortController } from 'abort-controller';
import { Bot } from 'grammy';
import { getActionContext } from '@treenx/core/kernel';
import { KernelError } from '@treenx/core/errors';
import type { ActionIoBinding, Principal } from '@treenx/core/kernel/types';
import type { BrahmanTelegram } from '#brahman/native-ports';

interface RunningBot {
  readonly bot: Bot;
  readonly principal: Principal;
}

/** Bind external Telegram calls to each actual running node service. */
export function telegramOwner(): {
  readonly io: ActionIoBinding;
  register(path: string, principal: Principal, bot: Bot): () => void;
} {
  const running = new Map<string, RunningBot>();
  const io: ActionIoBinding = scope => {
    const controller = new TelegramAbortController();
    /** Grammy owns this signal type; actual action retirement cancels every bound external call. */
    function abort(): void {
      scope.signal.removeEventListener('abort', abort);
      controller.abort();
    }
    if (scope.signal.aborted) abort();
    else scope.signal.addEventListener('abort', abort, { once: true });
    const telegramSignal = controller.signal;

    /** Resolve the live bot only after checking the real executor or operator proof. */
    async function admitted(path: string): Promise<Bot> {
      scope.assertActive();
      const owner = running.get(path);
      if (owner === undefined) throw new KernelError('UNAVAILABLE', 'Bot service is not running');
      const context = getActionContext('write');
      if (context.executor.principal !== owner.principal) await context.requireAdmin();
      scope.assertActive();
      if (running.get(path) !== owner) throw new KernelError('UNAVAILABLE', 'Bot service stopped');
      return owner.bot;
    }

    const brahman: BrahmanTelegram = {
      async send(path, chatId, text, options) {
        const bot = await admitted(path);
        const sent = await bot.api.sendMessage(chatId, text, {
          parse_mode: options.parse_mode,
          link_preview_options: options.disableLinks ? { is_disabled: true } : undefined,
          reply_parameters: options.replyToMessageId === undefined ? undefined : { message_id: options.replyToMessageId },
          reply_markup: options.replyMarkup,
        }, telegramSignal);
        scope.assertActive();
        return sent.message_id;
      },
      async edit(path, chatId, messageId, text, options) {
        const bot = await admitted(path);
        const markup = options.replyMarkup;
        if (markup !== undefined && !('inline_keyboard' in markup))
          throw new KernelError('INVALID', 'Edited message requires an inline keyboard');
        await bot.api.editMessageText(chatId, messageId, text, {
          parse_mode: options.parse_mode, reply_markup: markup,
          link_preview_options: options.disableLinks ? { is_disabled: true } : undefined,
        }, telegramSignal);
        scope.assertActive();
      },
      async remove(path, chatId, messageId) {
        await (await admitted(path)).api.deleteMessage(chatId, messageId, telegramSignal);
        scope.assertActive();
      },
      async forward(path, chatId, fromChatId, messageId) {
        const sent = await (await admitted(path)).api.forwardMessage(chatId, fromChatId, messageId, undefined, telegramSignal);
        scope.assertActive();
        return sent.message_id;
      },
      async file(path, chatId, kind, fileId) {
        const bot = await admitted(path);
        const api = bot.api;
        const sent = kind === 'photo' ? await api.sendPhoto(chatId, fileId, undefined, telegramSignal)
          : kind === 'video' ? await api.sendVideo(chatId, fileId, undefined, telegramSignal)
          : kind === 'audio' ? await api.sendAudio(chatId, fileId, undefined, telegramSignal)
          : kind === 'voice' ? await api.sendVoice(chatId, fileId, undefined, telegramSignal)
          : kind === 'document' ? await api.sendDocument(chatId, fileId, undefined, telegramSignal)
          : kind === 'sticker' ? await api.sendSticker(chatId, fileId, undefined, telegramSignal)
          : kind === 'animation' ? await api.sendAnimation(chatId, fileId, undefined, telegramSignal)
          : undefined;
        if (sent === undefined) throw new KernelError('INVALID', 'Unsupported Telegram file kind');
        scope.assertActive();
        return sent.message_id;
      },
    };
    return { brahman };
  };

  return { io, register(path, principal, bot) {
    if (running.has(path)) throw new KernelError('CONFLICT', 'Bot service is already running');
    const owner = { bot, principal };
    running.set(path, owner);
    return () => { if (running.get(path) === owner) running.delete(path); };
  } };
}
