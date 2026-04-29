// Treenix Telegram Binding — Layer 2
// Connects Grammy bot to Treenix tree.
// Supports middleware pipelines, event routing, callback params.

import { type ComponentData, isComponent, type NodeData, resolve } from '#core';
import { basename } from '#core/path';
import { type Tree } from '#tree';
import { Bot, type Context } from 'grammy';

// ── Types ──

export type TgCtx = {
  ctx: Context;
  tree: Tree;
  node: NodeData;
  params: string;
  [key: string]: unknown;
};

export type TgHandler = (node: NodeData, tgCtx: TgCtx) => Promise<void>;
export type TgMiddleware = (tgCtx: TgCtx, next: () => Promise<void>) => Promise<void>;

declare module '#core/context' {
  interface ContextHandlers {
    telegram: TgHandler;
  }
}

type OnComponent = ComponentData & { filter: string };

// ── Middleware runner ──

function runHandler(middlewares: TgMiddleware[], tgCtx: TgCtx, handler: TgHandler): Promise<void> {
  let i = 0;
  const next = (): Promise<void> => {
    if (i < middlewares.length) return middlewares[i++](tgCtx, next);
    return handler(tgCtx.node, tgCtx);
  };
  return next();
}

// ── Start bot from tree ──

export async function startBot(tree: Tree, botPath: string, middlewares: TgMiddleware[] = []) {
  const botNode = await tree.get(botPath);
  if (!botNode) throw new Error(`Bot node not found: ${botPath}`);

  const cfgVal = botNode['config'];
  if (!isComponent(cfgVal)) throw new Error(`Bot node missing config component`);
  const config = cfgVal as ComponentData & { token: string };

  const bot = new Bot(config.token);
  const commandsPath = botPath + '/commands';
  const onPath = botPath + '/on';

  // event handlers from /bot/on/ children
  const { items: eventNodes } = await tree.getChildren(onPath);
  for (const eventNode of eventNodes) {
    const onVal = eventNode['on'];
    if (!isComponent(onVal)) throw new Error(`Event node ${eventNode.$path} missing "on" component`);
    const on = onVal as OnComponent;
    bot.on(on.filter as Parameters<typeof bot.on>[0], async (ctx) => {
      const handler = resolve(eventNode.$type, 'telegram');
      if (!handler) throw new Error(`No handler for event type "${eventNode.$type}"`);
      const tgCtx: TgCtx = { ctx, tree, node: eventNode, params: '' };
      await runHandler(middlewares, tgCtx, handler);
    });
  }

  // commands from /bot/commands/ children
  const { items: commandNodes } = await tree.getChildren(commandsPath);
  for (const cmdNode of commandNodes) {
    const cmd = basename(cmdNode.$path);
    bot.command(cmd, async (ctx) => {
      const handler = resolve(cmdNode.$type, 'telegram');
      if (!handler) throw new Error(`No handler for command "${cmd}"`);
      const tgCtx: TgCtx = { ctx, tree, node: cmdNode, params: '' };
      await runHandler(middlewares, tgCtx, handler);
    });
  }

  // callback queries: "action" or "action:param1:param2"
  bot.on('callback_query:data', async (ctx) => {
    const raw = ctx.callbackQuery.data;
    const sep = raw.indexOf(':');
    const action = sep === -1 ? raw : raw.slice(0, sep);
    const params = sep === -1 ? '' : raw.slice(sep + 1);

    const targetNode = await tree.get(`${commandsPath}/${action}`);
    if (!targetNode) return ctx.answerCallbackQuery('Unknown action');
    const handler = resolve(targetNode.$type, 'telegram');
    if (!handler) return ctx.answerCallbackQuery('No handler');
    const tgCtx: TgCtx = { ctx, tree, node: targetNode, params };
    await runHandler(middlewares, tgCtx, handler);
    await ctx.answerCallbackQuery();
  });

  bot.catch((err) => console.error('[bot]', err.message ?? err));

  // text fallback
  bot.on('message:text', async (ctx) => {
    const startNode = await tree.get(`${commandsPath}/start`);
    if (startNode) {
      const handler = resolve(startNode.$type, 'telegram');
      if (handler) {
        const tgCtx: TgCtx = { ctx, tree, node: startNode, params: '' };
        await runHandler(middlewares, tgCtx, handler);
      }
    } else {
      await ctx.reply('Try /start');
    }
  });

  return bot;
}
