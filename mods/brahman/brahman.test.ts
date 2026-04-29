// Brahman bot tests — fake Grammy, real tree, full signal flow
// Tests: template engine, keyboards, tag filtering, page/action execution, middleware

import { type NodeData, register, resolve } from '@treenx/core';
import { registerType } from '@treenx/core/comp';
import type { ServiceCtx } from '@treenx/core/contexts/service';
import { serverNodeHandle } from '@treenx/core/server/actions';
import { createMemoryTree, type Tree } from '@treenx/core/tree';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { buildReplyMarkup, checkTags, formatTString, renderTemplate } from './helpers';
import { setBotFactory } from './service';
import { type MenuRow, type TString } from './types';

// Force registration of brahman types + action handlers
import './types';
import './service';

// ── FakeBot ──

type Handler = (ctx: any) => Promise<void>;
type Middleware = (ctx: any, next: () => Promise<void>) => Promise<void>;

class FakeBot {
  middlewares: Middleware[] = [];
  commands = new Map<string, Handler>();
  events = new Map<string, Handler>();
  errorHandler: ((err: unknown) => void) | null = null;

  use(mw: Middleware) { this.middlewares.push(mw); }
  command(name: string, handler: Handler) { this.commands.set(name, handler); }
  on(filter: string, handler: Handler) { this.events.set(filter, handler); }
  catch(handler: (err: unknown) => void) { this.errorHandler = handler; }
  started = false;
  botInfo = { id: 1, is_bot: true, first_name: 'TestBot', username: 'test_bot' };
  async init() {}
  async start() { this.started = true; }
  async stop() { this.started = false; }

  async dispatch(ctx: any, type: 'command' | 'callback' | 'text', commandName?: string) {
    // Run middleware chain, then the handler
    let handlerCalled = false;
    // Grammy routes /commands through message:text if no explicit bot.command() handler
    const handler = type === 'command'
      ? (this.commands.get(commandName!) ?? this.events.get('message:text'))
      : type === 'callback' ? this.events.get('callback_query:data')
      : this.events.get('message:text');

    const runMiddleware = async (i: number): Promise<void> => {
      if (i < this.middlewares.length) {
        await this.middlewares[i](ctx, () => runMiddleware(i + 1));
      } else if (handler && !handlerCalled) {
        handlerCalled = true;
        await handler(ctx);
      }
    };

    try {
      await runMiddleware(0);
    } catch (e) {
      if (this.errorHandler) this.errorHandler(e);
      else throw e;
    }
  }
}

// ── FakeContext ──

type Sent = { method: string; args: unknown[] };

function createFakeCtx(opts: {
  userId?: number;
  text?: string;
  callbackData?: string;
  firstName?: string;
}): any {
  const sent: Sent[] = [];
  let msgCounter = 100;

  return {
    _sent: sent,
    from: {
      id: opts.userId ?? 12345,
      first_name: opts.firstName ?? 'Test',
      last_name: 'User',
      username: 'testuser',
      language_code: 'en',
    },
    chat: { id: opts.userId ?? 12345 },
    message: opts.text != null ? {
      text: opts.text,
      message_id: ++msgCounter,
    } : undefined,
    callbackQuery: opts.callbackData != null ? {
      data: opts.callbackData,
      message: { message_id: ++msgCounter },
    } : undefined,
    reply: async (text: string, o?: unknown) => {
      const mid = ++msgCounter;
      sent.push({ method: 'reply', args: [text, o] });
      return { message_id: mid };
    },
    editMessageText: async (text: string, o?: unknown) => {
      sent.push({ method: 'editMessageText', args: [text, o] });
    },
    deleteMessage: async () => {
      sent.push({ method: 'deleteMessage', args: [] });
    },
    answerCallbackQuery: async (text?: string) => {
      sent.push({ method: 'answerCallbackQuery', args: [text] });
    },
    api: {
      sendMessage: async (chatId: unknown, text: string, o?: unknown) => {
        sent.push({ method: 'sendMessage', args: [chatId, text, o] });
        return { message_id: ++msgCounter };
      },
      deleteMessage: async (chatId: unknown, msgId: unknown) => {
        sent.push({ method: 'api.deleteMessage', args: [chatId, msgId] });
      },
      forwardMessage: async (to: unknown, from: unknown, msgId: unknown) => {
        sent.push({ method: 'forwardMessage', args: [to, from, msgId] });
      },
    },
    replyWithPhoto: async (id: unknown) => { sent.push({ method: 'replyWithPhoto', args: [id] }); },
    replyWithVideo: async (id: unknown) => { sent.push({ method: 'replyWithVideo', args: [id] }); },
    replyWithAudio: async (id: unknown) => { sent.push({ method: 'replyWithAudio', args: [id] }); },
    replyWithVoice: async (id: unknown) => { sent.push({ method: 'replyWithVoice', args: [id] }); },
    replyWithDocument: async (id: unknown) => { sent.push({ method: 'replyWithDocument', args: [id] }); },
  };
}

