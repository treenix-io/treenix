import { declareClientType } from '@treenx/core/comp/client-declaration';
import { declareOpenModule } from '@treenx/core/kernel/module-declaration';
// Brahman — Telegram bot constructor
// Component types for bot config, pages, actions, users, sessions

import { getComponent, type NodeData, register } from '@treenx/core';
import '@treenx/core/contexts/text';
import { registerType } from '@treenx/core/comp';

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
}
registerType('brahman.action.ifelse', IfElseAction);

/** Navigate to page — redirect conversation flow */
export class PageNavAction {
  /** @title Target page @description Path to page node */
  targetPage = '';
}
registerType('brahman.action.page', PageNavAction);

/** Go back — return to previous page in history */
export class BackAction {
}
registerType('brahman.action.back', BackAction);

/** Set user tag — assign key-value metadata to user */
export class TagAction {
  /** @title Tag name */
  tag = '';
  /** @title Value expression */
  value = 'true';
}
registerType('brahman.action.tag', TagAction);

/** Broadcast message — send action to users matching tag filter */
export class BroadcastAction {
  /** @title User tags filter @format tags */
  userTags: string[] = [];
  /** @title Action to broadcast @description Path to action node */
  action = '';
}
registerType('brahman.action.broadcast', BroadcastAction);

/** Read session value — extract data from user session */
export class GetValueAction {
  /** @title Source path @description Dot-path in session data */
  path = '';
  /** @title Save to */
  saveTo = '';
}
registerType('brahman.action.getvalue', GetValueAction);

/** Write session value — tree data in user session */
export class SetValueAction {
  /** @title Value expression */
  value = '';
  /** @title Save to */
  saveTo = '';
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
}
registerType('brahman.action.params', ParamsAction);

/** Send file — deliver photo/document/video/audio to chat */
export class FileAction {
  /** @title File node path */
  fileId = '';
  /** @title Override type @description photo, document, video, audio, voice */
  asType = '';
}
registerType('brahman.action.file', FileAction);

// ── Eval ──

/** Execute JavaScript — run async code with context access */
export class EvalAction {
  /** @title JavaScript code @format textarea @description Async function body, receives ctx object */
  value = '';
}
registerType('brahman.action.eval', EvalAction);

// ── Remove message ──

/** Remove message — delete bot message from chat */
export class RemoveAction {
}
registerType('brahman.action.remove', RemoveAction);

// ── Emit text (synthetic text injection) ──

/** Emit synthetic text — inject text for re-processing */
export class EmitTextAction {
  /** @title Text template @format textarea @description Template for text to re-process */
  from = '';
}
registerType('brahman.action.emittext', EmitTextAction);

// ── Forward message ──

/** Forward message — relay message to another chat */
export class ForwardAction {
  /** @title Message ID from @description Session field with msg id. Empty = current msg */
  msgIdFrom = '';
  /** @title Forward to @description Chat/user ID template */
  toFrom = '';
}
registerType('brahman.action.forward', ForwardAction);

// ── Reset session ──

/** Reset session — clear all user session data */
export class ResetSessionAction {
}
registerType('brahman.action.resetsession', ResetSessionAction);

// ── Reset history ──

/** Reset history — clear page navigation stack */
export class ResetHistoryAction {
}
registerType('brahman.action.resethistory', ResetHistoryAction);

// ── On error (conditional error handler) ──

/** Error handler — catch specific errors and run fallback action */
export class OnErrorAction {
  /** @title Error text @description Substring to match in error message */
  error = '';
  /** @title Action path @description Path to action node to run */
  action = '';
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
}
registerType('brahman.action.call', CallAction);

// ── Select language ──

/** Language selector — let user choose interface language */
export class SelectLanguageAction {
  /** @title Text @format tstring */
  text: TString = {};
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

/** Incoming Telegram message persisted as a node (id = tg-<chatId>-<messageId> for idempotency) */
export class BrahmanMessage {
  tid = 0;
  chatId = 0;
  messageId = 0;
  /** Sender display: @username or first name */
  from = '';
  /** @format textarea */
  text = '';
  createdAt = 0;
}
registerType('brahman.message', BrahmanMessage);

// 'text' context = readable content extractor; consumers resolve(type, 'text') without importing this mod.
// Registry erases types (system boundary) — data is the node.
register('brahman.message', 'text', (data) => {
  const node = data as NodeData;
  const msg = getComponent(node, BrahmanMessage);
  if (!msg) throw new Error(`brahman.message without message data: ${node.$path}`);
  return msg.text;
});

export const clientModules = [declareOpenModule('@treenx/mods/brahman/types', [], [
  declareClientType('brahman.bot', BotConfig),
  declareClientType('brahman.page', PageConfig),
  declareClientType('brahman.action.message', MessageAction),
  declareClientType('brahman.action.question', QuestionAction),
  declareClientType('brahman.action.ifelse', IfElseAction),
  declareClientType('brahman.action.page', PageNavAction),
  declareClientType('brahman.action.back', BackAction),
  declareClientType('brahman.action.tag', TagAction),
  declareClientType('brahman.action.broadcast', BroadcastAction),
  declareClientType('brahman.action.getvalue', GetValueAction),
  declareClientType('brahman.action.setvalue', SetValueAction),
  declareClientType('brahman.action.params', ParamsAction),
  declareClientType('brahman.action.file', FileAction),
  declareClientType('brahman.action.eval', EvalAction),
  declareClientType('brahman.action.remove', RemoveAction),
  declareClientType('brahman.action.emittext', EmitTextAction),
  declareClientType('brahman.action.forward', ForwardAction),
  declareClientType('brahman.action.resetsession', ResetSessionAction),
  declareClientType('brahman.action.resethistory', ResetHistoryAction),
  declareClientType('brahman.action.onerror', OnErrorAction),
  declareClientType('brahman.action.keywordselect', KeywordSelectAction),
  declareClientType('brahman.action.call', CallAction),
  declareClientType('brahman.action.selectlang', SelectLanguageAction),
  declareClientType('brahman.user', BrahmanUser),
  declareClientType('brahman.session', BrahmanSession),
  declareClientType('brahman.message', BrahmanMessage),
])];
