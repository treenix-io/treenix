// Brahman helpers — template engine, formatting, keyboards, execution runtime
// Shared between action handlers and bot service

import { getComp } from '@treenity/core/comp';
import { type NodeData, resolve as resolveCtx } from '@treenity/core/core';
import type { Tree } from '@treenity/core/tree';
import { type Context, InlineKeyboard, Keyboard } from 'grammy';
import { BrahmanUser, type MenuRow, type MenuType, PageConfig, type TString, type WaitState } from './types';

// ── TString formatting ──

export function formatTString(ts: TString | undefined, lang: string): string {
  if (!ts) return '';
  return ts[lang] || ts.ru || ts.en || Object.values(ts).find(v => v) || '';
}

// ── Template engine (Handlebars-compatible) ──
// Supports: {field}, {data.nested}, {{#ifEquals a b}}...{{else}}...{{/ifEquals}},
// {{#tag name}}...{{else}}...{{/tag}}, {{shortDate d}}, {{toFixed n f}},
// {{switch v c1 v1 c2 v2}}, {{#and v1 v2}}...{{else}}...{{/and}}, {{eval expr}}

export function resolveVar(path: string, data: Record<string, unknown>): unknown {
  let val: unknown = data;
  for (const key of path.split('.')) {
    if (val == null || typeof val !== 'object') return undefined;
    val = (val as Record<string, unknown>)[key];
  }
  return val;
}

