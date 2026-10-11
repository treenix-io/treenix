import { randomUUID } from 'node:crypto';
import { getComponent } from '@treenx/core';
import { KernelError } from '@treenx/core/errors';
import type { NativeModuleHost } from '@treenx/core/kernel/manifest';
import type { Node, ServiceHandler, WriteAction } from '@treenx/core/kernel/types';
import { drainSession } from '@treenx/core/kernel/session-delivery';
import type { WhisperConfig } from './types';
import { ingestNativeAudio } from './native-ingest';

/** Select the actual stored config without importing legacy service registrations. */
export function whisperConfig(node: Node): WhisperConfig {
  const config = getComponent<WhisperConfig>(node, 'whisper.config');
  if (config === undefined) throw new KernelError('INVALID', 'Whisper configuration is absent');
  return config;
}

/** Route all uploads through the selected caller's native streaming action. */
export const ingestAction: WriteAction = {
  kind: 'write', io: true,
  args: { type: 'object', additionalProperties: false, required: ['channel', 'audio', 'mime'], properties: {
    channel: { type: 'string', minLength: 1 }, audio: { type: 'string', minLength: 1, pattern: '^[A-Za-z0-9+/]*={0,2}$' },
    mime: { type: 'string', minLength: 1 },
  } },
  async *handler(context, input) {
    if (typeof input !== 'object' || input === null || !('channel' in input) || typeof input.channel !== 'string'
      || !('audio' in input) || typeof input.audio !== 'string' || !('mime' in input) || typeof input.mime !== 'string')
      throw new KernelError('INVALID', 'Invalid audio upload');
    const settings = whisperConfig(context.node), target = settings.channels[input.channel];
    if (target === undefined) throw new KernelError('NOT_FOUND', 'Whisper channel is not configured');
    const body = Buffer.from(input.audio, 'base64');
    return yield* ingestNativeAudio(context, settings, body, input.mime, `${target}/${Date.now()}-${randomUUID()}`);
  },
};

/** Own the upload registration until its actual node service is retired. */
export function whisperService(host: NativeModuleHost): ServiceHandler {
  return async (node, session) => {
    const settings = whisperConfig(node);
    if (host.httpRoutes === undefined) throw new KernelError('UNAVAILABLE', 'Whisper HTTP host is not bound');
    const dispose = host.httpRoutes.register(settings.url === '' ? node.$path : settings.url, async (request, response, caller) => {
      if (request.method !== 'POST') throw new KernelError('INVALID', 'Audio upload requires POST');
      const channel = new URL(request.url ?? '/', 'http://localhost').searchParams.get('id');
      if (channel === null) throw new KernelError('INVALID', 'Audio upload requires a channel');
      const mime = request.headers['content-type'];
      if (mime === undefined) throw new KernelError('INVALID', 'Audio upload requires a MIME type');
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        const data: unknown = chunk;
        if (!Buffer.isBuffer(data)) throw new KernelError('INVALID', 'Audio upload requires binary data');
        size += data.length;
        if (size > 25 * 1024 * 1024) throw new KernelError('BUDGET', 'Audio upload exceeds the body limit');
        chunks.push(data);
      }
      const lane = caller.lane[Symbol.asyncIterator](), welcome = await lane.next();
      if (welcome.done || welcome.value.t !== 'welcome') throw new KernelError('UNAVAILABLE', 'Upload session did not open');
      const delivery = (async () => { for await (const frame of { [Symbol.asyncIterator]: () => lane }) {
        if (frame.t === 'end') throw frame.error;
      } })();
      try {
        const pending = caller.act({ path: node.$path, action: 'ingest', args: { channel, mime, audio: Buffer.concat(chunks).toString('base64') },
          opId: { epoch: welcome.value.intake, time: Date.now(), nonce: randomUUID() } });
        for await (const chunk of pending.chunks) {
          // The first accepted piece already contains the pending node; the request retains its action lifetime.
          void chunk;
        }
        const outcome = await pending.outcome;
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(outcome.value));
      } finally { caller.close(); await delivery; }
    });
    const done = drainSession(session);
    return { done, async stop() { dispose(); await done; } };
  };
}
