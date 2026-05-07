// Brahman — Telegram bot constructor
// Component types for bot config, pages, actions, users, sessions

import { getComponent } from '@treenx/core';
import { getCtx, registerType } from '@treenx/core/comp';
import { OpError } from '@treenx/core/errors';
import type { BrahmanCtx } from './helpers';
import { evalBool, evalExpr } from './sandbox';

// ── Shared types ──

export type TString = Record<string, string>;

/** Pending wait state — persisted in session.data.wait */
export type WaitState = {
  type: 'text' | 'photo';
  saveTo: string;
  deleteMessages: boolean;
  sentMsgId: number;
  remaining: string[];
};

export type MenuType =
  | 'none'
  | 'inline'
  | 'inline_new'
  | 'inline_close'
  | 'keyboard'
  | 'remove'
  | 'force_reply';

export const MENU_TYPES: { value: MenuType; label: string }[] = [
  { value: 'none', label: 'No menu' },
  { value: 'inline', label: 'Inline' },
  { value: 'inline_new', label: 'Inline (new message)' },
  { value: 'inline_close', label: 'Inline (edit existing)' },
  { value: 'keyboard', label: 'Reply keyboard' },
  { value: 'remove', label: 'Remove keyboard' },
  { value: 'force_reply', label: 'Force reply' },
];

export type ButtonAction = {
  type: string;
  target?: string;
  [key: string]: unknown;
};

export type MenuButton = {
  id: number;
  title: TString;
  url?: string;
  tags?: string[];
  action?: ButtonAction;
};

export type MenuRow = {
  buttons: MenuButton[];
};

// Action type metadata for the palette
export const ACTION_TYPES = [
  { type: 'brahman.action.message', label: 'Message', icon: 'MessageSquare' },
  { type: 'brahman.action.question', label: 'Question', icon: 'HelpCircle' },
  { type: 'brahman.action.ifelse', label: 'If / Else', icon: 'GitBranch' },
  { type: 'brahman.action.page', label: 'Go to page', icon: 'FileText' },
  { type: 'brahman.action.back', label: 'Back', icon: 'ArrowLeft' },
  { type: 'brahman.action.tag', label: 'Set tag', icon: 'Tag' },
  { type: 'brahman.action.broadcast', label: 'Broadcast', icon: 'Send' },
  { type: 'brahman.action.getvalue', label: 'Get value', icon: 'Download' },
  { type: 'brahman.action.setvalue', label: 'Set value', icon: 'Upload' },
  { type: 'brahman.action.params', label: 'Parse params', icon: 'Settings2' },
  { type: 'brahman.action.file', label: 'Send file', icon: 'File' },
  { type: 'brahman.action.eval', label: 'Eval JS', icon: 'Code' },
  { type: 'brahman.action.remove', label: 'Remove msg', icon: 'Trash2' },
  { type: 'brahman.action.emittext', label: 'Emit text', icon: 'Repeat' },
  { type: 'brahman.action.forward', label: 'Forward', icon: 'Forward' },
  { type: 'brahman.action.resetsession', label: 'Reset session', icon: 'RotateCcw' },
  { type: 'brahman.action.resethistory', label: 'Reset history', icon: 'History' },
  { type: 'brahman.action.onerror', label: 'On error', icon: 'AlertTriangle' },
  { type: 'brahman.action.keywordselect', label: 'Keyword select', icon: 'Search' },
  { type: 'brahman.action.selectlang', label: 'Select language', icon: 'Globe' },
  { type: 'brahman.action.call', label: 'Call action', icon: 'Zap' },
] as const;

// ── Bot ──

/** Telegram bot instance — token, proxy, language, maintenance */
export class BotConfig {
  /** @title Token @description Telegram bot token */
  token = '';
  /** @title Proxy @description SOCKS proxy URL */
  proxy = '';
  /** @title Alias @description Bot username */
  alias = '';
  /** @title Name @description Display name */
  name = '';
  /** @title Langs @description Comma-separated: ru,en,de,uz */
  langs = 'ru,en';
  /** @title Maintenance @description Non-empty = paused */
  maintenance = '';
  /** @title Running */
  running = true;
}
registerType('brahman.bot', BotConfig);

