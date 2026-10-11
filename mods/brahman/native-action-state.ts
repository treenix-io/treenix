import type { ActionDef } from '@treenx/core/kernel/types';
import { KernelError } from '@treenx/core/errors';
import { resolveVar } from '#brahman/helpers';
import { evalBool, evalExpr } from '#brahman/sandbox';
import { GetValueAction, ParamsAction, ResetHistoryAction, ResetSessionAction, SetValueAction, TagAction } from '#brahman/types';
import { formatNative, runAction } from '#brahman/native-state';

/** Conversation mutations stay in the executor's canonical native ChangeSet. */
export function stateActions(): Readonly<Record<string, ActionDef>> {
  return {
    tag: runAction(TagAction, async (context, config, state) => {
      if (config.tag === '') return;
      const shouldSet = config.value === '' || config.value === 'true'
        ? true : await evalBool(await formatNative(config.value, state), { session: state.data, data: state.data });
      const tags = [...state.user.tags];
      const index = tags.indexOf(config.tag);
      if (shouldSet && index < 0) tags.push(config.tag);
      else if (!shouldSet && index >= 0) tags.splice(index, 1);
      context.change.patch(state.userPath, { $set: { tags } });
    }),

    getvalue: runAction(GetValueAction, async (_context, config, state) => {
      if (config.path === '' || config.saveTo === '') return;
      const source = await formatNative(config.path, state);
      const value = resolveVar(source, { ...state.data, user: state.user, history: state.history,
        tags: state.user.tags, userTags: state.user.tags, lang: state.args.lang, session: state.data,
        ctx: { user: state.user, session: state.data } });
      if (value === undefined) throw new KernelError('NOT_FOUND', 'Conversation value is absent');
      state.data[config.saveTo] = value;
    }),

    setvalue: runAction(SetValueAction, async (_context, config, state) => {
      if (config.saveTo === '') return;
      state.data[config.saveTo] = await evalExpr(await formatNative(config.value, state),
        { session: state.data, data: state.data, user: state.user });
    }),

    params: runAction(ParamsAction, async (_context, config, state) => {
      const command = state.args.update.text?.match(/^\/\S+\s+(.*)/);
      let raw = command === null || command === undefined ? state.data.param : command[1];
      if (raw === undefined || raw === '') return;
      if (config.base64) raw = Buffer.from(raw, 'base64').toString('utf8');
      const parts = raw.split(config.split === '' ? ',' : config.split).map(part => part.trim());
      for (let index = 0; index < config.names.length; index++) {
        const part = parts[index];
        state.data[config.names[index]] = part === undefined ? '' : part;
      }
      state.data.params = parts;
    }),

    resetsession: runAction(ResetSessionAction, async (_context, _config, state) => {
      for (const key of Object.keys(state.data)) delete state.data[key];
    }),

    resethistory: runAction(ResetHistoryAction, async (_context, _config, state) => {
      state.history = [];
    }),
  };
}
