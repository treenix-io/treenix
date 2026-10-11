import { getComponentField } from '@treenx/core';
import { KernelError } from '@treenx/core/errors';
import type { ActionDef } from '@treenx/core/kernel/types';
import { checkTags } from '#brahman/helpers';
import { evalBool } from '#brahman/sandbox';
import { BackAction, BrahmanUser, BroadcastAction, CallAction, EmitTextAction, IfElseAction,
  KeywordSelectAction, OnErrorAction, PageNavAction } from '#brahman/types';
import { component, formatNative, nativeNode, runAction, telegram } from '#brahman/native-state';

/** Flow directives are consumed after the action's canonical state commit. */
export function flowActions(): Readonly<Record<string, ActionDef>> {
  return {
    ifelse: runAction(IfElseAction, async (_context, config, state) => {
      const matches = await evalBool(await formatNative(config.condition, state),
        { session: state.data, data: state.data, user: state.user });
      const action = matches ? config.actionIf : config.actionElse;
      return { ...(action === '' ? {} : { action }), stop: config.stopAfterAction };
    }),

    page: runAction(PageNavAction, async (_context, config, state) => {
      if (config.targetPage !== '') return { page: await formatNative(config.targetPage, state) };
    }),

    back: runAction(BackAction, async (_context, _config, state) => {
      state.history.pop();
      const previous = state.history.pop();
      if (previous !== undefined) return { page: previous };
    }),

    broadcast: runAction(BroadcastAction, async (context, config, state) => {
      if (config.action === '') return;
      const users = await context.read.read({ children: `${state.args.botPath}/users` });
      if (users.next !== undefined) throw new KernelError('BUDGET', 'Broadcast exceeds its native user window');
      const broadcast: { action: string; userId: number; chatId: number; lang: string }[] = [];
      for (const copy of users.copies) {
        if ('error' in copy) throw copy.error;
        const user = component(copy.node, BrahmanUser);
        if (user.banned || user.blocked || !checkTags(user.tags, config.userTags)) continue;
        broadcast.push({ action: config.action, userId: user.tid, chatId: user.tid, lang: user.lang });
      }
      return { broadcast };
    }, { save: false }),

    emittext: runAction(EmitTextAction, async (_context, config, state) => {
      if (config.from === '') return;
      const text = await formatNative(config.from, state);
      if (text.startsWith('/')) return { emittedText: text };
      state.data._emittedText = text;
    }),

    onerror: runAction(OnErrorAction, async (_context, config, state) => {
      const error = state.data.error;
      if (error === undefined || (config.error !== '' && !error.message.includes(config.error))) return;
      if (config.action !== '') return { action: config.action };
    }),

    keywordselect: runAction(KeywordSelectAction, async (context, config, state) => {
      const source = config.textFrom !== '' ? await formatNative(config.textFrom, state)
        : state.data.text ?? state.args.update.text ?? '';
      const words = source.toLowerCase().split(/\s+/);
      for (const element of config.elements) {
        if (!element.keywords.some(keyword => words.includes(keyword.toLowerCase()))) continue;
        if (element.message.startsWith('/')) return { emittedText: element.message };
        await telegram(context).send(state.args.botPath, state.args.chatId, element.message, {});
        return;
      }
    }, { io: true }),

    call: runAction(CallAction, async (context, config, state) => {
      if (config.path === '' || config.action === '') return;
      const path = await formatNative(config.path, state);
      let field = config.key === '' ? undefined : config.key;
      if (field === undefined && config.type !== '') {
        const selected = getComponentField(await nativeNode(context.read, path), config.type);
        if (selected === undefined) throw new KernelError('NOT_FOUND', 'Call component is absent');
        field = selected[1];
      }
      const args: unknown = JSON.parse(await formatNative(config.dataExpr, state));
      return { call: { path, ...(field === undefined ? {} : { component: field }), action: config.action, args,
        ...(config.saveTo === '' ? {} : { saveTo: config.saveTo }) } };
    }, { save: false }),
  };
}