// ── Page ──

/** Bot conversation page — command trigger and ordered action sequence */
export class PageConfig {
  /** @title Command @description Telegram command, e.g. /start */
  command = '';
  /** @description Ordered child action paths */
  positions: string[] = [];
}
registerType('brahman.page', PageConfig);

// ── Actions ──

/** Send message — text with optional menu and link previews */
export class MessageAction {
  /** @title Text @format tstring */
  text: TString = {};
  /** @title Disable link previews */
  disableLinks = false;
  /** @title Menu type */
  menuType: MenuType = 'none';
  /** @title Menu rows */
  rows: MenuRow[] = [];
  /** @title Send to chat ID @description Leave empty for current chat */
  chatId = '';
  /** @title Reply to message ID @description Session field with message ID */
  replyToMsgId = '';

  async run(bCtx: BrahmanCtx) {
    const { node } = getCtx();
    const { formatText, buildReplyMarkup, format } = await import('./helpers');
    const { ctx, lang } = bCtx;
    const session = bCtx.session;

    const text = formatText(this.text, bCtx);
    const opts: Record<string, unknown> = { parse_mode: 'HTML' };
    if (this.disableLinks) opts.link_preview_options = { is_disabled: true };

    const markup = buildReplyMarkup(this.rows ?? [], this.menuType ?? 'none', lang, bCtx.userTags);
    if (markup) Object.assign(opts, markup);

    if (this.replyToMsgId && session[this.replyToMsgId]) {
      opts.reply_to_message_id = Number(session[this.replyToMsgId]);
    }

    if (this.chatId) {
      const targetChat = format(this.chatId, bCtx);
      await ctx.api.sendMessage(targetChat, text, opts as any);
    } else if (this.menuType === 'inline_close' && ctx.callbackQuery) {
      await ctx.editMessageText(text, opts as any);
    } else {
      const sent = await ctx.reply(text, opts as any);
      session._lastMsgId = sent.message_id;
    }

    if (this.menuType === 'keyboard' || this.menuType === 'inline' || this.menuType === 'inline_new') {
      session._lastMenu = node.$path;
    }
  }
}
registerType('brahman.action.message', MessageAction);

/** Ask question — prompt for text/photo input, save answer */
export class QuestionAction {
  /** @title Prompt text @format tstring */
  text: TString = {};
  /** @title Input type */
  inputType: 'text' | 'photo' = 'text';
  /** @title Save answer to */
  saveTo = '';
  /** @title Delete messages @description Delete question and answer after receiving */
  deleteMessages = false;

  async run(bCtx: BrahmanCtx) {
    const { formatText } = await import('./helpers');
    const { ctx } = bCtx;
    const session = bCtx.session;

    const text = formatText(this.text, bCtx);
    const sent = await ctx.reply(text, { reply_markup: { force_reply: true }, parse_mode: 'HTML' });

    if (this.saveTo) {
      // Tree wait state in session — persisted, survives restarts
      // remaining[] filled by executeActions() after this action returns
      session.wait = {
        type: this.inputType === 'photo' ? 'photo' : 'text',
        saveTo: this.saveTo,
        deleteMessages: this.deleteMessages,
        sentMsgId: sent.message_id,
        remaining: [],
      } satisfies WaitState;
    }
  }
}
registerType('brahman.action.question', QuestionAction);

/** Conditional branch — evaluate JS expression, run if/else action */
export class IfElseAction {
  /** @title Condition @format textarea @description JS expression evaluated at runtime */
  condition = '';
  /** @title Action if true @description Path to action node */
  actionIf = '';
  /** @title Action if false */
  actionElse = '';
  /** @title Stop after action */
  stopAfterAction = false;

