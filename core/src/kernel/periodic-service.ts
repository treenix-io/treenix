import { randomUUID } from 'node:crypto';
import { KernelError } from '#errors';
import { createLaneCache } from '#client/lane-cache';
import type { Node, ServiceRun, Session } from '#kernel/types';

export interface PeriodicAction {
  readonly path: string;
  readonly action: string;
  readonly interval: (node: Node) => number;
  readonly enabled: (node: Node) => boolean;
  readonly immediate?: boolean;
}

/** Own one configuration subscription, timer and sequential native action request. */
export async function runPeriodicAction(
  session: Session,
  options: PeriodicAction,
): Promise<ServiceRun> {
  const cache = createLaneCache(),
    sub = session.sub({ node: options.path });
  let epoch: string | undefined,
    stopping = false,
    enabled = false,
    interval = 0;
  let timer: ReturnType<typeof setTimeout> | undefined, work: Promise<void> | undefined;
  let request: string | undefined, configuration: string | undefined;
  let resolveReady = () => {},
    rejectReady = (_error: unknown) => {},
    fail = (_error: unknown) => {};
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const failure = new Promise<never>((_resolve, reject) => {
    fail = reject;
  });
  void failure.catch(() => {});

  /** Schedule only after the preceding request has completely drained. */
  function schedule(delay = interval): void {
    if (stopping || !enabled || work !== undefined) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      const task = tick();
      work = task;
      void task.then(
        () => {
          work = undefined;
          schedule();
        },
        (error) => {
          work = undefined;
          if (stopping || (!enabled && error instanceof KernelError && error.code === 'CANCELLED'))
            return;
          rejectReady(error);
          fail(error);
        },
      );
    }, delay);
  }

  /** Drain streaming pieces while the lane pump delivers their accepted steps. */
  async function tick(): Promise<void> {
    if (epoch === undefined) throw new KernelError('UNAVAILABLE', 'Periodic service has no intake');
    const pending = session.act({
      path: options.path,
      action: options.action,
      args: {},
      opId: { epoch, time: Date.now(), nonce: randomUUID() },
    });
    request = pending.id;
    try {
      for await (const _piece of pending.chunks) {
      }
      await pending.outcome;
    } finally {
      request = undefined;
    }
  }

  /** React only to scheduling settings, so an action's own state updates cannot create a busy loop. */
  function refresh(): void {
    const copy = cache.at(options.path);
    if (copy === undefined)
      throw new KernelError('NOT_FOUND', 'Periodic service configuration disappeared');
    if ('error' in copy) throw copy.error;
    const nextEnabled = options.enabled(copy.node),
      nextInterval = options.interval(copy.node);
    if (!Number.isFinite(nextInterval) || nextInterval <= 0)
      throw new KernelError('INVALID', 'Periodic service interval must be positive');
    const key = JSON.stringify([nextEnabled, nextInterval]);
    if (key === configuration) return;
    configuration = key;
    enabled = nextEnabled;
    interval = nextInterval;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (!enabled && request !== undefined) session.cancel(request);
    schedule(options.immediate ? 0 : interval);
  }

  const pump = (async () => {
    for await (const frame of session.lane) {
      cache.apply(frame);
      if (frame.t === 'welcome') epoch = frame.intake;
      if (frame.t === 'pos' && frame.coverage !== true && frame.intake !== undefined)
        epoch = frame.intake;
      if (frame.t === 'end' && frame.sub === sub) throw frame.error;
      if (
        (frame.t === 'snap' && frame.sub === sub) ||
        (frame.t === 'pos' && configuration !== undefined)
      )
        refresh();
      if (frame.t === 'snap' && frame.sub === sub) resolveReady();
    }
    if (!stopping) throw new KernelError('CANCELLED', 'Periodic service lane ended');
  })();
  const done = Promise.race([pump, failure]);
  void done.catch(rejectReady);
  await ready;

  return {
    done,
    /** Join the timer and request after the owning node session has closed. */
    async stop() {
      stopping = true;
      if (timer !== undefined) clearTimeout(timer);
      if (request !== undefined) session.cancel(request);
      const results = await Promise.allSettled([pump, work ?? Promise.resolve()]);
      cache.clear();
      for (const result of results) {
        if (result.status !== 'rejected') continue;
        if (
          result.reason instanceof KernelError &&
          (result.reason.code === 'CANCELLED' || result.reason.code === 'UNAUTHENTICATED')
        )
          continue;
        throw result.reason;
      }
    },
  };
}
