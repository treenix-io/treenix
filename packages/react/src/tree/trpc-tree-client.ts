import type { NodeData } from '@treenx/core';
import { KernelError } from '@treenx/core/errors';
import type { Page, Tree } from '@treenx/core/tree';
import * as cache from '#tree/cache';
import { acquireHoldForRegistration, releaseHold } from '#tree/holds';
import { trackedGet } from '#tree/read-track';
import { tabTokenInput, type trpc } from '#tree/trpc';
import type { ChildrenRead, ClientAction, ClientChange, ClientSubscription, NodeRead, PermissionRead, TreeClient } from '#tree/tree-client';

type TrpcClient = typeof trpc;
const isLocal = (path: string) => path.startsWith('/local');
const actionInput = ({ args, component, ...request }: ClientAction) => ({ ...request, data: args, key: component });

export function createTrpcTreeClient(client: TrpcClient, local: Tree): TreeClient {
  const subscriptions = new Map<string, () => void>();

  function read(request: NodeRead): Promise<NodeData | undefined>;
  function read(request: ChildrenRead): Promise<Page<NodeData>>;
  function read(request: PermissionRead): Promise<number>;
  function read(request: NodeRead | ChildrenRead | PermissionRead): Promise<NodeData | undefined | Page<NodeData> | number> {
    if (request.kind === 'permission') return client.getPerm.query({ path: request.path });
    if (request.kind === 'children') return local.getChildren(request.path, request.options);
    if (isLocal(request.path)) return local.get(request.path);
    const input = request.watch === undefined
      ? { path: request.path }
      : { path: request.path, watch: request.watch, ...tabTokenInput };
    return client.get.query(input).then(node => node ?? undefined);
  }

  async function commit(changes: readonly ClientChange[]): Promise<void> {
    // The legacy transport has no mixed atomic batch. Refuse before the first member can take effect.
    if (changes.length !== 1) throw new KernelError('INVALID', 'This transport requires one change per commit');
    const change = changes[0];
    switch (change.kind) {
      case 'put': await local.set(change.node); break;
      case 'remove': await local.remove(change.path); break;
      case 'patch':
        if (isLocal(change.path)) await local.patch(change.path, change.ops);
        else await client.patch.mutate({ path: change.path, ops: change.ops });
        break;
    }
  }

  function cancel(id: string): void {
    const stop = subscriptions.get(id);
    subscriptions.delete(id);
    stop?.();
  }

  function sub<T>(request: ClientSubscription<T>): string {
    const id = crypto.randomUUID();
    if (request.kind === 'action') {
      const { observer } = request;
      let closed = false;
      const finish = () => {
        closed = true;
        subscriptions.delete(id);
      };
      const stream = client.streamAction.subscribe(actionInput(request.action), {
        // The dynamic action's wire result is typed by its caller, like the action proxy's return type.
        onData(item) { if (!closed) observer.next(item as T); },
        onError(error) { if (!closed) { finish(); observer.error(error); } },
        onComplete() { if (!closed) { finish(); observer.complete?.(); } },
      });
      if (!closed) subscriptions.set(id, () => {
        finish();
        stream.unsubscribe();
        observer.complete?.();
      });
      return id;
    }

    const { path, observer } = request;
    let closed = false;
    let active = false;
    let held = false;
    let registering = true;
    const unsubscribe = cache.subscribePath(path, () => {
      if (active && !closed) observer.next(cache.get(path));
    });
    const release = () => {
      if (held) { held = false; releaseHold(path); }
    };
    subscriptions.set(id, () => {
      closed = true;
      unsubscribe();
      // A registering get may still create its hold; release only after its response settles.
      if (!registering) release();
      observer.complete?.();
    });

    const start = async () => {
      try {
        if (!isLocal(path)) { await acquireHoldForRegistration(path); held = true; }
        if (closed) return;
        const result = await trackedGet(path, () => read({ kind: 'node', path, watch: !isLocal(path) }), {
          isCancelled: () => closed,
        });
        if (result.error !== undefined) throw result.error;
        if (!closed) { active = true; observer.next(cache.get(path)); }
      } finally {
        registering = false;
        if (closed) release();
      }
    };
    start().catch(error => {
      if (!closed) {
        try { observer.error(error); } finally { cancel(id); }
      }
    });
    return id;
  }

  return { read, commit, sub, cancel, act: request => client.execute.mutate(actionInput(request)) };
}
