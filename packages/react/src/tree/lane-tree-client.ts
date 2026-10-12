import type { TwpClient } from '@treenx/core/client/twp';
import { KernelError } from '@treenx/core/errors';
import type { ActRequest, CommitRequest, Outcome, Pending } from '@treenx/core/kernel/types';
import { createChunkChannel } from '@treenx/core/util/chunk-channel';

export interface LaneTreeClientOptions {
  /** Reopen the same authenticated principal with the same caller-owned canonical cache. */
  readonly reconnect?: () => Promise<TwpClient>;
}

export type LaneConnectionState = 'connecting' | 'connected' | 'disconnected';

export interface LaneConnection {
  getSnapshot(): LaneConnectionState;
  subscribe(listener: () => void): () => void;
}

interface Operation {
  readonly id: string;
  readonly input: { readonly act: ActRequest } | { readonly commit: CommitRequest };
  readonly channel: ReturnType<typeof createChunkChannel>;
  readonly resolve: (outcome: Outcome) => void;
  readonly reject: (error: unknown) => void;
  pending?: { readonly request: Pending; readonly client: TwpClient };
  cancelled: boolean;
}

interface Watch {
  readonly selector: Parameters<TwpClient['sub']>[0];
  readonly changed: () => void;
  readonly refused?: (error: KernelError) => void;
  subscription?: ReturnType<TwpClient['sub']>;
  closed: boolean;
}