// ── Tree seeding ──

const BOT = '/test-bot';

async function seedTestBot(tree: Tree) {
  // Bot node
  await tree.set({ $path: BOT, $type: 'brahman.bot', token: 'fake:token', langs: 'en,ru' } as NodeData);

  // Dirs
  for (const d of ['pages', 'users', 'sessions'])
    await tree.set({ $path: `${BOT}/${d}`, $type: 'dir' } as NodeData);

  // /start page — fields on node directly (getComponent returns node when $type matches)
  await tree.set({
    $path: `${BOT}/pages/start`, $type: 'brahman.page',
    command: '/start', positions: [`${BOT}/pages/start/_actions/welcome`],
  } as NodeData);

  await tree.set({
    $path: `${BOT}/pages/start/_actions/welcome`, $type: 'brahman.action.message',
    text: { en: 'Welcome, {user.firstName}!', ru: 'Привет, {user.firstName}!' },
    menuType: 'keyboard',
    rows: [{
      buttons: [
        { id: 1, title: { en: 'Help', ru: 'Помощь' } as TString, action: { type: 'brahman.action.page', target: `${BOT}/pages/help` } },
        { id: 2, title: { en: 'About', ru: 'О нас' } as TString, action: { type: 'brahman.action.page', target: `${BOT}/pages/about` } },
      ],
    }],
  } as NodeData);

  // /help page
  await tree.set({
    $path: `${BOT}/pages/help`, $type: 'brahman.page',
    command: '/help', positions: [`${BOT}/pages/help/_actions/msg`],
  } as NodeData);

  await tree.set({
    $path: `${BOT}/pages/help/_actions/msg`, $type: 'brahman.action.message',
    text: { en: 'Help page' }, menuType: 'none', rows: [],
  } as NodeData);

  // /about page with setvalue + message
  await tree.set({
    $path: `${BOT}/pages/about`, $type: 'brahman.page',
    command: '', positions: [`${BOT}/pages/about/_actions/setval`, `${BOT}/pages/about/_actions/msg`],
  } as NodeData);

  await tree.set({
    $path: `${BOT}/pages/about/_actions/setval`, $type: 'brahman.action.setvalue',
    value: '"visited"', saveTo: 'aboutStatus',
  } as NodeData);

  await tree.set({
    $path: `${BOT}/pages/about/_actions/msg`, $type: 'brahman.action.message',
    text: { en: 'About us. Status: {aboutStatus}' }, menuType: 'none', rows: [],
  } as NodeData);
}

// ── Start the service with FakeBot ──

async function startTestBot(tree: Tree): Promise<FakeBot> {
  const fakeBot = new FakeBot();
  const handler = resolve('brahman.bot', 'service') as any;
  assert.ok(handler, 'brahman.bot service handler must be registered');

  const botNode = await tree.get(BOT);
  assert.ok(botNode, 'bot node must exist');

  setBotFactory(() => fakeBot);
  const svcCtx: ServiceCtx = {
    tree,
    path: botNode.$path,
    subscribe: () => () => {},
  };

  await handler(botNode, svcCtx);
  return fakeBot;
}

// ── Tests ──

