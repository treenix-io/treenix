import { KernelError } from '#errors';
import type { CacheClaim, Credential, Frame, Request } from '#kernel/types';
import { decodeFrame } from '#protocol/twp';

/** Use a dedicated port; its owner checks a Window origin before transferring it. */
export interface TwpMessagePort {
  postMessage(value: string): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(type: 'close', listener: () => void): void;
  removeEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: 'close', listener: () => void): void;
  start?(): void;
  close?(): void;
}

export interface TwpPortClientOptions {
  readonly credential?: Credential;
  readonly cache?: readonly CacheClaim[];
  readonly frameBytes?: number;
}

/** Open a native client transport with one demand-driven frame slot. */
export function createTwpPort(port: TwpMessagePort, options: TwpPortClientOptions = {}) {
  let controller: ReadableStreamDefaultController<Frame>;
  let pulled: (() => void) | undefined;
  let closed = false;

  /** Detach the port and complete any outstanding pull. */
  function release(): void {
    if (closed) return;
    closed = true;
    port.removeEventListener('message', receive);
    port.removeEventListener('close', close);
    try {
      port.postMessage('close');
    } finally {
      port.close?.();
      pulled?.();
    }
  }

  /** End the consumer before releasing its server-side lane. */
  function close(): void {
    if (closed) return;
    controller.close();
    release();
  }

  /** Publish only decoded frames; malformed wire terminates the consumer loudly. */
  function receive(event: { data: unknown }): void {
    try {
      if (event.data === 'closed') return close();
      if (typeof event.data !== 'string')
        throw new KernelError('INVALID', 'Port frames must be encoded');
      controller.enqueue(decodeFrame(event.data, options.frameBytes ?? 40 * 1024 * 1024));
      const completed = pulled;
      pulled = undefined;
      completed?.();
    } catch (error) {
      controller.error(error);
      release();
    }
  }

  const frames = new ReadableStream<Frame>(
    {
      start(output) {
        controller = output;
      },
      pull() {
        return new Promise<void>((done) => {
          pulled = done;
          port.postMessage('pull');
        });
      },
      cancel() {
        release();
      },
    },
    { highWaterMark: 0 },
  );
  port.addEventListener('message', receive);
  port.addEventListener('close', close);
  port.start?.();
  const hello: Request = { t: 'hi', credential: options.credential, cache: options.cache };
  port.postMessage(JSON.stringify(hello));

  return {
    frames: {
      async *[Symbol.asyncIterator]() {
        const reader = frames.getReader();
        try {
          for (;;) {
            const next = await reader.read();
            if (next.done) return;
            yield next.value;
          }
        } finally {
          reader.releaseLock();
          close();
        }
      },
    },
    send(request: Request): void {
      if (closed) throw new KernelError('UNAVAILABLE', 'Port is closed');
      port.postMessage(JSON.stringify(request));
    },
    close,
  };
}
