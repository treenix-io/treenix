import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { KernelError } from '@treenx/core/errors';
import type { Credential } from '@treenx/core/kernel/types';
import { extForMime } from './audio';

export interface AudioUpload {
  readonly principal: string;
  readonly body: Uint8Array;
  readonly mime: string;
  readonly language?: string;
}

/** Request-owned bytes stay outside JSON action arguments and expire with the HTTP request. */
export function audioUploads() {
  const pending = new Map<string, AudioUpload>();
  return {
    add(upload: AudioUpload): string {
      const key = randomUUID();
      pending.set(key, upload);
      return key;
    },
    get(key: string, principal: string): AudioUpload {
      const upload = pending.get(key);
      if (upload === undefined || upload.principal !== principal)
        throw new KernelError('FORBIDDEN', 'Audio upload is not owned by this caller');
      return upload;
    },
    remove(key: string) {
      pending.delete(key);
    },
  };
}
export type AudioUploads = ReturnType<typeof audioUploads>;

/** Accept either a browser form or the existing raw audio HTTP client. */
export async function readAudioUpload(request: IncomingMessage) {
  const contentType = request.headers['content-type'];
  if (contentType === undefined) throw new KernelError('INVALID', 'Audio MIME type is required');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    if (!Buffer.isBuffer(chunk)) throw new KernelError('INVALID', 'Binary upload required');
    size += chunk.length;
    if (size > 25 * 1024 * 1024) throw new KernelError('BUDGET', 'Audio upload exceeds 25 MB');
    chunks.push(chunk);
  }
  let body: Uint8Array = Buffer.concat(chunks),
    mime = contentType.split(';')[0].trim();
  let language =
    new URL(request.url ?? '/', 'http://localhost').searchParams.get('language') ?? undefined;
  let credential: Credential | undefined;
  if (mime === 'multipart/form-data') {
    const form = await new Response(Buffer.concat(chunks), {
      headers: { 'content-type': contentType },
    }).formData();
    const tokens = form.getAll('token');
    if (tokens.length !== 0) {
      if (tokens.length !== 1 || typeof tokens[0] !== 'string' || !/^\S+$/.test(tokens[0]))
        throw new KernelError('UNAUTHENTICATED', 'Invalid form credential');
      credential = { token: tokens[0] };
    }
    const file = form.get('audio');
    if (!(file instanceof File)) throw new KernelError('INVALID', 'Select an audio file');
    body = new Uint8Array(await file.arrayBuffer());
    mime = file.type;
    const selected = form.get('language');
    if (selected !== null) {
      if (typeof selected !== 'string')
        throw new KernelError('INVALID', 'Audio language must be text');
      language = selected;
    }
  }
  if (body.byteLength === 0 || extForMime(mime) === null)
    throw new KernelError('INVALID', 'A supported, nonempty audio file is required');
  if (language !== undefined && !/^[a-z]{2,3}$/.test(language))
    throw new KernelError('INVALID', 'Audio language must be a language code');
  return { body, mime, ...(language === undefined ? {} : { language }), credential };
}

export function audioForm(): string {
  return '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Audio inbox — Treenix</title><main><h1>Audio inbox</h1><p>Upload a recording. Treenix saves the original, transcribes it, and organizes it into notes and tasks.</p><form method="post" enctype="multipart/form-data"><label>Audio file (up to 25 MB) <input type="file" name="audio" accept="audio/*" required></label><p><label>Language <select name="language"><option value="ru">Russian</option><option value="en">English</option><option value="de">German</option><option value="fr">French</option><option value="es">Spanish</option></select></label></p><p><button type="submit">Upload and process</button></p></form><p>Keep this page open while transcription runs.</p><p><a href="/t/inbox">Open inbox</a> · <a href="/t/plan">Open plan</a></p></main></html>';
}