  async run(bCtx: BrahmanCtx) {
    const { format, executeAction, StopProcess } = await import('./helpers');
    const { tree } = bCtx;
    const session = bCtx.session;

    // R5-BRAHMAN-1: QuickJS sandbox — no host globals, bounded memory + time.
    // `format(condition)` interpolates session vars BEFORE eval; sandbox prevents
    // a crafted user message that lands in `session.x` from gaining host JS execution.
    const condition = format(this.condition, bCtx);
    const userData = getComponent(bCtx.user, BrahmanUser);
    const result = await evalBool(condition, { session, data: session, user: userData });

    const target = result ? this.actionIf : this.actionElse;
    if (target) {
      const targetNode = await tree.get(target);
      if (targetNode) await executeAction(targetNode, bCtx);
    }

    if (this.stopAfterAction) throw new StopProcess();
  }
}
registerType('brahman.action.ifelse', IfElseAction);

/** Navigate to page — redirect conversation flow */
export class PageNavAction {
  /** @title Target page @description Path to page node */
  targetPage = '';

  async run(bCtx: BrahmanCtx) {
    if (this.targetPage) {
      const { format, executePage } = await import('./helpers');
      const resolved = format(this.targetPage, bCtx);
      await executePage(resolved, bCtx);
    }
  }
}
registerType('brahman.action.page', PageNavAction);

/** Go back — return to previous page in history */
export class BackAction {
  async run(bCtx: BrahmanCtx) {
    const { executePage } = await import('./helpers');
    const history = (bCtx.session.history ?? []) as string[];
    history.pop(); // remove current
    const prev = history.pop();
    if (prev) await executePage(prev, bCtx);
  }
}
registerType('brahman.action.back', BackAction);

/** Set user tag — assign key-value metadata to user */
export class TagAction {
  /** @title Tag name */
  tag = '';
  /** @title Value expression */
  value = 'true';

  async run(bCtx: BrahmanCtx) {
    const { format } = await import('./helpers');
    const { tree } = bCtx;
    const session = bCtx.session;

    if (!this.tag) return;
    let shouldSet = true;
    if (this.value && this.value !== 'true') {
      // R5-BRAHMAN-1: QuickJS sandbox.
      const formatted = format(this.value, bCtx);
      shouldSet = await evalBool(formatted, { session, data: session });
    }

    for (let attempt = 0; attempt < 3; attempt++) {
      const userNode = attempt === 0 ? bCtx.user : await tree.get(bCtx.user.$path);
      if (!userNode) return;

      const userComp = getComponent(userNode, BrahmanUser);
      if (!userComp) return;

      const tags = [...(userComp.tags ?? [])];
      if (shouldSet && !tags.includes(this.tag)) {
        tags.push(this.tag);
      } else if (!shouldSet) {
        const idx = tags.indexOf(this.tag);
        if (idx >= 0) tags.splice(idx, 1);
      }

      (userComp as any).tags = tags;
      try {
        await tree.set(userNode);
        bCtx.user = userNode;
        bCtx.userTags = tags;
        return;
      } catch (err) {
        if (err instanceof OpError && err.code === 'CONFLICT' && attempt < 2) continue;
        throw err;
      }
    }
  }
}
registerType('brahman.action.tag', TagAction);

/** Broadcast message — send action to users matching tag filter */
export class BroadcastAction {
  /** @title User tags filter @format tags */
  userTags: string[] = [];
  /** @title Action to broadcast @description Path to action node */
  action = '';

  async run(bCtx: BrahmanCtx) {
    const { checkTags, executeAction } = await import('./helpers');
    const { tree, lang } = bCtx;

    if (!this.action) return;
    const actionNode = await tree.get(this.action);
    if (!actionNode) return;

    const { items: users } = await tree.getChildren(`${bCtx.botPath}/users`);
    const filterTags = this.userTags ?? [];

    for (const userNode of users) {
      const userData = getComponent(userNode, BrahmanUser);
      if (!userData || userData.banned || userData.blocked) continue;
      if (filterTags.length > 0 && !checkTags(userData.tags ?? [], filterTags)) continue;

      try {
        const userCtx = { ...bCtx, user: userNode, lang: userData.lang || lang, userTags: userData.tags ?? [] };
        await executeAction(actionNode, userCtx);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('403') || msg.includes('Forbidden')) {
          (userData as any).blocked = true;
          await tree.set(userNode);
        }
      }
    }
  }
}
registerType('brahman.action.broadcast', BroadcastAction);

/** Read session value — extract data from user session */
export class GetValueAction {
  /** @title Source path @description Dot-path in session data */
  path = '';
  /** @title Save to */
  saveTo = '';

