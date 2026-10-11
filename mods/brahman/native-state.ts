import { getComponent, type TypeId } from '@treenx/core';
import { KernelError } from '@treenx/core/errors';
import type { Node, Reader, WriteAction, WriteActionContext } from '@treenx/core/kernel/types';
import { randomUUID } from 'node:crypto';
import { formatTString, renderTemplate } from '#brahman/helpers';
import { evalExpr } from '#brahman/sandbox';
import { BotConfig, BrahmanSession, BrahmanUser, type TString, type WaitState } from '#brahman/types';
import { brahmanRunSchema, type BrahmanFlow, type BrahmanMedia, type BrahmanRunArgs, type BrahmanTelegram } from '#brahman/native-ports';

export interface NativeConversation {
  readonly args: BrahmanRunArgs;
  readonly sessionPath: string;
  readonly userPath: string;
  readonly config: BotConfig;
  readonly user: BrahmanUser;
  readonly data: NativeConversationData;
  history: string[];
}

export interface NativeConversationData {
  [field: string]: unknown;
  wait?: WaitState;
  error?: { message: string };
  param?: string;
  text?: string;
  params?: string[];
  _lastMsgId?: number;
  _lastMenu?: string;
  _emittedText?: string;
}

export interface NativeSessionState extends BrahmanSession {
  data: NativeConversationData;
}

/** Decode optional Telegram media at the serialized update boundary. */
function mediaInput(value: unknown): BrahmanMedia | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || !('fileId' in value) || typeof value.fileId !== 'string'
    || value.fileId.length === 0 || !('mime' in value) || typeof value.mime !== 'string' || value.mime.length === 0)
    throw new KernelError('INVALID', 'Invalid serialized Telegram media');
  return { fileId: value.fileId, mime: value.mime };
}

/** Decode the external action argument before it selects conversation state. */
export function runArguments(value: unknown): BrahmanRunArgs {
  if (typeof value !== 'object' || value === null || !('botPath' in value) || typeof value.botPath !== 'string'
    || !('userId' in value) || typeof value.userId !== 'number' || !Number.isSafeInteger(value.userId)
    || !('chatId' in value) || typeof value.chatId !== 'number' || !Number.isSafeInteger(value.chatId)
    || !('lang' in value) || typeof value.lang !== 'string' || !('update' in value)
    || typeof value.update !== 'object' || value.update === null)
    throw new KernelError('INVALID', 'Serialized Brahman update is required');
  const update = value.update;
  const text = 'text' in update ? update.text : undefined;
  const photo = 'photo' in update ? update.photo : undefined;
  const callbackData = 'callbackData' in update ? update.callbackData : undefined;
  const messageId = 'messageId' in update ? update.messageId : undefined;
  const firstName = 'firstName' in update ? update.firstName : undefined;
  const lastName = 'lastName' in update ? update.lastName : undefined;
  const username = 'username' in update ? update.username : undefined;
  const voice = mediaInput('voice' in update ? update.voice : undefined);
  const audio = mediaInput('audio' in update ? update.audio : undefined);
  if ((text !== undefined && typeof text !== 'string') || (photo !== undefined && typeof photo !== 'string')
    || (callbackData !== undefined && typeof callbackData !== 'string')
    || (messageId !== undefined && (typeof messageId !== 'number' || !Number.isSafeInteger(messageId)))
    || (firstName !== undefined && typeof firstName !== 'string') || (lastName !== undefined && typeof lastName !== 'string')
    || (username !== undefined && typeof username !== 'string'))
    throw new KernelError('INVALID', 'Invalid serialized Telegram update');
  return { botPath: value.botPath, userId: value.userId, chatId: value.chatId, lang: value.lang,
    update: { ...(text === undefined ? {} : { text }), ...(photo === undefined ? {} : { photo }),
      ...(callbackData === undefined ? {} : { callbackData }), ...(messageId === undefined ? {} : { messageId }),
      ...(firstName === undefined ? {} : { firstName }), ...(lastName === undefined ? {} : { lastName }),
      ...(username === undefined ? {} : { username }),
      ...(voice === undefined ? {} : { voice }), ...(audio === undefined ? {} : { audio }) } };
}

