import type { JsonSchema, WriteActionContext } from '@treenx/core/kernel/types';
import type { buildReplyMarkup } from '#brahman/helpers';

export interface BrahmanMedia {
  readonly fileId: string;
  readonly mime: string;
}

export interface BrahmanUpdate {
  readonly text?: string;
  readonly messageId?: number;
  readonly photo?: string;
  readonly callbackData?: string;
  readonly firstName?: string;
  readonly lastName?: string;
  readonly username?: string;
  readonly voice?: BrahmanMedia;
  readonly audio?: BrahmanMedia;
}

export interface BrahmanRunArgs {
  readonly botPath: string;
  readonly userId: number;
  readonly chatId: number;
  readonly lang: string;
  readonly update: BrahmanUpdate;
}

export interface BrahmanFlow {
  readonly page?: string;
  readonly action?: string;
  readonly stop?: boolean;
  readonly emittedText?: string;
  readonly broadcast?: readonly { readonly action: string; readonly userId: number; readonly chatId: number; readonly lang: string }[];
  readonly call?: { readonly path: string; readonly component?: string; readonly action: string; readonly args: unknown; readonly saveTo?: string };
}

export interface TelegramMessageOptions {
  readonly parse_mode?: 'HTML';
  readonly disableLinks?: boolean;
  readonly replyToMessageId?: number;
  readonly replyMarkup?: NonNullable<ReturnType<typeof buildReplyMarkup>>['reply_markup'];
}

/** The external adapter owns bot credentials and request cancellation. */
export interface BrahmanTelegram {
  send(botPath: string, chatId: number | string, text: string, options: TelegramMessageOptions): Promise<number>;
  edit(botPath: string, chatId: number, messageId: number, text: string, options: TelegramMessageOptions): Promise<void>;
  remove(botPath: string, chatId: number, messageId: number): Promise<void>;
  forward(botPath: string, chatId: number, fromChatId: number, messageId: number): Promise<number>;
  file(botPath: string, chatId: number, kind: string, fileId: string): Promise<number>;
  download(botPath: string, fileId: string): Promise<Uint8Array>;
}

declare module '@treenx/core/kernel/types' {
  interface Io {
    readonly brahman?: BrahmanTelegram;
  }
}

const mediaSchema: JsonSchema = {
  type: 'object', additionalProperties: false, required: ['fileId', 'mime'],
  properties: { fileId: { type: 'string', minLength: 1 }, mime: { type: 'string', minLength: 1 } },
};

export const brahmanRunSchema: JsonSchema = {
  type: 'object', additionalProperties: false,
  required: ['botPath', 'userId', 'chatId', 'lang', 'update'],
  properties: {
    botPath: { type: 'string' }, userId: { type: 'integer' }, chatId: { type: 'integer' }, lang: { type: 'string' },
    update: { type: 'object', additionalProperties: false, properties: {
      text: { type: 'string' }, messageId: { type: 'integer' }, photo: { type: 'string' }, callbackData: { type: 'string' },
      firstName: { type: 'string' }, lastName: { type: 'string' }, username: { type: 'string' },
      voice: mediaSchema, audio: mediaSchema,
    } },
  },
};

export type BrahmanNativeHandler = (context: WriteActionContext, args: BrahmanRunArgs) => Promise<BrahmanFlow | void>;