  async run(bCtx: BrahmanCtx) {
    const { format, buildTemplateData, resolveVar } = await import('./helpers');
    const session = bCtx.session;

    if (this.path && this.saveTo) {
      const path = format(String(this.path), bCtx);
      const templateData = buildTemplateData(bCtx);
      const val = resolveVar(path, { ...templateData, session });
      session[this.saveTo] = val;
    }
  }
}
registerType('brahman.action.getvalue', GetValueAction);

/** Write session value — tree data in user session */
export class SetValueAction {
  /** @title Value expression */
  value = '';
  /** @title Save to */
  saveTo = '';

  async run(bCtx: BrahmanCtx) {
    const { format } = await import('./helpers');
    const session = bCtx.session;

    if (this.saveTo) {
      // R5-BRAHMAN-1: QuickJS sandbox.
      try {
        const formatted = format(this.value, bCtx);
        const userData = getComponent(bCtx.user, BrahmanUser);
        session[this.saveTo] = await evalExpr(formatted, { session, data: session, user: userData });
      } catch {
        session[this.saveTo] = this.value;
      }
    }
  }
}
registerType('brahman.action.setvalue', SetValueAction);

/** Parse parameters — split and name input parts */
export class ParamsAction {
  /** @title Base64 decode */
  base64 = false;
  /** @title Split delimiter */
  split = ',';
  /** @title Parameter names @format tags */
  names: string[] = [];

  async run(bCtx: BrahmanCtx) {
    const { ctx } = bCtx;
    const session = bCtx.session;

    const text = ctx.message?.text ?? '';
    const match = text.match(/^\/\S+\s+(.*)/);
    const rawParam = match ? match[1] : (session.param as string ?? '');

    if (rawParam) {
      let raw = rawParam;
      if (this.base64) {
        try { raw = Buffer.from(raw, 'base64').toString('utf8'); } catch { /* ignore */ }
      }
      const parts = raw.split(this.split || ',');
      const names = this.names ?? [];
      for (let i = 0; i < names.length; i++) {
        session[names[i]] = parts[i]?.trim() ?? '';
      }
      session.params = parts.map((s: string) => s.trim());
    }
  }
}
registerType('brahman.action.params', ParamsAction);

/** Send file — deliver photo/document/video/audio to chat */
export class FileAction {
  /** @title File node path */
  fileId = '';
  /** @title Override type @description photo, document, video, audio, voice */
  asType = '';

  async run(bCtx: BrahmanCtx) {
    const { format } = await import('./helpers');
    const { ctx, tree } = bCtx;

    if (!this.fileId) return;
    const resolvedId = format(this.fileId, bCtx);
    const fileNode = await tree.get(resolvedId);
    const fileId = (fileNode as any)?.fileId ?? resolvedId;
    const asType = this.asType || 'document';

    switch (asType) {
      case 'photo': await ctx.replyWithPhoto(fileId); break;
      case 'video': await ctx.replyWithVideo(fileId); break;
      case 'audio': await ctx.replyWithAudio(fileId); break;
      case 'voice': await ctx.replyWithVoice(fileId); break;
      default: await ctx.replyWithDocument(fileId); break;
    }
  }
}
registerType('brahman.action.file', FileAction);

// ── Eval ──

/** Execute JavaScript — run async code with context access */
export class EvalAction {
  /** @title JavaScript code @format textarea @description Async function body, receives ctx object */
  value = '';

  async run(bCtx: BrahmanCtx) {
    const { ctx, tree } = bCtx;
    const session = bCtx.session;

    if (!this.value) return;
    try {
      const fn = new Function('ctx', 'session', 'data', 'user', 'tree',
        `return (async function() { ${this.value} }).call(null)`);
      const userData = getComponent(bCtx.user, BrahmanUser);
      await fn(ctx, session, session, userData, tree);
    } catch (err) {
      console.error(`[brahman:eval]`, err);
      throw err;
    }
  }
}
registerType('brahman.action.eval', EvalAction);

// ── Remove message ──

