import { admitForeignFrames } from '#kernel/authority/frame-admission';
import { createActionControl } from '#kernel/action-context';
import { createTwpClient, type TwpClient } from '#client/twp';
import { KernelError } from '#errors';
import type { AuthAdmission } from '#kernel/auth-factory';
import type { Limits, OpenedAuthority, OpenedFederationConnection } from '#kernel/types';

export interface FederationClient {
  readonly client: TwpClient;
  active(): void;
  check(): Promise<void>;
  close(): Promise<void>;
}

interface FederationOwnerOptions {
  readonly authority: Extract<OpenedAuthority, { readonly kind: 'federation' }>;
  readonly admission: AuthAdmission;
  readonly limits: () => Limits;
  readonly observe: (listener: () => void) => () => void;
}

/** Active client resources belong to one immutable declaring-node activation. */
export function createFederationOwner(options: FederationOwnerOptions) {
  const clients = new Set<FederationClient>();
  const admitted = new WeakMap<AuthAdmission, FederationClient>();
  const opening = new Map<AuthAdmission, Promise<FederationClient>>();
  const controls = new Set<ReturnType<typeof createActionControl>>();
  let closed = false,
    dirty = false,
    generation = 0;
  let checking: Promise<void> | undefined;
  let closing: Promise<void> | undefined;

  async function recheck(): Promise<void> {
    while (dirty && !closed) {
      dirty = false;
      const results = await Promise.allSettled([...clients].map((client) => client.check()));
      for (const result of results)
        if (result.status === 'rejected') {
          if (!(result.reason instanceof KernelError)) console.error(result.reason);
        }
    }
  }
  function startCheck(): void {
    if (checking === undefined)
      checking = recheck().finally(() => {
        checking = undefined;
        if (dirty && !closed) startCheck();
      });
  }
  const unsubscribe = options.observe(() => {
    if (closed) return;
    generation++;
    if (clients.size === 0) return;
    dirty = true;
    startCheck();
  });
  const abort = () => {
    void close().catch((error) => console.error(error));
  };
  options.admission.signal.addEventListener('abort', abort, { once: true });

  function close(): Promise<void> {
    return (closing ??= release());
  }
  async function release(): Promise<void> {
    closed = true;
    for (const control of controls) control.close();
    unsubscribe();
    options.admission.signal.removeEventListener('abort', abort);
    const results = await Promise.allSettled([...clients].map((client) => client.close()));
    await checking;
    const errors: unknown[] = [];
    for (const result of results)
      if (result.status === 'rejected') {
        console.error(result.reason);
        errors.push(result.reason);
      }
    if (errors.length !== 0) throw new AggregateError(errors, 'Federation client release failed');
  }

  /** Opening and every fresh send validate the captured credential generation. */
  async function acquire(local: AuthAdmission): Promise<FederationClient> {
    local.assertActive();
    options.admission.assertActive();
    if (closed) throw new KernelError('UNAVAILABLE', 'Federation activation is closed');
    const control = createActionControl(local, Date.now() + options.limits().queryMs, () =>
      options.admission.assertActive(),
    );
    controls.add(control);
    let connection: OpenedFederationConnection;
    try {
      const opened = options.authority.open(control.signal);
      try {
        connection = await control.wait(opened);
      } catch (error) {
        void opened.then(
          (late) => late.close(),
          (error) => console.error(error),
        );
        throw error;
      }
    } catch (error) {
      controls.delete(control);
      control.close();
      throw error;
    }
    let releasing: Promise<void> | undefined;
    let handle: FederationClient | undefined,
      checked = -1;
    function active(): void {
      local.assertActive();
      options.admission.assertActive();
      const failed = client.failure();
      if (failed !== undefined) throw failed;
      if (closed || releasing !== undefined)
        throw new KernelError('CANCELLED', 'Federation client is closed');
      if (checked !== generation)
        throw new KernelError('CONFLICT', 'Federation authorization changed before delivery');
      const failure = client.failure();
      if (failure !== undefined) throw failure;
    }
    const guarded = {
      frames: connection.frames,
      send(request: Parameters<OpenedFederationConnection['send']>[0]) {
        if (
          request.t !== 'cancel' &&
          request.t !== 'unsub' &&
          request.t !== 'hi' &&
          checked !== generation
        )
          throw new KernelError('CONFLICT', 'Federation authorization changed before send');
        connection.send(request);
      },
    };
    const client = createTwpClient(
      admitForeignFrames(guarded, options.limits, (id) => client.cache.copy(id)),
      {
        maxRequests: options.limits().laneRequests,
        onError: () => {
          void handle?.close().catch((error) => console.error(error));
        },
        close: () => {
          void connection.close().catch((error) => console.error(error));
        },
      },
    );
    const abortLocal = () => {
      void handle?.close().catch((error) => console.error(error));
    };
    const owned: FederationClient = {
      client,
      active,
      close: () =>
        (releasing ??= Promise.resolve().then(async () => {
          clients.delete(owned);
          if (admitted.get(local) === owned) admitted.delete(local);
          local.signal.removeEventListener('abort', abortLocal);
          client.close();
          await connection.close();
        })),
      async check() {
        try {
          options.admission.assertActive();
          local.assertActive();
          const failed = client.failure();
          if (failed !== undefined) throw failed;
          if (closed || releasing !== undefined)
            throw new KernelError('CANCELLED', 'Federation client is closed');
          const before = generation;
          await connection.check();
          if (generation !== before)
            throw new KernelError('CONFLICT', 'Federation authorization changed during validation');
          checked = before;
          options.admission.assertActive();
          local.assertActive();
          const after = client.failure();
          if (after !== undefined) throw after;
          if (closed || releasing !== undefined)
            throw new KernelError('CANCELLED', 'Federation client is closed');
        } catch (error) {
          if (error instanceof KernelError && error.code === 'CONFLICT') throw error;
          await owned.close();
          throw error;
        }
      },
    };
    handle = owned;
    clients.add(owned);
    local.signal.addEventListener('abort', abortLocal, { once: true });
    try {
      await control.wait(client.ready);
      await control.wait(owned.check());
      admitted.set(local, owned);
      return owned;
    } catch (error) {
      await owned.close();
      throw error;
    } finally {
      controls.delete(control);
      control.close();
    }
  }
  function open(local: AuthAdmission): Promise<FederationClient> {
    local.assertActive();
    const retained = admitted.get(local);
    if (retained !== undefined) return Promise.resolve(retained);
    const pending = opening.get(local);
    if (pending !== undefined) return pending;
    const opened = acquire(local).finally(() => {
      opening.delete(local);
    });
    opening.set(local, opened);
    return opened;
  }
  return { open, close };
}
