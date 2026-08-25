// Whisper audio transcription — ingest core + HTTP handler
// ingestAudio(): create node immediately, transcribe in background, update node.
// HTTP: POST ?id=channel with audio body; Bearer auth from env, channel map from config (fail closed).

import { type AutomaticSpeechRecognitionPipeline, pipeline } from '@huggingface/transformers';
import { createNode } from '@treenx/core';
import { newComponent } from '@treenx/core/comp';
import type { Tree } from '@treenx/core/tree';
import { execFile } from 'node:child_process';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { type IncomingMessage, type ServerResponse } from 'node:http';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import WaveFile from 'wavefile';
import { WhisperAudio, WhisperChecklist, WhisperMeta, WhisperText } from './types';

const execFileAsync = promisify(execFile);

const MAX_BODY = 25 * 1024 * 1024;

// MIME allowlist → file extension; anything else is rejected at the route
const MIME_EXT: Array<[string, string]> = [
  ['mpeg', 'mp3'], ['mp3', 'mp3'],
  ['ogg', 'ogg'], ['opus', 'ogg'],
  ['webm', 'webm'],
  ['m4a', 'm4a'], ['mp4', 'm4a'], ['aac', 'm4a'],
  ['wav', 'wav'], ['x-wav', 'wav'],
];

// Lazy-initialized pipelines keyed by model name
const pipelines = new Map<string, Promise<AutomaticSpeechRecognitionPipeline>>();

