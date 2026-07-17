// Remote Tree — Tree adapter over tRPC client.
// Maps the 4 Tree methods to tRPC query/mutation calls.
// Enables client to use the same combinators as server:
//   withSubscriptions(withCache(createRemoteTree(trpc)))

import type { NodeData } from '@treenx/core';
import type { PatchOp, Tree, TreeEvent, TreeWatchOpts, TreeWatchScope } from '@treenx/core/tree';
import { subscriptionToAsyncIterable } from '@treenx/core/tree';
import type { trpc } from './trpc';

type TrpcClient = typeof trpc;

function debugPath(path: string, op: string) {
  if (path.includes('//')) {
    console.error(`[remote-tree] double slash in ${op}: ${JSON.stringify(path)}`, new Error('stack'));
  }
}

/** Direct child check — path is /parent/x but NOT /parent or /parent/x/y. */
function isDirectChild(parent: string, candidate: string): boolean {
  const prefix = parent === '/' ? '/' : parent + '/';
  if (!candidate.startsWith(prefix)) return false;
  const rest = candidate.slice(prefix.length);
  return rest.length > 0 && !rest.includes('/');
}

// Wire event shape — what the server emits through trpc.events.subscribe.
// Mirrors #sub's NodeEvent at runtime; typed loosely here to avoid pulling
// the #sub package into the client's L1 adapter.
type WireEvent = TreeEvent & {
  addVps?: string[];
  rmVps?: string[];
  invalidateVps?: string[];
  patches?: PatchOp[];
};

/** Reduce a wire event (with optional VPs) to a pure TreeEvent — Tree.watch's
 *  L1 contract carries no CDC. Callers needing VPs use the #sub layer. */
function toTreeEvent(event: WireEvent): TreeEvent {
  switch (event.type) {
    case 'set':       return { type: 'set',       path: event.path, node: event.node };
    case 'patch':     return { type: 'patch',     path: event.path, patches: event.patches ?? [], rev: event.rev };
    case 'remove':    return { type: 'remove',    path: event.path };
    case 'reconnect': return { type: 'reconnect', preserved: event.preserved };
  }
}

function matchesScope(event: TreeEvent, scope: TreeWatchScope): boolean {
  if (event.type === 'reconnect') return true; // control event — always pass
  if (scope.kind === 'all') return true;
  if (scope.kind === 'path') return event.path === scope.path;
  return isDirectChild(scope.path, event.path);
}

type EventsSubscription = {
  subscribe(input: void, callbacks: { onData?(e: WireEvent): void; onError?(err: unknown): void }): { unsubscribe(): void };
};

export function createRemoteTree(client: TrpcClient): Tree {
  const get = (path: string) => {
    debugPath(path, 'get');
    return client.get.query({ path }) as Promise<NodeData | undefined>;
  };
  // Transport receipts are OPAQUE (core-ns6p.2): `changes: null` = committed,
  // contents unknown — the server's images arrive via the event lane; the
  // anz4.13 wire-ack upgrade will carry them in the response.
  const set = (node: NodeData) => {
    debugPath(node.$path, 'set');
    return client.set.mutate({ node: node as Record<string, unknown> }).then(() => ({ changes: null }));
  };

  return {
    get,
    getChildren: (path, opts) => {
      debugPath(path, 'getChildren');
      return client.getChildren.query({ path, ...opts });
    },
    set,
    remove: (path) => {
      debugPath(path, 'remove');
      return client.remove.mutate({ path }).then((ok) => ({ changes: ok ? null : [] }));
    },
    patch: (path, ops) => {
      debugPath(path, 'patch');
      return client.patch.mutate({ path, ops }).then(() => ({ changes: null }));
    },

    /** Watch via trpc.events — the per-user wire stream from WatchManager.
     *  Strips VPs to fit the L1 TreeEvent contract and filters client-side
     *  by scope. Caller MUST separately register interest via
     *  `get({path, watch:true})` / `getChildren({path, watch:true})` —
     *  the events.subscribe stream only carries paths the WatchManager has
     *  fanned out to this user.
     *
     *  Note: VP-membership signals (addVps/rmVps/invalidateVps) are dropped
     *  here. Callers that need CDC routing keep using the existing events
     *  pipeline ([packages/react/src/tree/events.ts]). */
    watch(scope: TreeWatchScope, opts?: TreeWatchOpts): AsyncIterable<TreeEvent> {
      const events = client.events as unknown as EventsSubscription;
      return subscriptionToAsyncIterable<TreeEvent>(
        (push) => {
          const sub = events.subscribe(undefined, {
            onData(wire) {
              const evt = toTreeEvent(wire);
              if (matchesScope(evt, scope)) push(evt);
            },
            onError(err) {
              console.error('[remote-tree] watch subscription error:', err);
            },
          });
          return () => sub.unsubscribe();
        },
        { type: 'reconnect', preserved: false },
        opts,
      );
    },
  };
}
