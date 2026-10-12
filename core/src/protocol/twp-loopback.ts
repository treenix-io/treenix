import { KernelError } from '#errors';
import type { InstanceFoundationWithAuth } from '#kernel/instance';
import type { CacheClaim, Credential, Request } from '#kernel/types';
import { createTwpServing } from '#protocol/serve';

export interface TwpLoopbackOptions {
  readonly origin: string;
  readonly credential?: Credential;
  readonly cache?: readonly CacheClaim[];
}

/** Open an in-process transport through the same authenticated admission as HTTP. */
export async function openTwpLoopback(
  instance: InstanceFoundationWithAuth,
  options: TwpLoopbackOptions,
) {
  const serving = createTwpServing(instance);
  try {
    const opened = await serving.open(
      { t: 'hi', credential: options.credential, cache: options.cache },
      options.credential,
      options.origin,
    );
    const credential = options.credential ?? opened.credential;
    const lane = serving.attach(opened.id, credential, options.origin);
    return {
      send(request: Request): void {
        if (Buffer.byteLength(JSON.stringify(request)) > instance.limits().requestBytes)
          throw new KernelError('BUDGET', 'Loopback request exceeds the byte limit');
        serving.dispatch(opened.id, credential, options.origin, [request]);
      },
      frames: {
        async *[Symbol.asyncIterator]() {
          try {
            yield* lane.frames;
          } finally {
            serving.close();
          }
        },
      },
      close(): void {
        serving.close();
      },
    };
  } catch (error) {
    serving.close();
    throw error;
  }
}