/** Remove message — delete bot message from chat */
export class RemoveAction {
  async run(bCtx: BrahmanCtx) {
    try {
      await bCtx.ctx.deleteMessage();
    } catch { /* msg may already be deleted or too old */ }
  }
}
registerType('brahman.action.remove', RemoveAction);

// ── Emit text (synthetic text injection) ──

/** Emit synthetic text — inject text for re-processing */
export class EmitTextAction {
  /** @title Text template @format textarea @description Template for text to re-process */
  from = '';

  async run(bCtx: BrahmanCtx) {
    const { format, executePage } = await import('./helpers');
    const { tree } = bCtx;
    const session = bCtx.session;

    if (!this.from) return;
    const text = format(this.from, bCtx);
    if (!text) return;

    if (text.startsWith('/')) {
      const cmd = text.slice(1).split(/\s/)[0];
      const { items: pages } = await tree.getChildren(`${bCtx.botPath}/pages`);
      const page = pages.find(p => {
        const pc = getComponent(p, PageConfig);
        return pc?.command === `/${cmd}` || pc?.command === cmd;
      });
      if (page) {
        const paramMatch = text.match(/^\/\S+\s+(.*)/);
        if (paramMatch) session.param = paramMatch[1];
        await executePage(page.$path, bCtx);
      }
    } else {
      session._emittedText = text;
    }
  }
}
registerType('brahman.action.emittext', EmitTextAction);

// ── Forward message ──

/** Forward message — relay message to another chat */
export class ForwardAction {
  /** @title Message ID from @description Session field with msg id. Empty = current msg */
  msgIdFrom = '';
  /** @title Forward to @description Chat/user ID template */
  toFrom = '';

  async run(bCtx: BrahmanCtx) {
    const { format } = await import('./helpers');
    const { ctx } = bCtx;
    const session = bCtx.session;

    const toStr = format(this.toFrom || '', bCtx);
    const to = toStr ? Number(toStr) : ctx.chat?.id;
    if (!to) return;

    if (this.msgIdFrom) {
      const msgId = Number(session[this.msgIdFrom] ?? this.msgIdFrom);
      if (msgId && ctx.chat?.id) {
        await ctx.api.forwardMessage(to, ctx.chat.id, msgId);
      }
    } else if (ctx.message?.message_id && ctx.chat?.id) {
      await ctx.api.forwardMessage(to, ctx.chat.id, ctx.message.message_id);
    }
  }
}
registerType('brahman.action.forward', ForwardAction);

// ── Reset session ──

/** Reset session — clear all user session data */
export class ResetSessionAction {
  async run(bCtx: BrahmanCtx) {
    const session = bCtx.session;
    for (const key of Object.keys(session)) {
      if (key === 'history') continue;
      delete session[key];
    }
  }
}
registerType('brahman.action.resetsession', ResetSessionAction);

// ── Reset history ──

/** Reset history — clear page navigation stack */
export class ResetHistoryAction {
  async run(bCtx: BrahmanCtx) {
    bCtx.session.history = [];
  }
}
registerType('brahman.action.resethistory', ResetHistoryAction);

// ── On error (conditional error handler) ──

/** Error handler — catch specific errors and run fallback action */
export class OnErrorAction {
  /** @title Error text @description Substring to match in error message */
  error = '';
  /** @title Action path @description Path to action node to run */
  action = '';

  async run(bCtx: BrahmanCtx) {
    const { executeAction } = await import('./helpers');
    const { tree } = bCtx;
    const session = bCtx.session;

    const errorInfo = session.error as { message?: string } | undefined;
    if (!errorInfo?.message) return;

    if (this.error && !errorInfo.message.includes(this.error)) return;

    if (this.action) {
      const actionNode = await tree.get(this.action);
      if (actionNode) await executeAction(actionNode, bCtx);
    }
  }
}
registerType('brahman.action.onerror', OnErrorAction);

// ── Keyword select ──

export type KeywordEntry = {
  keywords: string[];
  message: string;
};

/** Keyword matcher — select response based on text keywords */
export class KeywordSelectAction {
  /** @title Source text @description Template for text to analyze */
  textFrom = '';
  /** @title Keyword entries @description Array of {keywords, message} pairs */
  elements: KeywordEntry[] = [];

