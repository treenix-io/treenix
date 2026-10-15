import { randomUUID } from 'node:crypto';
import { getComponent } from '@treenx/core';
import { KernelError } from '@treenx/core/errors';
import type { NativeModuleHost } from '@treenx/core/kernel/manifest';
import type { TwpHttpRoutes } from '@treenx/core/server/http-routes';
import type { Node, ServiceHandler, WriteAction } from '@treenx/core/kernel/types';
import type { WhisperConfig } from './types';
import { ingestNativeAudio } from './native-ingest';
import { audioForm, readAudioUpload, type AudioUploads } from './native-upload';

declare module '@treenx/core/kernel/manifest' {
  interface NativeModuleHost {
    readonly httpRoutes?: TwpHttpRoutes;
  }
}

/** Select the actual stored config without importing legacy service registrations. */
export function whisperConfig(node: Node): WhisperConfig {
  const config = getComponent<WhisperConfig>(node, 'whisper.config');
  if (config === undefined) throw new KernelError('INVALID', 'Whisper configuration is absent');
  return config;
}

/** Route all uploads through the selected caller's native streaming action. */
export function ingestAction(uploads: AudioUploads): WriteAction {
  return {
    kind: 'write',
    io: true,
    args: {
      type: 'object',
      additionalProperties: false,
      required: ['channel', 'upload'],
      properties: {
        channel: { type: 'string', minLength: 1 },
        upload: { type: 'string', minLength: 1 },
      },
    },
    async *handler(context, input) {
      if (
        typeof input !== 'object' ||
        input === null ||
        !('channel' in input) ||
        typeof input.channel !== 'string' ||
        !('upload' in input) ||
        typeof input.upload !== 'string'
      )
        throw new KernelError('INVALID', 'Invalid audio upload');
      const settings = whisperConfig(context.node),
        target = settings.channels[input.channel];
      if (target === undefined)
        throw new KernelError('NOT_FOUND', 'Whisper channel is not configured');
      const { body, mime, language } = uploads.get(input.upload, context.caller.principal);
      return yield* ingestNativeAudio(
        context,
        language === undefined ? settings : { ...settings, language },
        body,
        mime,
        `${target}/${Date.now()}-${randomUUID()}`,
      );
    },
  };
}

/** Own the upload registration until its actual node service is retired. */
export function whisperService(host: NativeModuleHost, uploads: AudioUploads): ServiceHandler {
  return async (node, session) => {
    const settings = whisperConfig(node);
    if (host.httpRoutes === undefined)
      throw new KernelError('UNAVAILABLE', 'Whisper HTTP host is not bound');
    const dispose = host.httpRoutes.register(
      settings.url === '' ? node.$path : settings.url,
      async (request, response, caller) => {
        await caller.read({ node: node.$path });
        if (request.method === 'GET') {
          response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          response.end(audioForm());
          return;
        }
        if (request.method !== 'POST')
          throw new KernelError('INVALID', 'Audio upload requires POST');
        const channel =
          new URL(request.url ?? '/', 'http://localhost').searchParams.get('id') ?? 'default';
        if (settings.channels[channel] === undefined)
          throw new KernelError('NOT_FOUND', 'Unknown audio channel');
        const upload = uploads.add({
          ...(await readAudioUpload(request)),
          principal: caller.actor.principal,
        });
        try {
          const lane = caller.lane[Symbol.asyncIterator](),
            welcome = await lane.next();
          if (welcome.done || welcome.value.t !== 'welcome')
            throw new KernelError('UNAVAILABLE', 'Upload session did not open');
          const intake = welcome.value.intake;
          const delivery = (async () => {
            for await (const frame of { [Symbol.asyncIterator]: () => lane }) {
              if (frame.t === 'end') throw frame.error;
            }
          })();
          const action = (async () => {
            const pending = caller.act({
              path: node.$path,
              action: 'ingest',
              args: { channel, upload },
              opId: { epoch: intake, time: Date.now(), nonce: randomUUID() },
            });
            for await (const chunk of pending.chunks) {
              // The first accepted piece already contains the pending node; the request retains its action lifetime.
              void chunk;
            }
            const outcome = await pending.outcome;
            return outcome.value;
          })();
          const result = await Promise.race([
            action,
            delivery.then(() => {
              throw new KernelError('CANCELLED', 'Upload session ended');
            }),
          ]);
          if (request.headers.accept?.includes('text/html')) {
            response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            response.end(
              '<!doctype html><html lang="en"><meta charset="utf-8"><title>Audio saved — Treenix</title><main><h1>Audio saved and transcribed</h1><p>The organizer will process it in your inbox.</p><p><a href="/t/inbox">Open inbox</a> · <a href="">Upload another recording</a></p></main></html>',
            );
          } else {
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify(result));
          }
        } finally {
          uploads.remove(upload);
        }
      },
    );
    const done = (async () => {
      for await (const frame of session.lane)
        if (frame.t === 'end' || (frame.t === 'fail' && frame.req === undefined)) throw frame.error;
    })();
    return {
      done,
      async stop() {
        dispose();
        await done;
      },
    };
  };
}