export function renderTemplate(template: string, data: Record<string, unknown>): string {
  let result = template;

  // Block helpers: {{#helper args}}...{{else}}...{{/helper}}
  result = result.replace(
    /\{\{#ifEquals\s+(\S+)\s+['"]?([^'"}\s]+)['"]?\}\}([\s\S]*?)\{\{\/ifEquals\}\}/g,
    (_, varPath, compareVal, body) => {
      const val = String(resolveVar(varPath, data) ?? '');
      const [truePart, falsePart = ''] = body.split('{{else}}');
      return val === compareVal ? truePart : falsePart;
    },
  );

  result = result.replace(
    /\{\{#tag\s+(\S+)\}\}([\s\S]*?)\{\{\/tag\}\}/g,
    (_, tagName, body) => {
      const tags = (data.userTags ?? data.tags ?? []) as string[];
      const [truePart, falsePart = ''] = body.split('{{else}}');
      return tags.includes(tagName) ? truePart : falsePart;
    },
  );

  result = result.replace(
    /\{\{#and\s+([\s\S]*?)\}\}([\s\S]*?)\{\{\/and\}\}/g,
    (_, varsStr, body) => {
      const vars = varsStr.trim().split(/\s+/);
      const allTrue = vars.every((v: string) => !!resolveVar(v, data));
      const [truePart, falsePart = ''] = body.split('{{else}}');
      return allTrue ? truePart : falsePart;
    },
  );

  // Inline helpers: {{helperName args}}
  result = result.replace(/\{\{shortDate\s+(\S+)\}\}/g, (_, varPath) => {
    const val = resolveVar(varPath, data);
    if (!val) return '';
    const d = new Date(val as string | number);
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yy = String(d.getFullYear()).slice(-2);
    return `${dd}.${mm}.${yy}`;
  });

  result = result.replace(/\{\{toFixed\s+(\S+)\s+(\d+)\}\}/g, (_, varPath, fraction) => {
    const val = resolveVar(varPath, data);
    return val != null ? Number(val).toFixed(Number(fraction)) : '';
  });

  result = result.replace(/\{\{is\s+(\S+)\}\}/g, (_, varPath) => {
    return resolveVar(varPath, data) ? 'true' : '';
  });

  result = result.replace(/\{\{switch\s+([\s\S]*?)\}\}/g, (_, argsStr) => {
    const args = argsStr.trim().split(/\s+/);
    const val = String(resolveVar(args[0], data) ?? '');
    for (let i = 1; i < args.length - 1; i += 2) {
      if (args[i] === val) return args[i + 1] ?? '';
    }
    return '';
  });

  result = result.replace(/\{\{eval\s+([\s\S]*?)\}\}/g, (_, expr) => {
    try {
      const fn = new Function('data', 'session', 'user', `return (${expr})`);
      return String(fn(data, data, data.user) ?? '');
    } catch { return ''; }
  });

  // Simple variable interpolation: {field} and {data.nested} and {{field}}
  result = result.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_, path: string) => {
    const val = resolveVar(path, data);
    return val != null ? String(val) : '';
  });

  result = result.replace(/\{(\w+(?:\.\w+)*)\}/g, (_, path: string) => {
    const val = resolveVar(path, data);
    return val != null ? String(val) : '';
  });

  return result;
}

// ── Tag checking (from old brahman) ──
// Tags with ! prefix = exclude, without = include (at least one match)

export function checkTags(userTags: string[], buttonTags: string[]): boolean {
  if (!buttonTags.length) return true;

  const includes = buttonTags.filter(t => !t.startsWith('!'));
  const excludes = buttonTags.filter(t => t.startsWith('!')).map(t => t.slice(1));

  if (excludes.some(t => userTags.includes(t))) return false;
  if (includes.length === 0) return true;
  return includes.some(t => userTags.includes(t));
}

// ── Keyboard building ──

export function buildReplyMarkup(rows: MenuRow[], type: MenuType, lang: string, userTags: string[] = []) {
  if (type === 'none') return undefined;
  if (type === 'remove') return { reply_markup: { remove_keyboard: true as const } };
  if (type === 'force_reply') return { reply_markup: { force_reply: true as const } };

  if (type === 'keyboard') {
    const kb = new Keyboard();
    for (const row of rows) {
      for (const btn of row.buttons) {
        if (!checkTags(userTags, btn.tags ?? [])) continue;
        const text = formatTString(btn.title, lang);
        if (!text) continue; // Telegram rejects empty button text
        kb.text(text);
      }
      kb.row();
    }
    return { reply_markup: kb.resized() };
  }

  // Inline keyboards (inline, inline_new, inline_close)
  const kb = new InlineKeyboard();
  for (const row of rows) {
    for (const btn of row.buttons) {
      if (!checkTags(userTags, btn.tags ?? [])) continue;
      const text = formatTString(btn.title, lang);
      if (!text) continue; // Telegram rejects empty button text
      if (btn.url) {
        kb.url(text, btn.url);
      } else {
        const cbData = btn.action?.type === 'brahman.action.page'
          ? `page:${btn.action.target ?? ''}`
          : `btn:${btn.id}`;
        kb.text(text, cbData);
      }
    }
    kb.row();
  }
  return { reply_markup: kb };
}

// ── Brahman execution context ──

export type BrahmanCtx = {
  ctx: Context;
  store: Tree;
  session: Record<string, unknown>;
  sessionNode: NodeData;
  user: NodeData;
  lang: string;
  botPath: string;
  userTags: string[];
  botLangs: string[];
  /** Last error for on-error actions */
  error?: Error;
};

// ── Find action component on a node ──

export function findActionComp(node: NodeData): Record<string, unknown> | undefined {
  // Node itself is the action (same logic as getComp: node.$type match → return node)
  if (node.$type?.startsWith('brahman.action.')) return node;
  // Fallback: scan nested components
  for (const [k, v] of Object.entries(node)) {
    if (k.startsWith('$')) continue;
    if (typeof v === 'object' && v && '$type' in v
      && typeof (v as any).$type === 'string'
      && (v as any).$type.startsWith('brahman.action.')) {
      return v as Record<string, unknown>;
    }
  }
}

// ── StopProcess sentinel (for if-else stopAfterAction) ──

export class StopProcess extends Error { constructor() { super('StopProcess'); } }

// ── Build template context from BrahmanCtx ──

export function buildTemplateData(bCtx: BrahmanCtx): Record<string, unknown> {
  const userData = getComp(bCtx.user, BrahmanUser);
  return {
    ...bCtx.session,
    user: userData ?? {},
    userTags: bCtx.userTags,
    tags: bCtx.userTags,
    lang: bCtx.lang,
    ctx: {
      user: userData,
      session: bCtx.session,
    },
  };
}

// ── Format template with BrahmanCtx ──

export function format(template: string, bCtx: BrahmanCtx): string {
  return renderTemplate(template, buildTemplateData(bCtx));
}

// ── Format TString + template ──

export function formatText(ts: TString | undefined, bCtx: BrahmanCtx): string {
  const raw = formatTString(ts, bCtx.lang);
  return format(raw, bCtx);
}

// ── Language flags ──

export const LANG_FLAGS: Record<string, string> = {
  ru: '\u{1F1F7}\u{1F1FA}', en: '\u{1F1EC}\u{1F1E7}', de: '\u{1F1E9}\u{1F1EA}',
  uz: '\u{1F1FA}\u{1F1FF}', fr: '\u{1F1EB}\u{1F1F7}', es: '\u{1F1EA}\u{1F1F8}',
  it: '\u{1F1EE}\u{1F1F9}', pt: '\u{1F1F5}\u{1F1F9}', tr: '\u{1F1F9}\u{1F1F7}',
};

// ── Language keyboard builder ──

export function buildLangKeyboard(langs: string[]) {
  const kb = new InlineKeyboard();
  for (const l of langs) {
    const flag = LANG_FLAGS[l] || l.toUpperCase();
    kb.text(`${flag} ${l}`, `lang:${l}`);
  }
  return kb;
}

// ── Page execution ──

export async function executePage(pagePath: string, bCtx: BrahmanCtx): Promise<void> {
  const pageNode = await bCtx.store.get(pagePath);
  if (!pageNode) return;

  const pageComp = getComp(pageNode, PageConfig);
  if (!pageComp) return;

  // Push to history
  const history = (bCtx.session.history ?? []) as string[];
  history.push(pagePath);

  const { items } = await bCtx.store.getChildren(pagePath + '/_actions');
  const positions = pageComp.positions ?? [];
  const tracked = new Set(positions);
  const sorted = [
    ...positions.map(p => items.find(n => n.$path === p)).filter((n): n is NodeData => !!n),
    ...items.filter(n => !tracked.has(n.$path) && n.$type?.startsWith('brahman.action.')),
  ];

  try {
    await executeActions(sorted, bCtx);
  } catch (e) {
    if (e instanceof StopProcess) return;

    // Error routing — run 'error' command page if exists
    const errorMsg = e instanceof Error ? e.message : String(e);
    console.error(`[brahman:${bCtx.botPath}] action error:`, errorMsg);

    // 403 = user blocked the bot
    if (errorMsg.includes('403') || errorMsg.includes('Forbidden')) {
      const userData = getComp(bCtx.user, BrahmanUser);
      if (userData) {
        (userData as any).blocked = true;
        await bCtx.store.set(bCtx.user);
      }
      return;
    }

    // Tree error in session and route to error page
    bCtx.error = e instanceof Error ? e : new Error(String(e));
    bCtx.session.error = { message: errorMsg };

    try {
      const { items: pages } = await bCtx.store.getChildren(`${bCtx.botPath}/pages`);
      const errorPage = pages.find(p => getComp(p, PageConfig)?.command === '/error');
      if (errorPage) await executePage(errorPage.$path, bCtx);
    } catch (innerErr) {
      console.error(`[brahman:${bCtx.botPath}] error page failed:`, innerErr);
    }
  }
}

// ── Action dispatcher ──
// Calls action:run (auto-registered by registerType from run() methods on action classes)

const _neverAbort = new AbortController().signal;

export async function executeAction(node: NodeData, bCtx: BrahmanCtx): Promise<void> {
  const handler = resolveCtx(node.$type, 'action:run');
  if (!handler) return;
  await (handler as any)({ node, store: bCtx.store, signal: _neverAbort }, bCtx);
}

// ── Sequential action runner with wait support ──
// Stops if an action sets session.wait (question asked), stores remaining paths

export async function executeActions(actions: NodeData[], bCtx: BrahmanCtx): Promise<void> {
  for (let i = 0; i < actions.length; i++) {
    await executeAction(actions[i], bCtx);
    if (bCtx.session.wait) {
      (bCtx.session.wait as WaitState).remaining = actions.slice(i + 1).map(n => n.$path);
      return;
    }
  }
}

// ── Resolve persisted wait state from session ──
// Called by middleware when a message arrives and session.wait is set

export async function resolveWait(bCtx: BrahmanCtx, gCtx: Context): Promise<boolean> {
  const wait = bCtx.session.wait as WaitState | undefined;
  if (!wait) return false;

  const msgType = gCtx.message?.text ? 'text' : (gCtx.message as any)?.photo ? 'photo' : null;
  if (!msgType || msgType !== wait.type) return false;

  // Save answer to session
  if (wait.saveTo) {
    if (wait.type === 'text') {
      bCtx.session[wait.saveTo] = gCtx.message?.text ?? '';
    } else {
      const photos = (gCtx.message as any)?.photo;
      bCtx.session[wait.saveTo] = photos?.[photos.length - 1]?.file_id ?? '';
    }
  }

  // Delete messages if configured
  if (wait.deleteMessages) {
    const chatId = gCtx.chat?.id;
    if (chatId) {
      try {
        if (wait.sentMsgId) await gCtx.api.deleteMessage(chatId, wait.sentMsgId);
        if (gCtx.message?.message_id) await gCtx.api.deleteMessage(chatId, gCtx.message.message_id);
      } catch { /* deletion may fail if msg too old */ }
    }
  }

  // Grab remaining action paths before clearing wait
  const remaining = wait.remaining ?? [];
  delete bCtx.session.wait;

  // Execute remaining actions (may set a new wait if another question is encountered)
  if (remaining.length) {
    const nodes = (await Promise.all(remaining.map(p => bCtx.store.get(p)))).filter(Boolean) as NodeData[];
    await executeActions(nodes, bCtx);
  }

  return true;
}
