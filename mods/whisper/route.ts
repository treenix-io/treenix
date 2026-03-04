// Whisper audio transcription — HTTP handler
// POST ?id=channel-id with audio body → create node immediately, transcribe in background, update node

import { type AutomaticSpeechRecognitionPipeline, pipeline } from '@huggingface/transformers';
import { newComp } from '@treenity/core/comp';
import { createNode } from '@treenity/core/core';
import type { Tree } from '@treenity/core/tree';
import { execFile } from 'node:child_process';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { type IncomingMessage, type ServerResponse } from 'node:http';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import WaveFile from 'wavefile';
import { WhisperAudio, WhisperChecklist, WhisperMeta, WhisperText } from './types';

const execFileAsync = promisify(execFile);

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

export type WhisperRouteConfig = {
  nodePath: string;
  model: string;
  language: string;
  audioDir: string;
};

export function createWhisperHandler(cfg: WhisperRouteConfig) {
  const audioDir = resolve(cfg.audioDir);

  // Pre-warm the pipeline
  getTranscriber(cfg.model);

  return async (req: IncomingMessage, res: ServerResponse, store: Tree) => {
    if (req.method !== 'POST') {
      return respond(res, 405, { error: 'Method not allowed' });
    }

    const url = new URL(req.url ?? '/', 'http://localhost');
    const id = url.searchParams.get('id');
    if (!id) {
      return respond(res, 400, { error: 'Missing ?id= query parameter' });
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);

    if (body.length === 0) {
      return respond(res, 400, { error: 'Empty request body' });
    }

    const mime = req.headers['content-type'] || 'audio/wav';
    const ext = mime.includes('mp3') ? 'mp3'
      : mime.includes('ogg') ? 'ogg'
      : mime.includes('webm') ? 'webm'
      : mime.includes('m4a') ? 'm4a'
      : 'wav';

    const noteId = timeId();
    const filename = `${id}-${noteId}.${ext}`;
    const filePath = join(audioDir, filename);
    const wavPath = join(audioDir, `${id}-${noteId}_16k.wav`);

    try {
      await mkdir(audioDir, { recursive: true });
      await writeFile(filePath, body);

      // Ensure {servicePath}/{id} dir exists
      const idDirPath = `${cfg.nodePath}/${id}`;
      if (!(await store.get(idDirPath))) {
        await store.set(createNode(idDirPath, 'whisper.channel', {}, {
          checklist: newComp(WhisperChecklist, {}),
        }));
      }

      // 1. Create node immediately with audio — appears in tree right away
      const nodePath = `${idDirPath}/${noteId}`;
      const node = createNode(nodePath, 'whisper.transcription', {}, {
        audio: newComp(WhisperAudio, { filename, size: body.length, mime }),
        text: newComp(WhisperText, { content: '...' }),
        meta: newComp(WhisperMeta, {
          model: cfg.model,
          language: cfg.language,
          duration: 0,
          segments: 0,
          transcribedAt: Date.now(),
        }),
      });
      await store.set(node);
      console.log(`[whisper] ${filename} → ${nodePath} (processing...)`);

      // 2. Respond immediately — client sees the node path
      respond(res, 200, { path: nodePath, status: 'processing' });

      // 3. Transcribe in background, update node when done
      execFileAsync('ffmpeg', ['-i', filePath, '-ar', '16000', '-ac', '1', '-f', 'wav', '-y', wavPath])
        .then(() => readWavAsFloat32(wavPath))
        .then(async (audioData) => {
          const transcriber = await getTranscriber(cfg.model);
          const result = await transcriber(audioData, {
            language: cfg.language,
            return_timestamps: true,
          });

          const output = Array.isArray(result) ? result[0] : result;
          const text = (output.text ?? '').trim();
          const outputChunks = (output as any).chunks as Array<{ text: string; timestamp: [number, number | null] }> | undefined;

          const duration = outputChunks?.length
            ? (outputChunks[outputChunks.length - 1].timestamp[1] ?? 0)
            : 0;

          const updated = await store.get(nodePath);
          if (!updated) return;
          updated.text = newComp(WhisperText, { content: text });
          updated.meta = newComp(WhisperMeta, {
            model: cfg.model,
            language: cfg.language,
            duration,
            segments: outputChunks?.length ?? 0,
            transcribedAt: Date.now(),
          });
          await store.set(updated);
          console.log(`[whisper] ${nodePath} done (${outputChunks?.length ?? 0} seg, ${duration}s)`);
        })
        .catch((err) => console.error(`[whisper] ${nodePath} transcription failed:`, err))
        .finally(() => {
          unlink(wavPath).catch(() => {});
        });

    } catch (err) {
      console.error('[whisper] transcription error:', err);
      respond(res, 500, { error: String(err) });
    }
  };
}
