import { KernelError } from '@treenx/core/errors';
import type { ActionChunks } from '#hooks';
import type { ClientAction } from '#tree/tree-client';
import type { OnChange } from '#tree/on-change';
import { useOptionalTreeSource } from '#tree/tree-source-context';
import type { CommitRequest, Outcome, ReadResult, Selector, Node } from '@treenx/core/kernel/types';

export interface KernelEffects {
  commit(request: Omit<CommitRequest, 'opId'>): Promise<Outcome>;
  read(selector: Selector): Promise<ReadResult>;
}

export interface TreeEffects {
  readonly kernel?: KernelEffects;
  readonly lane: boolean;
  readonly execute: typeof import('#hooks').execute;
  readonly createNode: typeof import('#hooks').createNode;
  readonly removeNode: typeof import('#hooks').removeNode;
  patchNode(path: string, partial: OnChange): Promise<void>;
  stream<T extends keyof ActionChunks, A extends keyof ActionChunks[T] & string>(
    action: ClientAction & { type: T; action: A },
  ): AsyncIterableIterator<ActionChunks[T][A]>;
  stream(action: ClientAction): AsyncIterableIterator<unknown>;
  /** Native bits belong to the copy at this source, never a global path permission cache. */
  bits(path: string): number | undefined;
  readonly presentation?: {
    readonly version: number;
    project(node: Node): Node;
    subscribe(listener: (id: string) => void): () => void;
  };
}

/** Read-only sources can render action controls; invoking an effect reports the missing capability. */
async function unavailable(): Promise<never> {
  throw new KernelError('UNAVAILABLE', 'This source does not provide mutations');
}

export const READ_ONLY_EFFECTS: TreeEffects = {
  lane: false,
  execute: unavailable,
  patchNode: unavailable,
  createNode: unavailable, removeNode: unavailable,
  async *stream() { await unavailable(); },
  bits: () => undefined,
};

/** Capture the selected source owner so later event callbacks keep their principal and lifecycle. */
export function useTreeEffects(): TreeEffects {
  return useOptionalTreeSource()?.effects ?? READ_ONLY_EFFECTS;
}