describe('brahman template engine', () => {
  it('formatTString: exact lang', () => {
    assert.equal(formatTString({ en: 'Hello', ru: 'Привет' }, 'en'), 'Hello');
    assert.equal(formatTString({ en: 'Hello', ru: 'Привет' }, 'ru'), 'Привет');
  });

  it('formatTString: fallback chain', () => {
    assert.equal(formatTString({ ru: 'Только ру' }, 'de'), 'Только ру');
    assert.equal(formatTString({ en: 'Only en' }, 'de'), 'Only en');
    assert.equal(formatTString({ fr: 'Bonjour' }, 'de'), 'Bonjour');
  });

  it('formatTString: empty/undefined', () => {
    assert.equal(formatTString(undefined, 'en'), '');
    assert.equal(formatTString({}, 'en'), '');
  });

  it('renderTemplate: simple interpolation', () => {
    assert.equal(renderTemplate('{name}', { name: 'Bob' }), 'Bob');
    assert.equal(renderTemplate('Hi {{name}}!', { name: 'Alice' }), 'Hi Alice!');
  });

  it('renderTemplate: dot-path', () => {
    assert.equal(
      renderTemplate('{user.firstName}', { user: { firstName: 'Test' } }),
      'Test',
    );
  });

  it('renderTemplate: ifEquals', () => {
    const tpl = '{{#ifEquals lang "en"}}English{{else}}Other{{/ifEquals}}';
    assert.equal(renderTemplate(tpl, { lang: 'en' }), 'English');
    assert.equal(renderTemplate(tpl, { lang: 'ru' }), 'Other');
  });

  it('renderTemplate: tag helper', () => {
    const tpl = '{{#tag admin}}Admin content{{else}}Normal{{/tag}}';
    assert.equal(renderTemplate(tpl, { userTags: ['admin'] }), 'Admin content');
    assert.equal(renderTemplate(tpl, { userTags: [] }), 'Normal');
  });

  it('renderTemplate: eval', () => {
    assert.equal(renderTemplate('{{eval 2 + 3}}', {}), '5');
    assert.equal(renderTemplate('{{eval data.x * 2}}', { x: 10 }), '20');
  });

  it('renderTemplate: toFixed', () => {
    assert.equal(renderTemplate('{{toFixed price 2}}', { price: 3.14159 }), '3.14');
  });

  it('renderTemplate: is', () => {
    assert.equal(renderTemplate('{{is active}}', { active: true }), 'true');
    assert.equal(renderTemplate('{{is active}}', { active: false }), '');
  });

  it('renderTemplate: switch', () => {
    assert.equal(renderTemplate('{{switch lang ru Привет en Hello}}', { lang: 'en' }), 'Hello');
    assert.equal(renderTemplate('{{switch lang ru Привет en Hello}}', { lang: 'ru' }), 'Привет');
    assert.equal(renderTemplate('{{switch lang ru Привет en Hello}}', { lang: 'de' }), '');
  });
});

describe('brahman checkTags', () => {
  it('empty tags = always show', () => {
    assert.ok(checkTags([], []));
    assert.ok(checkTags(['admin'], []));
  });

  it('include tags (OR logic)', () => {
    assert.ok(checkTags(['admin'], ['admin']));
    assert.ok(checkTags(['admin', 'vip'], ['vip']));
    assert.ok(!checkTags([], ['admin']));
    assert.ok(!checkTags(['user'], ['admin']));
  });

  it('exclude tags (!prefix)', () => {
    assert.ok(checkTags([], ['!banned']));
    assert.ok(!checkTags(['banned'], ['!banned']));
  });

  it('mixed include + exclude', () => {
    assert.ok(checkTags(['admin'], ['admin', '!banned']));
    assert.ok(!checkTags(['admin', 'banned'], ['admin', '!banned']));
    assert.ok(!checkTags(['banned'], ['admin', '!banned']));
  });
});

describe('brahman buildReplyMarkup', () => {
  const rows: MenuRow[] = [{
    buttons: [
      { id: 1, title: { en: 'Btn1' }, action: { type: 'brahman.action.page', target: '/p1' } },
      { id: 2, title: { en: 'Btn2' }, url: 'https://example.com' },
    ],
  }];

  it('none returns undefined', () => {
    assert.equal(buildReplyMarkup(rows, 'none', 'en'), undefined);
  });

  it('remove returns remove_keyboard', () => {
    const r = buildReplyMarkup(rows, 'remove', 'en') as any;
    assert.ok(r.reply_markup.remove_keyboard);
  });

  it('force_reply returns force_reply', () => {
    const r = buildReplyMarkup(rows, 'force_reply', 'en') as any;
    assert.ok(r.reply_markup.force_reply);
  });

  it('keyboard builds reply keyboard', () => {
    const r = buildReplyMarkup(rows, 'keyboard', 'en') as any;
    assert.ok(r.reply_markup);
  });

  it('inline builds inline keyboard', () => {
    const r = buildReplyMarkup(rows, 'inline', 'en') as any;
    assert.ok(r.reply_markup);
  });

  it('filters by tags', () => {
    const taggedRows: MenuRow[] = [{
      buttons: [
        { id: 1, title: { en: 'Admin only' }, tags: ['admin'] },
        { id: 2, title: { en: 'Public' } },
      ],
    }];
    // non-admin: only Public button should remain
    const r = buildReplyMarkup(taggedRows, 'keyboard', 'en', []) as any;
    assert.ok(r.reply_markup);
    const kbText = JSON.stringify(r.reply_markup);
    assert.ok(kbText.includes('Public'), 'should include Public button');
    assert.ok(!kbText.includes('Admin only'), 'should exclude Admin only button');
  });
});

