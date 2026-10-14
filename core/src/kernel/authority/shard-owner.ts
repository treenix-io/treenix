import { isDeepStrictEqual } from 'node:util';
import { KernelError } from '#errors';
import { createActionControl } from '#kernel/action-context';
import type { AuthAdmission } from '#kernel/auth-factory';
import type { Limits, OpenedAuthority, ShardConnection, ShardEnvelope } from '#kernel/types';

export interface ShardClient {
  readonly connection: ShardConnection;
  active(): void;
  check(): Promise<void>;
  close(): Promise<void>;
}

interface ShardOwnerOptions {
  readonly authority: Extract<OpenedAuthority, { readonly kind: 'shard' }>;
  readonly admission: AuthAdmission;
  readonly limits: () => Limits;
  readonly envelope: (admission: AuthAdmission) => Promise<ShardEnvelope>;
  readonly observe: (listener: () => void) => () => void;
}

/** Owns one raw ordered connection per actual client admission without a projected cache. */
export function createShardOwner(options: ShardOwnerOptions) {
  const clients = new Map<AuthAdmission, ShardClient>();
  const opening = new Map<AuthAdmission, Promise<ShardClient>>();
  const controls = new Set<ReturnType<typeof createActionControl>>();
  let closed = false,
    generation = 0,
    dirty = false;
  let checking: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let instance: string | undefined;
  const unsubscribe = options.observe(() => {
    generation++;
    dirty = true;
    startCheck();
  });

  /** Revalidates affected actor prefixes without consuming source frames. */
  function startCheck(): void {
    if (checking !== undefined || closed) return;
    checking = (async () => {
      while (dirty && !closed) {
        dirty = false;
        const results = await Promise.allSettled(
          [...clients.values()].map(async (client) => {
            try {
              await client.check();
            } catch (error) {
              if (error instanceof KernelError && error.code === 'CONFLICT') return;
              await client.close();
              throw error;
            }
          }),
        );
        for (const result of results)
          if (result.status === 'rejected') console.error(result.reason);
      }
    })().finally(() => {
      checking = undefined;
      if (dirty && !closed) startCheck();
    });
  }
  const abort = () => {
    void close().catch((error) => console.error(error));
  };
  options.admission.signal.addEventListener('abort', abort, { once: true });

  /** Cancels acquisitions before releasing every accepted transport. */
  function close(): Promise<void> {
    return (closing ??= (async () => {
      closed = true;
      unsubscribe();
      options.admission.signal.removeEventListener('abort', abort);
      for (const control of controls) control.close();
      const results = await Promise.allSettled(
        [...clients.values()].map((client) => client.close()),
      );
      await Promise.allSettled(opening.values());
      await checking;
      const failures = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : [],
      );
      if (failures.length !== 0)
        throw new AggregateError(failures, 'Shard connections failed to close');
    })());
  }

  /** Uses the immutable actor envelope once, then updates only its above-mount rights prefix. */
  async function acquire(local: AuthAdmission): Promise<ShardClient> {
    local.assertActive();
    options.admission.assertActive();
    if (closed) throw new KernelError('UNAVAILABLE', 'Shard activation is closed');
    const control = createActionControl(local, Date.now() + options.limits().queryMs, () =>
      options.admission.assertActive(),
    );
    controls.add(control);
    const lifetime = new AbortController();
    const signal = AbortSignal.any([local.signal, options.admission.signal, lifetime.signal]);
    let connection: ShardConnection | undefined;
    try {
      const before = generation;
      let envelope = await control.wait(options.envelope(local));
      if (before !== generation)
        throw new KernelError('CONFLICT', 'Shard chain changed during acquisition');
      const opened = options.authority.connect(envelope, signal);
      try {
        connection = await control.wait(opened);
      } catch (error) {
        void opened.then(
          (late) => late.close(),
          (error) => console.error(error),
        );
        throw error;
      }
      if (instance !== undefined && instance !== connection.instance)
        throw new KernelError(
          'GENERATION',
          'Shard instance changed under its accepted declaration',
        );
      instance = connection.instance;
      const accepted = connection;
      let checked = before,
        releasing: Promise<void> | undefined;
      const aborted = () => {
        void owned.close().catch((error) => console.error(error));
      };
      const owned: ShardClient = {
        connection: accepted,
        active() {
          local.assertActive();
          options.admission.assertActive();
          if (closed || releasing !== undefined)
            throw new KernelError('CANCELLED', 'Shard connection is closed');
          if (checked !== generation)
            throw new KernelError('CONFLICT', 'Shard chain changed before delivery');
        },
        async check() {
          local.assertActive();
          options.admission.assertActive();
          if (closed || releasing !== undefined)
            throw new KernelError('CANCELLED', 'Shard connection is closed');
          if (checked === generation) return;
          const verifying = createActionControl(local, Date.now() + options.limits().queryMs, () =>
            options.admission.assertActive(),
          );
          controls.add(verifying);
          try {
            const current = generation;
            const next = await verifying.wait(options.envelope(local));
            if (next.modules !== envelope.modules)
              throw new KernelError('GENERATION', 'Shard module digest changed');
            if (!isDeepStrictEqual(next.actor, envelope.actor) || next.path !== envelope.path)
              throw new KernelError('UNAUTHENTICATED', 'Shard actor envelope changed');
            if (current !== generation)
              throw new KernelError('CONFLICT', 'Shard chain changed during validation');
            if (!isDeepStrictEqual(next.prefix, envelope.prefix)) accepted.update(next.prefix);
            envelope = next;
            checked = current;
            owned.active();
          } finally {
            controls.delete(verifying);
            verifying.close();
          }
        },
        close: () =>
          (releasing ??= Promise.resolve().then(async () => {
            clients.delete(local);
            local.signal.removeEventListener('abort', aborted);
            lifetime.abort(new KernelError('CANCELLED', 'Shard connection is closed'));
            await accepted.close();
          })),
      };
      clients.set(local, owned);
      local.signal.addEventListener('abort', aborted, { once: true });
      await control.wait(owned.check());
      owned.active();
      return owned;
    } catch (error) {
      lifetime.abort(error);
      const retained = clients.get(local);
      if (retained !== undefined) await retained.close();
      else if (connection !== undefined) await connection.close();
      throw error;
    } finally {
      controls.delete(control);
      control.close();
    }
  }

  function open(local: AuthAdmission): Promise<ShardClient> {
    local.assertActive();
    const retained = clients.get(local);
    if (retained !== undefined) return Promise.resolve(retained);
    const pending = opening.get(local);
    if (pending !== undefined) return pending;
    const acquired = acquire(local).finally(() => opening.delete(local));
    opening.set(local, acquired);
    return acquired;
  }
  return {
    open,
    close,
    get instance() {
      return instance;
    },
  };
}
