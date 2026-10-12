import { randomUUID } from 'node:crypto';
import { KernelError } from '#errors';
import type { ServiceRun, Session, SubSelector } from '#kernel/types';

export interface WatchedAction {
  readonly path: string;
  readonly action: string;
  readonly selector: SubSelector;
}

/** Own one subscription and a sequential, cancellable native action stream. */
export async function runWatchedAction(
  session: Session,
  options: WatchedAction,
): Promise<ServiceRun> {
  const sub = session.sub(options.selector);
  let epoch: string | undefined,
    stopping = false,
    requested = false;
  let work: Promise<void> | undefined, requestId: string | undefined;
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

  /** Reconcile accepted source changes with fresh native reads inside the owning action. */
  async function reconcile(): Promise<void> {
    while (requested && !stopping) {
      requested = false;
      if (epoch === undefined)
        throw new KernelError('UNAVAILABLE', 'Watched service has no intake');
      const pending = session.act({
        path: options.path,
        action: options.action,
        args: {},
        opId: { epoch, time: Date.now(), nonce: randomUUID() },
      });
      requestId = pending.id;
      try {
        for await (const _piece of pending.chunks) {
        }
        await pending.outcome;
      } catch (error) {
        if (!(error instanceof KernelError) || error.code !== 'CONFLICT') throw error;
        // A caller can change a watched node during a scan; reconcile again from fresh reads.
        requested = true;
        continue;
      } finally {
        requestId = undefined;
      }
      resolveReady();
    }
  }

  /** Coalesce source changes while keeping native action delivery outside the lane pump. */
  function request(): void {
    requested = true;
    if (work !== undefined || stopping) return;
    const current = reconcile();
    work = current;
    void current.then(
      () => {
        work = undefined;
        if (requested && !stopping) request();
      },
      (error) => {
        rejectReady(error);
        fail(error);
      },
    );
  }

  const pump = (async () => {
    for await (const frame of session.lane) {
      if (frame.t === 'welcome') epoch = frame.intake;
      if (frame.t === 'pos' && frame.coverage !== true && frame.intake !== undefined)
        epoch = frame.intake;
      if (frame.t === 'end' || (frame.t === 'fail' && frame.req === undefined)) throw frame.error;
      if (
        (frame.t === 'snap' && frame.sub === sub) ||
        (frame.t === 'pos' && frame.coverage !== true && frame.changes.length !== 0)
      )
        request();
    }
    if (!stopping) throw new KernelError('CANCELLED', 'Watched service lane ended');
  })();
  const done = Promise.race([pump, failure]);
  void done.catch(rejectReady);
  await ready;

  return {
    done,
    async stop() {
      stopping = true;
      if (requestId !== undefined) session.cancel(requestId);
      const results = await Promise.allSettled([pump, work ?? Promise.resolve()]);
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
