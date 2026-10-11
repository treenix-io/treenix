import type { ErrorCode, PublishedActionSource } from '#kernel/types';

export type SourceWorkerConfig =
  | { readonly verify: true; readonly source: string; readonly stream: boolean }
  | { readonly verify: false; readonly publication: PublishedActionSource; readonly args: unknown; readonly ports: readonly string[]; readonly writing: boolean };

export type SourceWorkerRequest =
  | { readonly kind: 'sync'; readonly method: 'get' | 'change' | 'charge'; readonly input: unknown; readonly bytes: SharedArrayBuffer }
  | { readonly kind: 'call'; readonly id: number; readonly method: 'read' | 'act' | 'io'; readonly input: unknown }
  | { readonly kind: 'piece'; readonly done: boolean; readonly value: unknown }
  | { readonly kind: 'verified' }
  | { readonly kind: 'failed'; readonly error: SourceWorkerError };

export interface SourceWorkerError { readonly code: ErrorCode; readonly message: string; readonly terminal?: boolean }
export type SourceWorkerReply =
  | { readonly kind: 'next' }
  | { readonly kind: 'reply'; readonly id: number; readonly result: string }
  | { readonly kind: 'refused'; readonly id: number; readonly error: SourceWorkerError };

export type SourceSyncReply = { readonly value: unknown } | { readonly error: SourceWorkerError };