  async run(bCtx: BrahmanCtx) {
    const { format, executePage } = await import('./helpers');
    const { ctx, tree } = bCtx;
    const session = bCtx.session;

    const sourceText = this.textFrom
      ? format(this.textFrom, bCtx)
      : (session.text as string ?? ctx.message?.text ?? '');
    const words = sourceText.toLowerCase().split(/\s+/);
    const elements = this.elements ?? [];

    for (const el of elements) {
      const match = el.keywords.some(kw => words.includes(kw.toLowerCase()));
      if (match && el.message) {
        if (el.message.startsWith('/')) {
          const cmd = el.message.slice(1);
          const { items: pages } = await tree.getChildren(`${bCtx.botPath}/pages`);
          const page = pages.find(p => {
            const pc = getComponent(p, PageConfig);
            return pc?.command === `/${cmd}` || pc?.command === cmd;
          });
          if (page) await executePage(page.$path, bCtx);
        } else {
          await ctx.reply(el.message);
        }
        return;
      }
    }
  }
}
registerType('brahman.action.keywordselect', KeywordSelectAction);

// ── Call tree action ──

/** Call tree action — execute any Treenix action from bot flow */
export class CallAction {
  /** @title Node path @description Template with {session.vars} */
  path = '';
  /** @title Action name */
  action = '';
  /** @title Component type @description Optional $type for resolution */
  type = '';
  /** @title Component key @description Optional named component key */
  key = '';
  /** @title Input data @format textarea @description JSON template */
  dataExpr = '{}';
  /** @title Save result to @description Session key for result */
  saveTo = '';

  async run(bCtx: BrahmanCtx) {
    const { format } = await import('./helpers');
    const { executeAction } = await import('@treenx/core/server/actions');

    const path = format(this.path, bCtx);
    if (!path || !this.action) return;

    // R5-BRAHMAN-2: confused-deputy concern — bot service tree has broad ACL, and `path` may
    // be templated from session vars populated by Telegram input. A pure prefix-restriction
    // breaks legitimate cross-tree CallAction (the existing test suite covers `/targets/*`,
    // `/items/*` calls). Proper fix is capability-scoped dispatch via `executeWithCapability`
    // against a per-bot scope — deferred to the harness/capability work track.
    // Mitigation today: bot ACLs limit what the bot can actually invoke (action handlers run
    // through `bCtx.tree` which is the bot's auth-wrapped tree).

    let data: unknown;
    if (this.dataExpr) {
      const formatted = format(this.dataExpr, bCtx);
      try { data = JSON.parse(formatted); } catch { data = formatted; }
    }

    const result = await executeAction(
      bCtx.tree, path,
      this.type || undefined,
      this.key || undefined,
      this.action, data,
    );

    if (this.saveTo) bCtx.session[this.saveTo] = result;
  }
}
registerType('brahman.action.call', CallAction);

// ── Select language ──

/** Language selector — let user choose interface language */
export class SelectLanguageAction {
  /** @title Text @format tstring */
  text: TString = {};

  async run(bCtx: BrahmanCtx) {
    const { formatText, buildLangKeyboard } = await import('./helpers');
    const text = formatText(this.text, bCtx);
    const kb = buildLangKeyboard(bCtx.botLangs);
    await bCtx.ctx.reply(text || 'Select language:', { reply_markup: kb, parse_mode: 'HTML' });
  }
}
registerType('brahman.action.selectlang', SelectLanguageAction);

// ── Runtime entities ──

/** Bot user profile — Telegram identity, language, tags, ban status */
export class BrahmanUser {
  tid = 0;
  firstName = '';
  lastName = '';
  username = '';
  lang = 'ru';
  isAdmin = false;
  blocked = false;
  banned = false;
  /** @title User tags */
  tags: string[] = [];
}
registerType('brahman.user', BrahmanUser);

/** User conversation state — session data, history, pending callbacks */
export class BrahmanSession {
  tid = 0;
  data: Record<string, unknown> = {};
  history: string[] = [];
  /** @title Pending callbacks @description messageType → action path */
  callbacks: Record<string, string> = {};
}
registerType('brahman.session', BrahmanSession);