describe('brahman full signal flow', () => {
  let tree: Tree;
  let bot: FakeBot;

  before(async () => {
    tree = createMemoryTree();
    await seedTestBot(tree);
    bot = await startTestBot(tree);
  });

  after(() => setBotFactory(undefined));

  it('/start command → session created → welcome message sent', async () => {
    const ctx = createFakeCtx({ userId: 100, text: '/start' });
    await bot.dispatch(ctx, 'command', 'start');

    // Session should be created
    const session = await tree.get(`${BOT}/sessions/100`);
    assert.ok(session, 'session created');

    // User should be created
    const user = await tree.get(`${BOT}/users/100`);
    assert.ok(user, 'user created');

    // Welcome message sent with template resolved
    const replies = ctx._sent.filter((s: Sent) => s.method === 'reply');
    assert.ok(replies.length > 0, 'at least one reply');
    assert.ok(
      (replies[0].args[0] as string).includes('Welcome, Test!'),
      `expected "Welcome, Test!" in "${replies[0].args[0]}"`,
    );
  });

  it('/help command → help page message', async () => {
    const ctx = createFakeCtx({ userId: 100, text: '/help' });
    await bot.dispatch(ctx, 'command', 'help');

    const replies = ctx._sent.filter((s: Sent) => s.method === 'reply');
    assert.ok(replies.length > 0);
    assert.equal(replies[0].args[0], 'Help page');
  });

  it('text message matching keyboard button → navigates to page', async () => {
    // First send /start to get the keyboard and set history
    const ctx1 = createFakeCtx({ userId: 200, text: '/start' });
    await bot.dispatch(ctx1, 'command', 'start');

    // Now send "Help" text matching the keyboard button
    const ctx2 = createFakeCtx({ userId: 200, text: 'Help' });
    await bot.dispatch(ctx2, 'text');

    const replies = ctx2._sent.filter((s: Sent) => s.method === 'reply');
    assert.ok(replies.length > 0, 'reply sent after button match');
    assert.equal(replies[0].args[0], 'Help page');
  });

  it('callback_query page: prefix → navigates', async () => {
    // First /start so middleware creates session
    const ctx1 = createFakeCtx({ userId: 300, text: '/start' });
    await bot.dispatch(ctx1, 'command', 'start');

    // callback_query with page: prefix
    const ctx2 = createFakeCtx({ userId: 300, callbackData: `page:${BOT}/pages/help` });
    await bot.dispatch(ctx2, 'callback');

    const replies = ctx2._sent.filter((s: Sent) => s.method === 'reply');
    assert.ok(replies.length > 0, 'page navigated via callback');
    assert.equal(replies[0].args[0], 'Help page');

    // answerCallbackQuery should be called
    assert.ok(ctx2._sent.some((s: Sent) => s.method === 'answerCallbackQuery'));
  });

  it('setvalue action updates session, message reads it', async () => {
    // /start first
    const ctx1 = createFakeCtx({ userId: 400, text: '/start' });
    await bot.dispatch(ctx1, 'command', 'start');

    // Navigate to about page (which runs setvalue + message)
    const ctx2 = createFakeCtx({ userId: 400, callbackData: `page:${BOT}/pages/about` });
    await bot.dispatch(ctx2, 'callback');

    const replies = ctx2._sent.filter((s: Sent) => s.method === 'reply');
    assert.ok(replies.length > 0);
    assert.ok(
      (replies[0].args[0] as string).includes('Status: visited'),
      `expected "Status: visited" in "${replies[0].args[0]}"`,
    );
  });

  it('maintenance mode → reply maintenance text, no page execution', async () => {
    const mStore = createMemoryTree();
    // Bot with maintenance set
    await mStore.set({
      $path: BOT, $type: 'brahman.bot',
      token: 'fake:token', langs: 'en', maintenance: 'Bot is under maintenance',
    } as NodeData);

    for (const d of ['pages', 'users', 'sessions'])
      await mStore.set({ $path: `${BOT}/${d}`, $type: 'dir' } as NodeData);

    await mStore.set({
      $path: `${BOT}/pages/start`, $type: 'brahman.page',
      command: '/start', positions: [],
    } as NodeData);

    const mBot = await startTestBot(mStore);
    const ctx = createFakeCtx({ userId: 500, text: '/start' });
    await mBot.dispatch(ctx, 'command', 'start');

    const replies = ctx._sent.filter((s: Sent) => s.method === 'reply');
    assert.equal(replies.length, 1);
    assert.equal(replies[0].args[0], 'Bot is under maintenance');
  });

  it('banned user → silently dropped', async () => {
    // Create a banned user
    await tree.set({
      $path: `${BOT}/users/600`, $type: 'brahman.user',
      tid: 600, firstName: 'Bad', lastName: 'User', username: 'bad',
      lang: 'en', isAdmin: false, blocked: false, banned: true, tags: [],
    } as NodeData);

    await tree.set({
      $path: `${BOT}/sessions/600`, $type: 'brahman.session',
      tid: 600, data: {}, history: [], callbacks: {},
    } as NodeData);

    const ctx = createFakeCtx({ userId: 600, text: '/start' });
    await bot.dispatch(ctx, 'command', 'start');

    // No replies — banned user is silently ignored
    const replies = ctx._sent.filter((s: Sent) => s.method === 'reply');
    assert.equal(replies.length, 0, 'banned user gets no reply');
  });

  it('unknown text → fallback to /start', async () => {
    const ctx1 = createFakeCtx({ userId: 700, text: '/start' });
    await bot.dispatch(ctx1, 'command', 'start');

    const ctx2 = createFakeCtx({ userId: 700, text: 'random gibberish' });
    await bot.dispatch(ctx2, 'text');

    // Should fallback to /start page
    const replies = ctx2._sent.filter((s: Sent) => s.method === 'reply');
    assert.ok(replies.length > 0, 'fallback reply sent');
    assert.ok(
      (replies[0].args[0] as string).includes('Welcome'),
      'fallback goes to /start',
    );
  });

  it('session persists across calls', async () => {
    // Visit about page → sets aboutStatus in session
    const ctx1 = createFakeCtx({ userId: 800, text: '/start' });
    await bot.dispatch(ctx1, 'command', 'start');

    const ctx2 = createFakeCtx({ userId: 800, callbackData: `page:${BOT}/pages/about` });
    await bot.dispatch(ctx2, 'callback');

    // Check session was saved with aboutStatus
    const sessionNode = await tree.get(`${BOT}/sessions/800`);
    assert.ok(sessionNode);
    // With flat storage, data is directly on the node
    const sessionData = (sessionNode as any).data;
    assert.equal(sessionData?.aboutStatus, 'visited');
  });

  it('history tracks visited pages across calls', async () => {
    const ctx1 = createFakeCtx({ userId: 900, text: '/start' });
    await bot.dispatch(ctx1, 'command', 'start');

    const ctx2 = createFakeCtx({ userId: 900, text: '/help' });
    await bot.dispatch(ctx2, 'command', 'help');

    const sessionNode = await tree.get(`${BOT}/sessions/900`);
    assert.ok(sessionNode);
    const history = (sessionNode as any).history;
    assert.ok(Array.isArray(history));
    assert.ok(history.length >= 2, `expected >=2 history entries, got ${history.length}`);
    assert.ok(history.includes(`${BOT}/pages/start`));
    assert.ok(history.includes(`${BOT}/pages/help`));
  });
});