function getTranscriber(model: string): Promise<AutomaticSpeechRecognitionPipeline> {
  let p = pipelines.get(model);
  if (!p) {
    const modelId = model.includes('/') ? model : `onnx-community/whisper-${model}`;
    console.log(`[whisper] loading model ${modelId}...`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pipeline() union type is too complex for TS
    p = (pipeline as any)('automatic-speech-recognition', modelId, {
      dtype: {
        encoder_model: 'fp32',
        decoder_model_merged: 'q4',
      },
    }) as Promise<AutomaticSpeechRecognitionPipeline>;
    p.then(() => console.log(`[whisper] model ${modelId} ready`))
      .catch((e: unknown) => {
        console.error(`[whisper] model ${modelId} failed:`, e);
        pipelines.delete(model); // allow retry on next request
      });
    pipelines.set(model, p);
  }
  return p;
}

function respond(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

// Sortable time-based id: YYYYMMDD-HHmmss-SSS
function timeId(): string {
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${pad(d.getMilliseconds(), 3)}`;
}

/** Read 16kHz mono WAV file → Float32Array for transformers.js */
async function readWavAsFloat32(wavPath: string): Promise<Float32Array> {
  const buf = await readFile(wavPath);
  const wav = new WaveFile.WaveFile(buf);
  wav.toBitDepth('32f');
  wav.toSampleRate(16000);
  let samples = wav.getSamples();
  if (Array.isArray(samples)) samples = samples[0];
  return new Float32Array(samples);
}

export type IngestOpts = {
  model: string;
  language: string;
  audioDir: string;
  /** Dir the transcription node is created under; created as whisper.channel if missing */
  targetPath: string;
  /** Filename prefix, e.g. channel id or 'tg' */
  prefix: string;
  mime: string;
  /** Deterministic node id (idempotency key); default = timeId() */
  noteId?: string;
};

/**
 * Save audio, create transcription node immediately, transcribe in background.
 * Returns node path. Idempotent per noteId: existing node is returned untouched.
 */
export async function ingestAudio(tree: Tree, opts: IngestOpts, body: Buffer, ext: string): Promise<string> {
  const audioDir = resolve(opts.audioDir);
  const noteId = opts.noteId ?? timeId();
  const nodePath = `${opts.targetPath}/${noteId}`;

  const existing = await tree.get(nodePath);
  if (existing) return nodePath;

  const filename = `${opts.prefix}-${noteId}.${ext}`;
  const filePath = join(audioDir, filename);
  const wavPath = join(audioDir, `${opts.prefix}-${noteId}_16k.wav`);

  await mkdir(audioDir, { recursive: true });
  await writeFile(filePath, body);

  if (!(await tree.get(opts.targetPath))) {
    await tree.set(createNode(opts.targetPath, 'whisper.channel', {}, {
      checklist: newComponent(WhisperChecklist, {}),
    }));
  }

  // 1. Node appears in tree right away, text pending
  await tree.set(createNode(nodePath, 'whisper.transcription', {}, {
    audio: newComponent(WhisperAudio, { filename, size: body.length, mime: opts.mime }),
    text: newComponent(WhisperText, { content: '...' }),
    meta: newComponent(WhisperMeta, {
      model: opts.model,
      language: opts.language,
      duration: 0,
      segments: 0,
      transcribedAt: Date.now(),
      error: '',
    }),
  }));
  console.log(`[whisper] ${filename} → ${nodePath} (processing...)`);

  // 2. Transcribe in background, update node when done; failure lands in #meta.error, never silent
  execFileAsync('ffmpeg', ['-i', filePath, '-ar', '16000', '-ac', '1', '-f', 'wav', '-y', wavPath])
    .then(() => readWavAsFloat32(wavPath))
    .then(async (audioData) => {
      const transcriber = await getTranscriber(opts.model);
      const result = await transcriber(audioData, {
        language: opts.language,
        return_timestamps: true,
      });

      const output = Array.isArray(result) ? result[0] : result;
      const text = (output.text ?? '').trim();
      const outputChunks = (output as any).chunks as Array<{ text: string; timestamp: [number, number | null] }> | undefined;

      const duration = outputChunks?.length
        ? (outputChunks[outputChunks.length - 1].timestamp[1] ?? 0)
        : 0;

      const updated = await tree.get(nodePath);
      if (!updated) return;
      updated.text = newComponent(WhisperText, { content: text });
      updated.meta = newComponent(WhisperMeta, {
        model: opts.model,
        language: opts.language,
        duration,
        segments: outputChunks?.length ?? 0,
        transcribedAt: Date.now(),
        error: '',
      });
      await tree.set(updated);
      console.log(`[whisper] ${nodePath} done (${outputChunks?.length ?? 0} seg, ${duration}s)`);
    })
    .catch(async (err) => {
      console.error(`[whisper] ${nodePath} transcription failed:`, err);
      const failed = await tree.get(nodePath);
      if (!failed) return;
      failed.meta = newComponent(WhisperMeta, {
        model: opts.model, language: opts.language, duration: 0, segments: 0,
        transcribedAt: Date.now(), error: String(err),
      });
      await tree.set(failed).catch((e: unknown) => console.error(`[whisper] ${nodePath} error write failed:`, e));
    })
    .finally(() => {
      // ENOENT expected when ffmpeg failed before writing the wav
      unlink(wavPath).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== 'ENOENT') console.error(`[whisper] wav cleanup failed:`, e);
      });
    });

  return nodePath;
}

export function extForMime(mime: string): string | null {
  for (const [key, ext] of MIME_EXT) if (mime.includes(key)) return ext;
  return null;
}

export type WhisperRouteConfig = {
  nodePath: string;
  model: string;
  language: string;
  audioDir: string;
  /** Channel id → target dir; ids not listed are rejected (fail closed) */
  channels: Record<string, string>;
};

export function createWhisperHandler(cfg: WhisperRouteConfig) {
  // Pre-warm the pipeline
  getTranscriber(cfg.model);

  return async (req: IncomingMessage, res: ServerResponse, tree: Tree) => {
    if (req.method !== 'POST') {
      return respond(res, 405, { error: 'Method not allowed' });
    }

    // Fail closed: no secret configured → route disabled
    const secret = process.env.WHISPER_ROUTE_SECRET;
    if (!secret) {
      console.error('[whisper] WHISPER_ROUTE_SECRET is not set — route disabled');
      return respond(res, 503, { error: 'Route not configured' });
    }
    if (req.headers.authorization !== `Bearer ${secret}`) {
      return respond(res, 401, { error: 'Unauthorized' });
    }

    const url = new URL(req.url ?? '/', 'http://localhost');
    const id = url.searchParams.get('id');
    if (!id) {
      return respond(res, 400, { error: 'Missing ?id= query parameter' });
    }
    const targetPath = cfg.channels[id];
    if (!targetPath) {
      return respond(res, 404, { error: `Unknown channel: ${id}` });
    }

    const mime = req.headers['content-type'] || '';
    const ext = extForMime(mime);
    if (!ext) {
      return respond(res, 415, { error: `Unsupported media type: ${mime}` });
    }

    const declared = Number(req.headers['content-length'] || 0);
    if (declared > MAX_BODY) {
      return respond(res, 413, { error: 'Payload too large' });
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY) {
        return respond(res, 413, { error: 'Payload too large' });
      }
      chunks.push(chunk as Buffer);
    }
    const body = Buffer.concat(chunks);
    if (body.length === 0) {
      return respond(res, 400, { error: 'Empty request body' });
    }

    try {
      const nodePath = await ingestAudio(tree, {
        model: cfg.model,
        language: cfg.language,
        audioDir: cfg.audioDir,
        targetPath,
        prefix: id,
        mime,
      }, body, ext);
      respond(res, 200, { path: nodePath, status: 'processing' });
    } catch (err) {
      console.error('[whisper] ingest error:', err);
      respond(res, 500, { error: String(err) });
    }
  };
}
