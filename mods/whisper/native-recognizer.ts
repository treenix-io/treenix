import { Worker } from 'node:worker_threads';
import { KernelError } from '@treenx/core/errors';
import type { ActionIoScope } from '@treenx/core/kernel/types';
import type { RecognizedAudio, WhisperSettings } from './native-io';

export interface RecognitionJob {
  readonly wavPath: string;
  readonly settings: WhisperSettings;
}
export type RecognitionReply =
  | { readonly ok: true; readonly result: RecognizedAudio }
  | { readonly ok: false; readonly error: string };

const workerUrl = new URL(
  import.meta.url.endsWith('.ts') ? './native-worker-bootstrap.ts' : './native-worker.js',
  import.meta.url,
);

/** Serialize inference in a reusable worker because ONNX's native run blocks its calling thread. */
export class WhisperRecognizer {
  private worker: Worker | undefined;
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly spawn: () => Worker = () => new Worker(workerUrl)) {}

  recognize(job: RecognitionJob, scope: ActionIoScope): Promise<RecognizedAudio> {
    const result = this.tail.then(() => this.run(job, scope));
    this.tail = result.then(
      () => {},
      (error: unknown) => console.error('[whisper] Recognition failed:', error),
    );
    return result;
  }

  async close(): Promise<void> {
    const worker = this.worker;
    this.worker = undefined;
    if (worker !== undefined) await worker.terminate();
  }

  private async run(job: RecognitionJob, scope: ActionIoScope): Promise<RecognizedAudio> {
    scope.assertActive();
    if (this.worker === undefined) {
      const worker = this.spawn();
      this.worker = worker;
      worker.on('error', (error: Error) => {
        console.error('[whisper] Worker failed:', error);
        if (this.worker === worker) this.worker = undefined;
      });
      worker.on('exit', () => {
        if (this.worker === worker) this.worker = undefined;
      });
    }
    const worker = this.worker;
    worker.ref();
    let abort = () => {};
    let reply = (_reply: RecognitionReply) => {};
    let failed = (_error: Error) => {};
    let exited = () => {};
    try {
      const result = await new Promise<RecognizedAudio>((resolve, reject) => {
        abort = () => reject(scope.signal.reason);
        reply = (message) =>
          message.ok
            ? resolve(message.result)
            : reject(new KernelError('UNAVAILABLE', message.error));
        failed = reject;
        exited = () =>
          reject(new KernelError('UNAVAILABLE', 'Whisper worker ended before its result'));
        worker.once('message', reply);
        worker.once('error', failed);
        worker.once('exit', exited);
        scope.signal.addEventListener('abort', abort, { once: true });
        if (scope.signal.aborted) abort();
        else worker.postMessage(job);
      });
      scope.assertActive();
      return result;
    } finally {
      scope.signal.removeEventListener('abort', abort);
      worker.removeListener('message', reply);
      worker.removeListener('error', failed);
      worker.removeListener('exit', exited);
      if (scope.signal.aborted && this.worker === worker) await this.close();
      worker.unref();
    }
  }
}