describe('brahman bot start/stop actions', () => {
  it('registers start and stop actions', () => {
    assert.ok(resolve('brahman.bot', 'action:start'));
    assert.ok(resolve('brahman.bot', 'action:stop'));
  });

  it('action:start delegates to autostart via ctx.nc', async () => {
    const handler = resolve('brahman.bot', 'action:start')!;
    const node = { $path: '/b', $type: 'brahman.bot', token: 't' } as NodeData;
    const tree = createMemoryTree();
    // No autostart node in tree → executeAction throws NOT_FOUND
    await assert.rejects(
      () => handler({ node, tree, signal: AbortSignal.timeout(1000), nc: serverNodeHandle(tree) }, undefined) as Promise<void>,
    );
  });

  it('action:stop delegates to autostart via ctx.nc', async () => {
    const handler = resolve('brahman.bot', 'action:stop')!;
    const node = { $path: '/b', $type: 'brahman.bot', token: 't' } as NodeData;
    const tree = createMemoryTree();
    await assert.rejects(
      () => handler({ node, tree, signal: AbortSignal.timeout(1000), nc: serverNodeHandle(tree) }, undefined) as Promise<void>,
    );
  });

  it('service skips bot.start() when running=false', async () => {
    const s = createMemoryTree();
    await s.set({ $path: '/b2', $type: 'brahman.bot', token: 'fake:t', langs: 'en', running: false } as NodeData);
    for (const d of ['pages', 'users', 'sessions'])
      await s.set({ $path: `/b2/${d}`, $type: 'dir' } as NodeData);

    const fb = new FakeBot();
    setBotFactory(() => fb);

    const handler = resolve('brahman.bot', 'service') as any;
    const handle = await handler(await s.get('/b2'), { tree: s, subscribe: () => () => {} });

    assert.equal(fb.started, false, 'bot should not be started when running=false');

    await handle.stop();
    setBotFactory(undefined);
  });

  it('service starts bot when running=true (default)', async () => {
    const s = createMemoryTree();
    await s.set({ $path: '/b3', $type: 'brahman.bot', token: 'fake:t', langs: 'en' } as NodeData);
    for (const d of ['pages', 'users', 'sessions'])
      await s.set({ $path: `/b3/${d}`, $type: 'dir' } as NodeData);

    const fb = new FakeBot();
    setBotFactory(() => fb);

    const handler = resolve('brahman.bot', 'service') as any;
    const handle = await handler(await s.get('/b3'), { tree: s, subscribe: () => () => {} });

    assert.equal(fb.started, true, 'bot should be started by default');

    await handle.stop();
    setBotFactory(undefined);
  });

  it('init() fills alias and name from botInfo', async () => {
    const s = createMemoryTree();
    await s.set({ $path: '/b4', $type: 'brahman.bot', token: 'fake:t', langs: 'en' } as NodeData);
    for (const d of ['pages', 'users', 'sessions'])
      await s.set({ $path: `/b4/${d}`, $type: 'dir' } as NodeData);

    const fb = new FakeBot();
    fb.botInfo = { id: 42, is_bot: true, first_name: 'MyBot', username: 'my_cool_bot' };
    setBotFactory(() => fb);

    const handler = resolve('brahman.bot', 'service') as any;
    const handle = await handler(await s.get('/b4'), { tree: s, subscribe: () => () => {} });

    const node = await s.get('/b4');
    assert.equal((node as any).alias, '@my_cool_bot');
    assert.equal((node as any).name, 'MyBot');

    await handle.stop();
    setBotFactory(undefined);
  });

  it('init() does not overwrite existing alias/name', async () => {
    const s = createMemoryTree();
    await s.set({ $path: '/b5', $type: 'brahman.bot', token: 'fake:t', langs: 'en', alias: '@custom', name: 'Custom' } as NodeData);
    for (const d of ['pages', 'users', 'sessions'])
      await s.set({ $path: `/b5/${d}`, $type: 'dir' } as NodeData);

    const fb = new FakeBot();
    fb.botInfo = { id: 42, is_bot: true, first_name: 'MyBot', username: 'my_cool_bot' };
    setBotFactory(() => fb);

    const handler = resolve('brahman.bot', 'service') as any;
    const handle = await handler(await s.get('/b5'), { tree: s, subscribe: () => () => {} });

    const node = await s.get('/b5');
    assert.equal((node as any).alias, '@custom');
    assert.equal((node as any).name, 'Custom');

    await handle.stop();
    setBotFactory(undefined);
  });
});

