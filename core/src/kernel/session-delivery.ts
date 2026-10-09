import { KernelError } from '#errors'
import type { NodeLane } from '#kernel/lane'

/** Orders direct Pending outcomes; their pieces stay with Pending.chunks, outside this pump. */
export function drainSession(session: NodeLane): Promise<void> {
  const delivery = (async () => {
    for await (const frame of session.lane) {
      if (frame.t === 'chunk')
        throw new KernelError('INVALID', 'Wire stream requires its own piece consumer');
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
