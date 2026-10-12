import { KernelError } from '@treenx/core/errors';
import type { ActionChunks, ActionResults } from '#hooks';
import type { OnChange } from '#tree/on-change';
import { useOptionalTreeSource } from '#tree/tree-source-context';
import type { CommitRequest, Outcome, ReadResult, Selector, Node } from '@treenx/core/kernel/types';

export interface KernelEffects {
  commit(request: Omit<CommitRequest, 'opId'>): Promise<Outcome>;
  read(selector: Selector): Promise<ReadResult>;
}

export interface ClientAction {
  path: string;
  action: string;
  args?: unknown;
  type?: string;
  component?: string;
  opId?: string;
}

export interface TreeEffects {
  readonly kernel?: KernelEffects;
  readonly lane: boolean;
  execute<T extends keyof ActionResults, A extends keyof ActionResults[T] & string>(
    pathOrUri: string,
    action: A,
    data: unknown,
    type: T,
    key?: string,
  ): Promise<ActionResults[T][A]>;
  execute(
    pathOrUri: string,
    action: string,
    data?: unknown,
    type?: string,
    key?: string,
  ): Promise<unknown>;
  createNode(path: string, type: string, data?: Record<string, unknown>): Promise<void>;
  removeNode(path: string): Promise<void>;
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
  createNode: unavailable,
  removeNode: unavailable,
  async *stream() {
    await unavailable();
  },
  bits: () => undefined,
};

/** Capture the selected source owner so later event callbacks keep their principal and lifecycle. */
export function useTreeEffects(): TreeEffects {
  return useOptionalTreeSource()?.effects ?? READ_ONLY_EFFECTS;
}