describe('brahman persistent wait', () => {
  let tree: Tree;
  let bot: FakeBot;

  before(async () => {
    tree = createMemoryTree();
    await seedTestBot(tree);

    // Add a page with question + follow-up message
    await tree.set({
      $path: `${BOT}/pages/ask`, $type: 'brahman.page',
      command: '/ask',
      positions: [`${BOT}/pages/ask/_actions/q`, `${BOT}/pages/ask/_actions/reply`],
    } as NodeData);

    await tree.set({
      $path: `${BOT}/pages/ask/_actions/q`, $type: 'brahman.action.question',
      text: { en: 'What is your name?' }, inputType: 'text', saveTo: 'userName', deleteMessages: false,
    } as NodeData);

    await tree.set({
      $path: `${BOT}/pages/ask/_actions/reply`, $type: 'brahman.action.message',
      text: { en: 'Hello, {userName}!' }, menuType: 'none', rows: [],
    } as NodeData);

    bot = await startTestBot(tree);
  });

  after(() => setBotFactory(undefined));

  it('question action sets session.wait, next message resolves it', async () => {
    // Trigger /ask — question sends prompt, sets session.wait, stops before reply action
    const ctx1 = createFakeCtx({ userId: 1100, text: '/ask' });
    await bot.dispatch(ctx1, 'command', 'ask');

    // Prompt was sent
    const replies1 = ctx1._sent.filter((s: Sent) => s.method === 'reply');
    assert.ok(replies1.some((r: Sent) => (r.args[0] as string).includes('What is your name?')));

    // session.wait persisted in tree
    const session1 = await tree.get(`${BOT}/sessions/1100`);
    assert.ok(session1);
    const wait = (session1 as any).data?.wait;
    assert.ok(wait, 'session.wait should be set');
    assert.equal(wait.type, 'text');
    assert.equal(wait.saveTo, 'userName');
    assert.deepEqual(wait.remaining, [`${BOT}/pages/ask/_actions/reply`]);

    // User answers — middleware resolves wait, runs remaining reply action
    const ctx2 = createFakeCtx({ userId: 1100, text: 'Alice' });
    await bot.dispatch(ctx2, 'text');

    // Reply action should have run with the answer
    const replies2 = ctx2._sent.filter((s: Sent) => s.method === 'reply');
    assert.ok(
      replies2.some((r: Sent) => (r.args[0] as string).includes('Hello, Alice!')),
      `expected "Hello, Alice!" in replies: ${replies2.map((r: Sent) => r.args[0])}`,
    );

    // wait state cleared
    const session2 = await tree.get(`${BOT}/sessions/1100`);
    assert.equal((session2 as any).data?.wait, undefined, 'wait should be cleared after answer');
    assert.equal((session2 as any).data?.userName, 'Alice', 'answer saved to session');
  });

  it('wait survives simulated restart (new bot instance, same tree)', async () => {
    // Trigger /ask on fresh user
    const ctx1 = createFakeCtx({ userId: 1200, text: '/ask' });
    await bot.dispatch(ctx1, 'command', 'ask');

    // Verify wait is set in tree
    const session1 = await tree.get(`${BOT}/sessions/1200`);
    assert.ok((session1 as any).data?.wait, 'wait persisted');

    // "Restart" — create a new bot instance with the same tree
    const bot2 = await startTestBot(tree);

    // Answer comes to new bot instance
    const ctx2 = createFakeCtx({ userId: 1200, text: 'Bob' });
    await bot2.dispatch(ctx2, 'text');

    const replies = ctx2._sent.filter((s: Sent) => s.method === 'reply');
    assert.ok(
      replies.some((r: Sent) => (r.args[0] as string).includes('Hello, Bob!')),
      'answer resolved after restart',
    );

    const session2 = await tree.get(`${BOT}/sessions/1200`);
    assert.equal((session2 as any).data?.userName, 'Bob');
    assert.equal((session2 as any).data?.wait, undefined, 'wait cleared after restart resolve');
  });

  it('non-matching message type does not resolve wait', async () => {

    // Set up a wait for photo type
    await tree.set({
      $path: `${BOT}/pages/photo`, $type: 'brahman.page',
      command: '/photo', positions: [`${BOT}/pages/photo/_actions/q`],
    } as NodeData);
    await tree.set({
      $path: `${BOT}/pages/photo/_actions/q`, $type: 'brahman.action.question',
      text: { en: 'Send a photo' }, inputType: 'photo', saveTo: 'photoId', deleteMessages: false,
    } as NodeData);

    const ctx1 = createFakeCtx({ userId: 1300, text: '/photo' });
    await bot.dispatch(ctx1, 'command', 'photo');

    // Text message should NOT resolve a photo wait — falls through to normal routing
    const ctx2 = createFakeCtx({ userId: 1300, text: 'not a photo' });
    await bot.dispatch(ctx2, 'text');

    const session = await tree.get(`${BOT}/sessions/1300`);
    assert.ok((session as any).data?.wait, 'wait should still be pending (wrong type)');
  });
});

