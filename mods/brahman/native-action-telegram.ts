import type { ActionDef } from '@treenx/core/kernel/types';
import { KernelError } from '@treenx/core/errors';
import { buildLangKeyboard, buildReplyMarkup } from '#brahman/helpers';
import { FileAction, ForwardAction, MessageAction, QuestionAction, RemoveAction, SelectLanguageAction } from '#brahman/types';
import { component, formatNative, nativeNode, runAction, telegram, textNative } from '#brahman/native-state';
import type { TelegramMessageOptions } from '#brahman/native-ports';

/** Native Telegram effects remain tied to the admitted bot owner and state commit. */
export function telegramActions(): Readonly<Record<string, ActionDef>> {
  return {
    message: runAction(MessageAction, async (context, config, state) => {
      const text = await textNative(config.text, state);
      const markup = buildReplyMarkup(config.rows, config.menuType, state.args.lang, state.user.tags);
      const reply = config.replyToMsgId ? state.data[config.replyToMsgId] : undefined;
      const replyToMessageId = reply === undefined ? undefined : Number(reply);
      if (replyToMessageId !== undefined && !Number.isSafeInteger(replyToMessageId))
        throw new KernelError('INVALID', 'Reply message identity is invalid');
      const options: TelegramMessageOptions = { parse_mode: 'HTML', disableLinks: config.disableLinks,
        replyMarkup: markup?.reply_markup, replyToMessageId };
      const port = telegram(context);
      if (config.chatId) {
        await port.send(state.args.botPath, await formatNative(config.chatId, state), text, options);
      } else if (config.menuType === 'inline_close' && state.args.update.callbackData !== undefined) {
        if (state.args.update.messageId === undefined) throw new KernelError('INVALID', 'Callback message identity is required');
        await port.edit(state.args.botPath, state.args.chatId, state.args.update.messageId, text, options);
      } else {
        state.data._lastMsgId = await port.send(state.args.botPath, state.args.chatId, text, options);
      }
      if (config.menuType === 'keyboard' || config.menuType === 'inline' || config.menuType === 'inline_new')
        state.data._lastMenu = context.node.$path;
    }, { io: true }),

    question: runAction(QuestionAction, async (context, config, state) => {
      const messageId = await telegram(context).send(state.args.botPath, state.args.chatId, await textNative(config.text, state),
        { parse_mode: 'HTML', replyMarkup: { force_reply: true } });
      if (config.saveTo) state.data.wait = { type: config.inputType, saveTo: config.saveTo,
        deleteMessages: config.deleteMessages, sentMsgId: messageId, remaining: [] };
    }, { io: true }),

    file: runAction(FileAction, async (context, config, state) => {
      if (config.fileId === '') return;
      const resolved = await formatNative(config.fileId, state);
      let fileId = resolved;
      if (resolved.startsWith('/')) {
        const node = await nativeNode(context.read, resolved);
        fileId = component(node, FileAction).fileId;
      }
      await telegram(context).file(state.args.botPath, state.args.chatId, config.asType === '' ? 'document' : config.asType, fileId);
    }, { io: true }),

    remove: runAction(RemoveAction, async (context, _config, state) => {
      if (state.args.update.messageId === undefined) throw new KernelError('INVALID', 'Telegram message identity is required');
      await telegram(context).remove(state.args.botPath, state.args.chatId, state.args.update.messageId);
    }, { io: true }),

    forward: runAction(ForwardAction, async (context, config, state) => {
      const target = config.toFrom ? Number(await formatNative(config.toFrom, state)) : state.args.chatId;
      const messageId = config.msgIdFrom ? Number(state.data[config.msgIdFrom] ?? config.msgIdFrom) : state.args.update.messageId;
      if (!Number.isSafeInteger(target) || messageId === undefined || !Number.isSafeInteger(messageId))
        throw new KernelError('INVALID', 'Forward destination and message identity are required');
      await telegram(context).forward(state.args.botPath, target, state.args.chatId, messageId);
    }, { io: true }),

    selectlang: runAction(SelectLanguageAction, async (context, config, state) => {
      const languages = state.config.langs.split(',').map(language => language.trim());
      const text = await textNative(config.text, state);
      await telegram(context).send(state.args.botPath, state.args.chatId, text === '' ? 'Select language:' : text,
        { parse_mode: 'HTML', replyMarkup: buildLangKeyboard(languages) });
    }, { io: true }),
  };
}
