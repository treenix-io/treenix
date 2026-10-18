import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Bot } from 'grammy';
import { openNativeRuntime } from '@treenx/core/kernel/runtime';
import { R, W } from '@treenx/core/kernel';
import { KernelError } from '@treenx/core/errors';
import { createNativeBrahman } from '#brahman/native-service';
import {
  BotConfig,
  BrahmanUser,
  MessageAction,
  QuestionAction,
  SetValueAction,
  CallAction,
  EvalAction,
  ACTION_TYPES,
} from '#brahman/types';
import { createMcpSession } from '#mcp/mcp-session';
import { component, nativeNode, type NativeSessionState } from '#brahman/native-state';

/** Exercise real autostart, Telegram routing and persisted native action sequencing. */
test('native bot resumes a question and executes owned child calls and scripts', async () => {
  const sent: string[] = [];
  const acknowledged: string[] = [];
  let stopObserved = () => {};
  const stopped = new Promise<void>((resolve) => {
    stopObserved = resolve;
  });
  let ready = (_bot: Bot) => {};
  const running = new Promise<Bot>((resolve) => {
    ready = resolve;
  });
  const binding = await createNativeBrahman({
    bot(token) {
      const bot = new Bot(token, {
        botInfo: {
          id: 700,
          is_bot: true,
          first_name: 'Native',
          username: 'native_bot',
          can_join_groups: true,
          can_read_all_group_messages: false,
          supports_inline_queries: false,
          can_manage_bots: false,
          can_connect_to_business: false,
          has_main_web_app: false,
          has_topics_enabled: false,
          allows_users_to_create_topics: false,
        },
        client: {
          async fetch(url: RequestInfo | URL, init?: RequestInit) {
            if (String(url).endsWith('/answerCallbackQuery')) {
              if (typeof init?.body !== 'string')
                throw new Error('Callback request has no JSON body');
              const payload: { callback_query_id: string } = JSON.parse(init.body);
              acknowledged.push(payload.callback_query_id);
              return new Response(JSON.stringify({ ok: true, result: true }), {
                headers: { 'content-type': 'application/json' },
              });
            }
            if (!String(url).endsWith('/sendMessage'))
              throw new Error(`Unexpected Telegram endpoint: ${String(url)}`);
            if (typeof init?.body !== 'string')
              throw new Error('Telegram request has no JSON body');
            const payload: { text: string } = JSON.parse(init.body);
            sent.push(payload.text);
            return new Response(
              JSON.stringify({
                ok: true,
                result: {
                  message_id: sent.length,
                  date: 0,
                  chat: { id: 12, type: 'private', first_name: 'User' },
                  text: payload.text,
                },
              }),
              {
                headers: { 'content-type': 'application/json' },
              },
            );
          },
        },
      });
      return bot;
    },
    start(bot) {
      ready(bot);
      return {
        stop() {
          stopObserved();
        },
      };
    },
  });
  assert.deepEqual(
    binding.manifest.types
      .filter((type) => type.name.startsWith('brahman.action.'))
      .map((type) => type.name)
      .sort(),
    ACTION_TYPES.map((type) => type.type).sort(),
  );
  const temporary = new URL('../../../temp/', import.meta.url);
  await mkdir(temporary, { recursive: true });
  const directory = await mkdtemp(fileURLToPath(new URL('native-brahman-data-', temporary)));
  const runtime = await openNativeRuntime({
    id: 'native-brahman',
    directory,
    credentialTtlMs: 60_000,
    firstAdmin: { path: '/admin', name: 'admin', password: 'native-smoke' },
    modules: [binding.manifest],
    io: binding.io,
  });
  try {
    const session = await runtime.instance.openSession(runtime.instance.setupCredential);
    const admin = await createMcpSession(session);
    await admin.set_node({
      node: { $path: '/bot', $type: 'brahman.bot', ...new BotConfig(), token: '700:native-token' },
    });
    const node = await nativeNode(session, '/bot');
    await admin.commit({
      expect: { nodes: [{ path: node.$path, rev: node.$rev }] },
      changes: [
        {
          op: 'patch',
          path: '/bot',
          ops: {
            $set: {
              $acl: [{ subject: { group: `n:${node.$id}` }, grant: R | W }],
            },
          },
        },
      ],
    });
    await admin.commit({ changes: [{ op: 'move', from: '/bot', to: '/sys/autostart' }] });
    const bot = await running;
    const root = '/sys/autostart';
    const page = `${root}/pages/start`,
      actions = `${page}/_actions`;
    const order = ['message', 'question', 'value', 'call', 'eval'].map(
      (name) => `${actions}/${name}`,
    );
    await admin.commit({
      changes: [
        { op: 'put', node: { $path: `${root}/pages`, $type: 't.dir' } },
        {
          op: 'put',
          node: { $path: page, $type: 'brahman.page', command: '/start', positions: order },
        },
        { op: 'put', node: { $path: actions, $type: 't.dir' } },
        {
          op: 'put',
          node: {
            $path: order[0],
            $type: 'brahman.action.message',
            ...new MessageAction(),
            text: { en: 'Welcome' },
          },
        },
        {
          op: 'put',
          node: {
            $path: order[1],
            $type: 'brahman.action.question',
            ...new QuestionAction(),
            text: { en: 'Name?' },
            saveTo: 'answer',
          },
        },
        {
          op: 'put',
          node: {
            $path: order[2],
            $type: 'brahman.action.setvalue',
            ...new SetValueAction(),
            value: '6 * 7',
            saveTo: 'number',
          },
        },
        {
          op: 'put',
          node: {
            $path: order[3],
            $type: 'brahman.action.call',
            ...new CallAction(),
            path: `${root}/sessions/12`,
            action: 'saveResult',
            dataExpr: '{"field":"child","value":"accepted"}',
          },
        },
        {
          op: 'put',
          node: {
            $path: order[4],
            $type: 'brahman.action.eval',
            ...new EvalAction(),
            value: `await ctx.io.telegram({botPath: data.botPath, chatId: data.chatId, text: 'Script accepted'});`,
          },
        },
      ],
    });
    await bot.handleUpdate({
      update_id: 1,
      message: {
        message_id: 1,
        date: 0,
        chat: { id: 12, type: 'private', first_name: 'User' },
        from: { id: 12, is_bot: false, first_name: 'User', language_code: 'en' },
        text: '/start',
      },
    });
    const waiting = component<NativeSessionState>(
      await nativeNode(session, `${root}/sessions/12`),
      'brahman.session',
    );
    assert.deepEqual(sent, ['Welcome', 'Name?']);
    assert.deepEqual(waiting.data.wait?.remaining, order.slice(2));
    const sentBeforeWrongInput = [...sent];
    await bot.handleUpdate({
      update_id: 10,
      message: {
        message_id: 10,
        date: 0,
        chat: { id: 12, type: 'private', first_name: 'User' },
        from: {
          id: 12,
          is_bot: false,
          first_name: 'User',
          language_code: 'en',
        },
        photo: [
          {
            file_id: 'photo-input',
            file_unique_id: 'photo-unique',
            width: 1,
            height: 1,
          },
        ],
      },
    });
    const wrongInput = component<NativeSessionState>(
      await nativeNode(session, `${root}/sessions/12`),
      'brahman.session',
    );
    assert.deepEqual(sent, sentBeforeWrongInput);
    assert.deepEqual(wrongInput.data.wait, waiting.data.wait);
    assert.equal(wrongInput.data.answer, undefined);
    assert.deepEqual(wrongInput.history, waiting.history);

    await admin.commit({
      changes: [
        {
          op: 'patch',
          path: `${root}/users/12`,
          ops: { $set: { banned: true } },
        },
      ],
    });
    const sentBeforeBan = [...sent];
    await bot.handleUpdate({
      update_id: 11,
      message: {
        message_id: 11,
        date: 0,
        chat: { id: 12, type: 'private', first_name: 'User' },
        from: {
          id: 12,
          is_bot: false,
          first_name: 'User',
          language_code: 'en',
        },
        text: 'Blocked answer',
      },
    });
    assert.deepEqual(sent, sentBeforeBan);
    const bannedState = component<NativeSessionState>(
      await nativeNode(session, `${root}/sessions/12`),
      'brahman.session',
    );
    assert.equal(bannedState.data.answer, undefined);
    assert.deepEqual(bannedState.data.wait, waiting.data.wait);
    assert.deepEqual(bannedState.history, waiting.history);
    await admin.commit({
      changes: [
        {
          op: 'patch',
          path: `${root}/users/12`,
          ops: { $set: { banned: false } },
        },
      ],
    });

    assert.equal(
      component(await nativeNode(session, `${root}/users/12`), BrahmanUser).firstName,
      'User',
    );
    await bot.handleUpdate({
      update_id: 2,
      message: {
        message_id: 2,
        date: 0,
        chat: { id: 12, type: 'private', first_name: 'User' },
        from: { id: 12, is_bot: false, first_name: 'User', language_code: 'en' },
        text: 'Alice',
      },
    });
    const state = component<NativeSessionState>(
      await nativeNode(session, `${root}/sessions/12`),
      'brahman.session',
    );
    assert.equal(state.data.answer, 'Alice');
    assert.equal(state.data.number, 42);
    assert.equal(state.data.child, 'accepted');
    assert.equal(state.data.wait, undefined);
    assert.deepEqual(state.history, [page]);
    assert.deepEqual(sent, ['Welcome', 'Name?', 'Script accepted']);
    const callbackPage = `${root}/pages/incoming`;
    await admin.commit({
      changes: [
        {
          op: 'put',
          node: {
            $path: callbackPage,
            $type: 'brahman.page',
            command: '/incoming',
            positions: [`${callbackPage}/_actions/select`],
          },
        },
        { op: 'put', node: { $path: `${callbackPage}/_actions`, $type: 't.dir' } },
        {
          op: 'put',
          node: {
            $path: `${callbackPage}/_actions/select`,
            $type: 'brahman.action.setvalue',
            ...new SetValueAction(),
            value: 'data.param',
            saveTo: 'selected',
          },
        },
      ],
    });
    await bot.handleUpdate({
      update_id: 20,
      callback_query: {
        id: 'receipt-1',
        from: { id: 12, is_bot: false, first_name: 'User' },
        chat_instance: 'chat',
        data: 'cmd:incoming:note:1',
        message: {
          message_id: 5,
          date: 0,
          chat: { id: 12, type: 'private', first_name: 'User' },
          text: 'Older receipt',
        },
      },
    });
    const selected = component<NativeSessionState>(
      await nativeNode(session, `${root}/sessions/12`),
      'brahman.session',
    );
    assert.equal(selected.data.selected, 'note:1');
    assert.equal(selected.history.at(-1), callbackPage);
    assert.deepEqual(acknowledged, ['receipt-1']);
    const history = await session.read({ history: `${root}/sessions/12` });
    assert.ok(history.history);
    assert.deepEqual(
      [...new Set(history.history.map((entry) => entry.executor))],
      [`n:${node.$id}`],
    );
    await admin.execute({ path: root, action: 'stop', args: {} });
    await stopped;
    assert.equal(component(await nativeNode(session, root), BotConfig).running, false);
    const restarted = new Promise<Bot>((resolve) => {
      ready = resolve;
    });
    await admin.execute({ path: root, action: 'start', args: {} });
    assert.equal((await restarted) instanceof Bot, true);
    assert.equal(component(await nativeNode(session, root), BotConfig).running, true);
  } finally {
    await runtime.close();
  }
});