/** Propagate the canonical native node read, including its admission and absence result. */
export async function nativeNode(reader: Reader, path: string): Promise<Node> {
  const copy = (await reader.read({ node: path })).copies[0];
  if ('error' in copy) throw copy.error;
  return copy.node;
}

/** Read a declared component through its owning source type. */
export function component<T extends object>(node: Node, type: TypeId<T>): T {
  const result = getComponent(node, type);
  if (result === undefined) throw new KernelError('INVALID', 'Native Brahman component differs from its schema');
  return result;
}

/** Load conversation state through the actual executor reader. */
export async function conversation(context: WriteActionContext, args: BrahmanRunArgs): Promise<NativeConversation> {
  const sessionPath = `${args.botPath}/sessions/${args.userId}`;
  const userPath = `${args.botPath}/users/${args.userId}`;
  const [bot, session, user] = await Promise.all([
    nativeNode(context.read, args.botPath), nativeNode(context.read, sessionPath), nativeNode(context.read, userPath),
  ]);
  const state = component<NativeSessionState>(session, 'brahman.session');
  return { args, sessionPath, userPath, config: component(bot, BotConfig), user: component(user, BrahmanUser),
    data: { ...state.data }, history: [...state.history] };
}

/** Persist state in the action's single canonical ChangeSet. */
export function saveConversation(context: WriteActionContext, state: NativeConversation): void {
  context.change.patch(state.sessionPath, { $set: { data: state.data, history: state.history } });
}

/** Keep external Telegram effects behind explicitly admitted action I/O. */
export function telegram(context: WriteActionContext): BrahmanTelegram {
  const port = context.io?.brahman;
  if (port === undefined) throw new KernelError('UNAVAILABLE', 'Brahman Telegram I/O is not bound');
  return port;
}

/** Evaluate template expressions in the existing bounded sandbox before pure interpolation. */
export async function formatNative(template: string, state: NativeConversation): Promise<string> {
  const data: Record<string, unknown> = { ...state.data, history: state.history, user: state.user,
    tags: state.user.tags, userTags: state.user.tags, lang: state.args.lang, session: state.data,
    ctx: { user: state.user, session: state.data } };
  let prepared = template;
  const expressions: { marker: string; source: string }[] = [];
  for (const match of template.matchAll(/\{\{eval\s+([\s\S]*?)\}\}/g)) {
    const key = `__native_expression_${expressions.length}`;
    const marker = `[${randomUUID()}]`;
    data[key] = marker;
    expressions.push({ marker, source: match[1] });
    prepared = prepared.replace(match[0], `{{${key}}}`);
  }
  let result = renderTemplate(prepared, data);
  for (const expression of expressions) {
    if (!result.includes(expression.marker)) continue;
    const value = await evalExpr(expression.source, { data: state.data, session: state.data, user: state.user });
    result = result.replaceAll(expression.marker, String(value));
  }
  return result;
}

/** Localize the authored message before native template evaluation. */
export function textNative(text: TString, state: NativeConversation): Promise<string> {
  return formatNative(formatTString(text, state.args.lang), state);
}

/** Bind typed component behavior to one admitted native action and state commit. */
export function runAction<T extends object>(
  type: TypeId<T>,
  body: (context: WriteActionContext, configuration: T, state: NativeConversation) => Promise<BrahmanFlow | void>,
  options: { readonly io?: boolean; readonly save?: boolean } = {},
): WriteAction {
  return { kind: 'write', args: brahmanRunSchema, io: options.io, async handler(context, input) {
    const args = runArguments(input);
    const state = await conversation(context, args);
    const result = await body(context, component(context.node, type), state);
    if (options.save !== false) saveConversation(context, state);
    return result;
  } };
}
