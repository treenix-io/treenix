import type { NodeData } from '@treenx/core';
import type { ChildrenOpts, Page, PatchOp } from '@treenx/core/tree';
import { tree } from '#tree/client';
import { trpc } from '#tree/trpc';
import { createTrpcTreeClient } from '#tree/trpc-tree-client';

export type ClientAction = {
  path: string;
  action: string;
  args?: unknown;
  type?: string;
  component?: string;
  opId?: string;
};

export type ClientChange =
  | { kind: 'put'; node: NodeData }
  | { kind: 'patch'; path: string; ops: PatchOp[] }
  | { kind: 'remove'; path: string };

export type NodeRead = { kind: 'node'; path: string; watch?: boolean };
export type ChildrenRead = { kind: 'children'; path: string; options?: ChildrenOpts };
export type PermissionRead = { kind: 'permission'; path: string };

export type ClientObserver<T> = {
  next(value: T): void;
  error(error: unknown): void;
  complete?(): void;
};

export type ClientSubscription<T = unknown> =
  | { kind: 'action'; action: ClientAction; observer: ClientObserver<T> }
  | { kind: 'path'; path: string; observer: ClientObserver<NodeData | undefined> };

export interface TreeClient {
  read(request: NodeRead): Promise<NodeData | undefined>;
  read(request: ChildrenRead): Promise<Page<NodeData>>;
  read(request: PermissionRead): Promise<number>;
  act(request: ClientAction): Promise<unknown>;
  commit(changes: readonly ClientChange[]): Promise<void>;
  sub<T = unknown>(request: ClientSubscription<T>): string;
  cancel(id: string): void;
}

export const treeClient: TreeClient = createTrpcTreeClient(trpc, tree);
