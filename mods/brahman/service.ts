// Brahman bot service — Telegram runtime
// Session + auth middleware, command routing, callback queries, start/stop lifecycle

import { run as runBot, type RunnerHandle } from '@grammyjs/runner';
import { getComponent, type NodeData, register } from '@treenx/core';
import type { ServiceCtx, ServiceHandle } from '@treenx/core/contexts/service';
import { Autostart } from '@treenx/core/mods/autostart/service';
import type { ActionCtx } from '@treenx/core/server/actions';
import { Bot } from 'grammy';
import { type BrahmanCtx, executeAction, executePage, findActionComp, formatTString, resolveWait } from './helpers';
import { BotConfig, BrahmanSession, BrahmanUser, PageConfig } from './types';

// ── Bot factory (overridable for tests) ──

let _botFactory: ((token: string) => unknown) | undefined;
export function setBotFactory(f: ((token: string) => unknown) | undefined) { _botFactory = f; }

// ── Bot service registration ──

register('brahman.bot', 'service', async (node: NodeData, svcCtx: ServiceCtx): Promise<ServiceHandle> => {
  const config = getComponent(node, BotConfig);
  if (!config?.token) throw new Error('brahman.bot: token not configured');

  const bot = (_botFactory?.(config.token) ?? new Bot(config.token)) as Bot;
  const botPath = node.$path;
  const botLangs = (config.langs || 'ru,en').split(',').map(s => s.trim());
  const defaultLang = botLangs[0] || 'ru';

  // Ensure dirs exist
  const dirs = ['pages', 'users', 'sessions'];
  for (const d of dirs) {
    const dirPath = `${botPath}/${d}`;
    if (!(await svcCtx.tree.get(dirPath))) {
      await svcCtx.tree.set({ $path: dirPath, $type: 'dir' } as NodeData);
    }
  }

  // ── Global middleware: pending callbacks → maintenance → session → auth ──

  bot.use(async (gCtx, next) => {
    const userId = gCtx.from?.id;
    if (!userId) return;

    // Maintenance check
    if (config.maintenance) {
      await gCtx.reply(config.maintenance);
      return;
    }

    // Load/create session
    const sessionPath = `${botPath}/sessions/${userId}`;
    let sessionNode = await svcCtx.tree.get(sessionPath);
    if (!sessionNode) {
      sessionNode = {
        $path: sessionPath, $type: 'brahman.session',
        tid: userId, data: {}, history: [], callbacks: {},
      } as NodeData;
      await svcCtx.tree.set(sessionNode);
    }

    // Load/create user
    const userPath = `${botPath}/users/${userId}`;
    let userNode = await svcCtx.tree.get(userPath);
    if (!userNode) {
      userNode = {
        $path: userPath, $type: 'brahman.user',
        tid: userId,
        firstName: gCtx.from.first_name ?? '',
        lastName: gCtx.from.last_name ?? '',
        username: gCtx.from.username ?? '',
        lang: gCtx.from.language_code ?? defaultLang,
        isAdmin: false, blocked: false, banned: false, tags: [],
      } as NodeData;
      await svcCtx.tree.set(userNode);
    }

    const userData = getComponent(userNode, BrahmanUser);
    if (userData?.banned) return;

    // Mark as unblocked if previously blocked (user restarted bot)
    if (userData?.blocked) {
      (userData as any).blocked = false;
      await svcCtx.tree.set(userNode);
    }

    const sessionComp = getComponent(sessionNode, BrahmanSession);
    const sessionData = (sessionComp as any)?.data ?? {};
    if (!sessionData.history) sessionData.history = (sessionComp as any)?.history ?? [];

    const bCtx: BrahmanCtx = {
      ctx: gCtx, tree: svcCtx.tree,
      session: sessionData,
      sessionNode,
      user: userNode,
      lang: userData?.lang || defaultLang,
      botPath,
      userTags: userData?.tags ?? [],
      botLangs,
    };

    (gCtx as any)._brahman = bCtx;

    // Resolve pending wait (session-persisted) — consumes message if matched
    if (!(sessionData.wait && await resolveWait(bCtx, gCtx))) {
      await next();
    }

    // Save session after handler
    Object.assign(sessionNode, {
      data: sessionData,
      history: sessionData.history ?? [],
      callbacks: sessionData.callbacks ?? {},
    });
    await svcCtx.tree.set(sessionNode);
  });

  // ── Dynamic page lookup (pages can be added/changed at runtime) ──

  async function getPages() {
    const { items } = await svcCtx.tree.getChildren(`${botPath}/pages`, { depth: 10 });
    return items.filter(n => n.$type === 'brahman.page');
  }

  async function findPageByCommand(cmd: string) {
    const pages = await getPages();
    return pages.find(p => {
      const pc = getComponent(p, PageConfig);
      return pc?.command === `/${cmd}` || pc?.command === cmd;
    });
  }

  async function findStartPage() {
    return findPageByCommand('start');
  }

  // ── Callback queries: page:/path, btn:id, lang:xx ──

  bot.on('callback_query:data', async (gCtx) => {
    const bCtx = (gCtx as any)._brahman as BrahmanCtx;
    if (!bCtx) return;
    const data = gCtx.callbackQuery.data;

    if (data.startsWith('page:')) {
      const pagePath = data.slice(5);
      const colonIdx = pagePath.indexOf(':');
      if (colonIdx >= 0) {
        bCtx.session.param = pagePath.slice(colonIdx + 1);
        await executePage(pagePath.slice(0, colonIdx), bCtx);
      } else {
        await executePage(pagePath, bCtx);
      }
    } else if (data.startsWith('btn:')) {
      const btnId = parseInt(data.slice(4), 10);
      const lastMenuPath = bCtx.session._lastMenu as string | undefined;
      if (lastMenuPath) {
        const menuNode = await svcCtx.tree.get(lastMenuPath);
        const menuComp = menuNode ? findActionComp(menuNode) as any : null;
        if (menuComp?.rows) {
          for (const row of menuComp.rows) {
            for (const btn of row.buttons) {
              if (btn.id === btnId && btn.action) {
                if (btn.action.type === 'brahman.action.page' && btn.action.target) {
                  await executePage(btn.action.target, bCtx);
                } else if (btn.action.target) {
                  const actionNode = await svcCtx.tree.get(btn.action.target);
                  if (actionNode) await executeAction(actionNode, bCtx);
                }
              }
            }
          }
        }
      }
    } else if (data.startsWith('lang:')) {
      const newLang = data.slice(5);
      if (bCtx.botLangs.includes(newLang)) {
        const userData = getComponent(bCtx.user, BrahmanUser);
        if (userData) {
          (userData as any).lang = newLang;
          await svcCtx.tree.set(bCtx.user);
          bCtx.lang = newLang;
        }
        bCtx.session.langSelected = newLang;
        const startPage = await findStartPage();
        if (startPage) await executePage(startPage.$path, bCtx);
      }
    }
    await gCtx.answerCallbackQuery();
  });

  // ── Text message handler: button callback → command fallback ──

  bot.on('message:text', async (gCtx) => {
    const bCtx = (gCtx as any)._brahman as BrahmanCtx;
    if (!bCtx) return;

    const text = gCtx.message.text;
    if (text.startsWith('/')) {
      const cmd = text.slice(1).split(/\s/)[0];
      const page = await findPageByCommand(cmd);
      if (page) {
        const paramMatch = text.match(/^\/\S+\s+(.*)/);
        if (paramMatch) bCtx.session.param = paramMatch[1];
        await executePage(page.$path, bCtx);
        return;
      }
      const startPage = await findStartPage();
      if (startPage) await executePage(startPage.$path, bCtx);
      return;
    }

    // Try button callback from last page in history
    const history = (bCtx.session.history ?? []) as string[];
    if (history.length > 0) {
      const lastPagePath = history[history.length - 1];
      const pageNode = await svcCtx.tree.get(lastPagePath);
      if (pageNode) {
        const { items: children } = await svcCtx.tree.getChildren(lastPagePath + '/_actions');
        for (const child of children) {
          const actionComp = findActionComp(child) as any;
          if (!actionComp) continue;
          if (actionComp.menuType === 'keyboard' && actionComp.rows) {
            for (const row of actionComp.rows) {
              for (const btn of row.buttons) {
                const btnText = formatTString(btn.title, bCtx.lang);
                if (btnText === text && btn.action) {
                  if (btn.action.type === 'brahman.action.page' && btn.action.target) {
                    await executePage(btn.action.target, bCtx);
                    return;
                  } else if (btn.action.target) {
                    const actionNode = await svcCtx.tree.get(btn.action.target);
                    if (actionNode) await executeAction(actionNode, bCtx);
                    return;
                  }
                }
              }
            }
          }
        }
      }
    }

    // Fallback: check _lastMenu for backward compat
    const lastMenuPath = bCtx.session._lastMenu as string | undefined;
    if (lastMenuPath) {
      const menuNode = await svcCtx.tree.get(lastMenuPath);
      const menuComp = menuNode ? findActionComp(menuNode) as any : null;
      if (menuComp?.menuType === 'keyboard' && menuComp.rows) {
        for (const row of menuComp.rows) {
          for (const btn of row.buttons) {
            const btnText = formatTString(btn.title, bCtx.lang);
            if (btnText === text && btn.action) {
              if (btn.action.type === 'brahman.action.page' && btn.action.target) {
                await executePage(btn.action.target, bCtx);
                return;
              }
            }
          }
        }
      }
    }

    // Default fallback: /start page
    const startPage = await findStartPage();
    if (startPage) {
      await executePage(startPage.$path, bCtx);
    }
  });

  bot.catch(err => console.error(`[brahman:${config.alias || botPath}]`, err.message ?? err));

  // Init bot (getMe) and fill node with bot info
  await bot.init();
  const info = bot.botInfo;
  if (info) {
    const updates: Record<string, unknown> = {};
    if (info.username && !config.alias) updates.alias = `@${info.username}`;
    if (info.first_name && !config.name) updates.name = info.first_name;
    if (Object.keys(updates).length > 0) {
      const fresh = await svcCtx.tree.get(botPath);
      if (fresh) await svcCtx.tree.set({ ...fresh, ...updates });
    }
  }

  let runner: RunnerHandle | null = null;
  const isRealBot = bot instanceof Bot;

  function startRunner() {
    if (isRealBot) runner = runBot(bot);
    else (bot as any).start?.();
  }

  function stopRunner() {
    if (runner) { runner.stop(); runner = null; }
    else (bot as any).stop?.();
  }

  if (config.running !== false) {
    startRunner();
  }

  // React to start/stop actions toggling the running flag
  let running = config.running !== false;
  const unsub = svcCtx.subscribe(botPath, async () => {
    const fresh = await svcCtx.tree.get(botPath);
    if (!fresh) return;
    const cfg = getComponent(fresh, BotConfig);
    const shouldRun = cfg?.running !== false;

    if (shouldRun && !running) {
      startRunner();
      running = true;
    } else if (!shouldRun && running) {
      stopRunner();
      running = false;
    }
  });

  return {
    stop: async () => {
      unsub();
      stopRunner();
    },
  };
});

// ── Start/stop actions — delegate to autostart service manager ──

/** @description Start the Telegram bot polling loop via autostart service */
register('brahman.bot', 'action:start', async (ctx: ActionCtx) => {
  await ctx.nc('/sys/autostart').get(Autostart).start({ path: ctx.node.$path });
  // Set running flag — service subscription reacts and calls bot.start()
  const fresh = await ctx.tree.get(ctx.node.$path);
  if (fresh) await ctx.tree.set({ ...fresh, running: true });
});

/** @description Stop the Telegram bot polling loop via autostart service */
register('brahman.bot', 'action:stop', async (ctx: ActionCtx) => {
  await ctx.nc('/sys/autostart').get(Autostart).stop({ path: ctx.node.$path });
  const fresh = await ctx.tree.get(ctx.node.$path);
  if (fresh) await ctx.tree.set({ ...fresh, running: false });
});
