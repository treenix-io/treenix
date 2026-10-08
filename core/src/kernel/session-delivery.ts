import { KernelError } from '#errors'
import type { NodeLane } from '#kernel/lane'

/** Pulls a hidden session's real lane so Pending outcomes obey ordinary delivery ordering. */
export function drainSession(session: NodeLane): Promise<void> {
  const delivery = (async () => {
    for await (const _frame of session.lane) {
    }
  })();
  void delivery.catch((error) => {
    if (!(error instanceof KernelError)) console.error(error);
    session.close(
      error instanceof KernelError
        ? error
        : new KernelError('UNAVAILABLE', 'Session delivery failed'),
    );
  });
  return delivery;
}