/** Retain exact mutation keys across lost answers while sharing the one authenticated canonical cache. */
export function createLaneTreeClient(
  initial: TwpClient,
  options: LaneTreeClientOptions = {},
): TwpClient & { readonly connection: LaneConnection } {
  const cache = initial.cache;
  const operations = new Map<string, Operation>();
  const watches = new Set<Watch>();
  const lifetime = new AbortController();
  let client = initial;
  let connecting: Promise<TwpClient> | undefined;
  let closed: KernelError | undefined;
  let sequence = 0;
  let state: LaneConnectionState = 'connecting';
  const listeners = new Set<() => void>();

  /** Expose admission and reconnect state from the owner that replaces the transport. */
  function publish(next: LaneConnectionState): void {
    if (state === next) return;
    state = next;
    for (const listener of listeners) listener();
  }

  void initial.ready.then(
    () => {
      if (closed === undefined && connecting === undefined) publish('connected');
    },
    () => {
      if (closed === undefined) publish('disconnected');
    },
  );

  /** Reject use of a disposed owner, including event callbacks retained by a prior principal. */
  function available(): void {
    if (closed !== undefined) throw closed;
  }

  /** New mutations take their key only from the currently admitted transport. */
  function key() {
    available();
    if (connecting !== undefined) throw new KernelError('UNAVAILABLE', 'Lane reconnect is pending');
    return client.key();
  }

  /** Replace transport ownership once; concurrent lost requests share this actual reconnect. */
  async function reconnect(error: KernelError, failed: TwpClient): Promise<TwpClient> {
    available();
    if (error.code !== 'UNAVAILABLE' || options.reconnect === undefined) throw error;
    if (client !== failed) return client;

    if (connecting === undefined) {
      publish('connecting');
      const open = options.reconnect;
      connecting = (async () => {
        const next = await open();
        if (next.cache !== cache) {
          next.close();
          throw new KernelError('INVALID', 'Reconnect changed the canonical cache owner');
        }
        const [previousWelcome, nextWelcome] = await Promise.all([initial.ready, next.ready]);
        if (previousWelcome.principal !== nextWelcome.principal) {
          next.close();
          throw new KernelError('UNAUTHENTICATED', 'Reconnect changed the authenticated principal');
        }
        if (closed !== undefined) {
          next.close();
          throw closed;
        }

        client = next;
        publish('connected');
        for (const watch of watches)
          if (!watch.closed) {
            startWatch(watch);
            watch.changed();
          }
        return next;
      })();
    }

    const pending = connecting;
    try {
      return await pending;
    } catch (received) {
      publish('disconnected');
      throw received;
    } finally {
      if (connecting === pending) connecting = undefined;
    }
  }

  /** Await the actual admission before issuing new work; never predict the intake epoch. */
  async function admitted(): Promise<TwpClient> {
    available();
    const current = connecting === undefined ? client : await connecting;
    await current.ready;
    available();
    return current;
  }

  /** Forward pieces with the existing single-consumer backpressure and explicit cancellation semantics. */
  async function pieces(operation: Operation, pending: Pending): Promise<void> {
    for await (const chunk of pending.chunks) {
      if (operation.cancelled) continue;
      try {
        await operation.channel.deliver(chunk, lifetime.signal);
      } catch (error) {
        if (!operation.cancelled || !(error instanceof KernelError && error.code === 'CANCELLED'))
          throw error;
      }
    }
  }

  /** Resend only transport-lost requests, preserving their complete original payload and OpId. */
  async function run(operation: Operation): Promise<void> {
    try {
      while (true) {
        const current = await admitted();
        const pending =
          'act' in operation.input
            ? current.act(operation.input.act)
            : current.commit(operation.input.commit);
        operation.pending = { request: pending, client: current };
        if (operation.cancelled) current.cancel(pending.id);

        try {
          const [outcome] = await Promise.all([pending.outcome, pieces(operation, pending)]);
          operation.channel.end();
          operation.resolve(outcome);
          return;
        } catch (error) {
          if (
            !(error instanceof KernelError) ||
            error.code !== 'UNAVAILABLE' ||
            current.failure()?.code !== 'UNAVAILABLE'
          )
            throw error;
          await reconnect(error, current);
        }
      }
    } catch (error) {
      operation.channel.end(error);
      operation.reject(error);
    } finally {
      operations.delete(operation.id);
    }
  }

  /** Allocate one public Pending which survives its individual transport requests. */
  function request(input: Operation['input']): Pending {
    available();
    if (operations.size >= 8) throw new KernelError('BUDGET', 'Too many unfinished lane mutations');

    const id = `mutation:${++sequence}`;
    const channel = createChunkChannel(() => cancel(id));
    let resolve: Operation['resolve'] = () => {};
    let reject: Operation['reject'] = () => {};
    const outcome = new Promise<Outcome>((accepted, refused) => {
      resolve = accepted;
      reject = refused;
    });
    const operation: Operation = {
      id,
      input: structuredClone(input),
      channel,
      resolve,
      reject,
      cancelled: false,
    };
    operations.set(id, operation);
    void run(operation);

    return { id, outcome, chunks: channel.chunks };
  }

  /** Cancel the actual currently owned request while still awaiting its canonical outcome. */
  function cancel(id: string): void {
    available();
    const operation = operations.get(id);
    if (operation === undefined) throw new KernelError('INVALID', 'Unknown lane mutation');

    operation.cancelled = true;
    operation.channel.end(new KernelError('CANCELLED', 'Request cancelled'));
    const pending = operation.pending;
    if (pending !== undefined && pending.client.failure() === undefined)
      pending.client.cancel(pending.request.id);
  }

  /** Reopen coverage from its actual selector after a resumable transport loss. */
  function startWatch(watch: Watch): void {
    const current = client;
    watch.subscription = current.sub(watch.selector, watch.changed, (error) => {
      if (watch.closed || closed !== undefined) return;
      if (
        error.code !== 'UNAVAILABLE' ||
        current.failure()?.code !== 'UNAVAILABLE' ||
        options.reconnect === undefined
      ) {
        if (current.failure() !== undefined) publish('disconnected');
        watch.refused?.(error);
        return;
      }
      void reconnect(error, current).catch((received) => {
        if (!(received instanceof KernelError)) throw received;
        watch.refused?.(received);
      });
    });
    // Reconnect readiness is observed by the original stable owner below.
    void watch.subscription.ready.catch(() => {});
  }

  /** Keep initial readiness attached to its live coverage owner through a transport replacement. */
  async function watchReady(watch: Watch): Promise<void> {
    while (!watch.closed) {
      const current = client;
      const subscription = watch.subscription;
      if (subscription === undefined)
        throw new KernelError('INVALID', 'Missing owned subscription');
      try {
        await subscription.ready;
        return;
      } catch (error) {
        if (
          !(error instanceof KernelError) ||
          error.code !== 'UNAVAILABLE' ||
          current.failure()?.code !== 'UNAVAILABLE'
        )
          throw error;
        await reconnect(error, current);
      }
    }
    throw new KernelError('CANCELLED', 'Subscription closed');
  }

  return {
    connection: {
      getSnapshot: () => state,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    cache,
    get ready() {
      return admitted().then((current) => current.ready);
    },
    key,
    failure: () => closed ?? (options.reconnect === undefined ? client.failure() : undefined),
    read(selector) {
      return admitted().then((current) => current.read(selector));
    },
    act(input) {
      return request({ act: { ...input, opId: input.opId ?? key() } });
    },
    commit(input) {
      return request({ commit: { ...input, opId: input.opId ?? key() } });
    },
    sub(selector, changed, refused) {
      available();
      const watch: Watch = { selector: structuredClone(selector), changed, refused, closed: false };
      watches.add(watch);
      startWatch(watch);
      const subscription = watch.subscription;
      if (subscription === undefined)
        throw new KernelError('INVALID', 'Missing owned subscription');

      return {
        get id() {
          return watch.subscription?.id ?? subscription.id;
        },
        ready: watchReady(watch),
        close() {
          if (watch.closed) return;
          watch.closed = true;
          watches.delete(watch);
          watch.subscription?.close();
        },
      };
    },
    cancel,
    close(reason) {
      if (closed !== undefined) return;
      closed = reason ?? new KernelError('CANCELLED', 'Lane owner closed');
      publish('disconnected');
      lifetime.abort(closed);
      for (const watch of watches) {
        watch.closed = true;
        watch.subscription?.close();
      }
      watches.clear();
      for (const operation of operations.values()) {
        operation.channel.end(closed);
        operation.reject(closed);
      }
      operations.clear();
      client.close(closed);
    },
  };
}
