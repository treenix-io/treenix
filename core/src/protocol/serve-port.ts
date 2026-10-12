import { KernelError } from '#errors';
import type { InstanceFoundationWithAuth } from '#kernel/instance';
import type { Frame } from '#kernel/types';
import type { TwpMessagePort } from '#protocol/twp-port';
import { openTwpLoopback } from '#protocol/twp-loopback';
import { decodeRequests, encodeFrame } from '#protocol/twp';

/** Keep native lane output behind explicit consumer pulls across a dedicated MessagePort. */
export function serveTwpPort(
  instance: InstanceFoundationWithAuth,
  port: TwpMessagePort,
  origin: string,
) {
  let opening: Promise<Awaited<ReturnType<typeof openTwpLoopback>>> | undefined;
  let iterator: AsyncIterator<Frame> | undefined;
  let connection: Awaited<ReturnType<typeof openTwpLoopback>> | undefined;
  let closed = false;
  let pulling = false;

  /** Release this port's lane and listeners without closing other instance transports. */
  function close(): void {
    if (closed) return;
    closed = true;
    connection?.close();
    port.removeEventListener('message', receive);
    port.removeEventListener('close', close);
    port.close?.();
  }

  /** Return a binding refusal before releasing its resources. */
  function fail(error: unknown): void {
    if (closed) return;
    const refusal =
      error instanceof KernelError
        ? error
        : new KernelError('UNAVAILABLE', error instanceof Error ? error.message : String(error));
    try {
      port.postMessage(encodeFrame({ t: 'fail', error: refusal }));
    } finally {
      close();
    }
  }

  /** Decode the public wire before admission or any request effect. */
  async function dispatch(data: unknown): Promise<void> {
    if (typeof data !== 'string') throw new KernelError('INVALID', 'Port messages must be encoded');
    if (data === 'close') return close();
    if (data === 'pull') {
      if (opening === undefined || pulling) throw new KernelError('INVALID', 'Invalid port pull');
      pulling = true;
      try {
        await opening;
        if (iterator === undefined) throw new KernelError('UNAVAILABLE', 'Port lane is absent');
        const next = await iterator.next();
        if (closed) return;
        port.postMessage(next.done ? 'closed' : encodeFrame(next.value));
        if (next.done) close();
      } finally {
        pulling = false;
      }
      return;
    }

    const requests = decodeRequests(data, instance.limits().requestBytes);
    if (opening === undefined) {
      const hello = requests[0];
      if (requests.length !== 1 || hello?.t !== 'hi')
        throw new KernelError('INVALID', 'Port requires one handshake');
      opening = openTwpLoopback(instance, {
        origin,
        credential: hello.credential,
        cache: hello.cache,
      }).then((opened) => {
        if (closed) {
          opened.close();
          throw new KernelError('CANCELLED', 'Port closed during admission');
        }
        connection = opened;
        iterator = opened.frames[Symbol.asyncIterator]();
        return opened;
      });
      await opening;
    } else {
      if (requests.some((request) => request.t === 'hi'))
        throw new KernelError('INVALID', 'Port handshake is already complete');
      const opened = await opening;
      for (const request of requests) opened.send(request);
    }
  }

  /** Route each message to its native request or output slot. */
  function receive(event: { data: unknown }): void {
    void dispatch(event.data).catch(fail);
  }

  port.addEventListener('message', receive);
  port.addEventListener('close', close);
  port.start?.();
  return { close };
}