// ── Test target for CallAction ──

class _TestTarget {
  value = 0;
  bump() {
    this.value += 1;
    return this.value;
  }
}
registerType('test.brahman.target', _TestTarget);
register('test.brahman.target', 'schema', () => ({
  $id: 'test.brahman.target', title: 'TestTarget', type: 'object' as const,
  properties: { value: { type: 'number' } },
  methods: { bump: { arguments: [] } },
}));

describe('brahman.action.call', () => {
  it('calls tree action via server executeAction and saves result', async () => {
    const tree = createMemoryTree();
    await seedTestBot(tree);
    const bot = await startTestBot(tree);

    // Target node with test type
    await tree.set({
      $path: '/targets/counter', $type: 'test.brahman.target',
      value: 10,
    } as NodeData);

    // Page with CallAction → message showing result
    await tree.set({
      $path: `${BOT}/pages/call-test`, $type: 'brahman.page',
      command: '/calltest',
      positions: [`${BOT}/pages/call-test/_actions/call`, `${BOT}/pages/call-test/_actions/result`],
    } as NodeData);

    await tree.set({
      $path: `${BOT}/pages/call-test/_actions/call`, $type: 'brahman.action.call',
      path: '/targets/counter', action: 'bump', saveTo: 'bumpResult',
    } as NodeData);

    await tree.set({
      $path: `${BOT}/pages/call-test/_actions/result`, $type: 'brahman.action.message',
      text: { en: 'Bumped: {bumpResult}' }, menuType: 'none', rows: [],
    } as NodeData);

    const ctx = createFakeCtx({ userId: 1400, text: '/calltest' });
    await bot.dispatch(ctx, 'command', 'calltest');

    // Result message shows bumped value
    const replies = ctx._sent.filter((s: Sent) => s.method === 'reply');
    assert.ok(
      replies.some((r: Sent) => (r.args[0] as string).includes('Bumped: 11')),
      `expected "Bumped: 11" in replies: ${replies.map((r: Sent) => r.args[0])}`,
    );

    // Target node mutated via Immer draft
    const target = await tree.get('/targets/counter');
    assert.equal((target as any).value, 11);

    setBotFactory(undefined);
  });

  it('formats path template from session vars', async () => {
    const tree = createMemoryTree();
    await seedTestBot(tree);
    const bot = await startTestBot(tree);

    await tree.set({
      $path: '/items/abc', $type: 'test.brahman.target', value: 5,
    } as NodeData);

    // Page: setvalue to set itemId → call with templated path
    await tree.set({
      $path: `${BOT}/pages/tcall`, $type: 'brahman.page',
      command: '/tcall',
      positions: [
        `${BOT}/pages/tcall/_actions/setid`,
        `${BOT}/pages/tcall/_actions/call`,
        `${BOT}/pages/tcall/_actions/msg`,
      ],
    } as NodeData);

    await tree.set({
      $path: `${BOT}/pages/tcall/_actions/setid`, $type: 'brahman.action.setvalue',
      value: '"abc"', saveTo: 'itemId',
    } as NodeData);

    await tree.set({
      $path: `${BOT}/pages/tcall/_actions/call`, $type: 'brahman.action.call',
      path: '/items/{itemId}', action: 'bump', saveTo: 'res',
    } as NodeData);

    await tree.set({
      $path: `${BOT}/pages/tcall/_actions/msg`, $type: 'brahman.action.message',
      text: { en: 'Result: {res}' }, menuType: 'none', rows: [],
    } as NodeData);

    const ctx = createFakeCtx({ userId: 1500, text: '/tcall' });
    await bot.dispatch(ctx, 'command', 'tcall');

    const replies = ctx._sent.filter((s: Sent) => s.method === 'reply');
    assert.ok(
      replies.some((r: Sent) => (r.args[0] as string).includes('Result: 6')),
      `expected "Result: 6" in replies: ${replies.map((r: Sent) => r.args[0])}`,
    );

    setBotFactory(undefined);
  });
});