test('maintenance replies before creating a user or conversation session', async () => {
  const sent: string[] = [];
  let ready = (_bot: Bot) => {};
  const running = new Promise<Bot>((resolve) => {
    ready = resolve;
  });
  const binding = await createNativeBrahman({
    bot(token) {
      const bot = new Bot(token, {
        botInfo: {
          id: 700,
          is_bot: true,
          first_name: 'Native',
          username: 'native_bot',
          can_join_groups: true,
          can_read_all_group_messages: false,
          supports_inline_queries: false,
          can_manage_bots: false,
          can_connect_to_business: false,
          has_main_web_app: false,
          has_topics_enabled: false,
          allows_users_to_create_topics: false,
        },
        client: {
          async fetch(url: RequestInfo | URL, init?: RequestInit) {
            if (!String(url).endsWith('/sendMessage'))
              throw new Error(`Unexpected Telegram endpoint: ${String(url)}`);
            if (typeof init?.body !== 'string')
              throw new Error('Telegram request has no JSON body');
            const payload: { text: string } = JSON.parse(init.body);
            sent.push(payload.text);
            return new Response(
              JSON.stringify({
                ok: true,
                result: {
                  message_id: sent.length,
                  date: 0,
                  chat: { id: 12, type: 'private', first_name: 'User' },
                  text: payload.text,
                },
              }),
              {
                headers: { 'content-type': 'application/json' },
              },
            );
          },
        },
      });
      return bot;
    },
    start(bot) {
      ready(bot);
      return { stop() {} };
    },
  });
  assert.deepEqual(
    binding.manifest.types
      .filter((type) => type.name.startsWith('brahman.action.'))
      .map((type) => type.name)
      .sort(),
    ACTION_TYPES.map((type) => type.type).sort(),
  );
  const temporary = new URL('../../../temp/', import.meta.url);
  await mkdir(temporary, { recursive: true });
  const directory = await mkdtemp(fileURLToPath(new URL('native-brahman-data-', temporary)));
  const runtime = await openNativeRuntime({
    id: 'native-brahman',
    directory,
    credentialTtlMs: 60_000,
    firstAdmin: { path: '/admin', name: 'admin', password: 'native-smoke' },
    modules: [binding.manifest],
    io: binding.io,
  });
  try {
    const session = await runtime.instance.openSession(runtime.instance.setupCredential);
    const admin = await createMcpSession(session);
    await admin.set_node({
      node: {
        $path: '/bot',
        $type: 'brahman.bot',
        ...new BotConfig(),
        maintenance: 'Scheduled maintenance',
        token: '700:native-token',
      },
    });
    const node = await nativeNode(session, '/bot');
    await admin.commit({
      expect: { nodes: [{ path: node.$path, rev: node.$rev }] },
      changes: [
        {
          op: 'patch',
          path: '/bot',
          ops: {
            $set: {
              $acl: [{ subject: { group: `n:${node.$id}` }, grant: R | W }],
            },
          },
        },
      ],
    });
    await admin.commit({
      changes: [{ op: 'move', from: '/bot', to: '/sys/autostart' }],
    });
    const bot = await running;
    const root = '/sys/autostart';
    await bot.handleUpdate({
      update_id: 1,
      message: {
        message_id: 1,
        date: 0,
        chat: { id: 12, type: 'private', first_name: 'User' },
        from: {
          id: 12,
          is_bot: false,
          first_name: 'User',
          language_code: 'en',
        },
        text: '/start',
      },
    });
    assert.deepEqual(sent, ['Scheduled maintenance']);
    for (const path of [`${root}/users/12`, `${root}/sessions/12`]) {
      await assert.rejects(
        session.read({ node: path }),
        (error) => error instanceof KernelError && error.code === 'NOT_FOUND',
      );
    }
  } finally {
    await runtime.close();
  }
});
