import { type AutomaticSpeechRecognitionPipeline, pipeline } from '@huggingface/transformers';
import { readFile } from 'node:fs/promises';
import WaveFile from 'wavefile';

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

/** Share a lazy model between legacy and native ingestion. */
export function getTranscriber(model: string): Promise<AutomaticSpeechRecognitionPipeline> {
  let p = pipelines.get(model);
  if (!p) {
    const modelId = model.includes('/') ? model : `onnx-community/whisper-${model}`;
    console.log(`[whisper] loading model ${modelId}...`);
    p = pipeline<'automatic-speech-recognition'>('automatic-speech-recognition', modelId, {
      dtype: {
        encoder_model: 'fp32',
        decoder_model_merged: 'q4',
      },
    });
    p.then(() => console.log(`[whisper] model ${modelId} ready`))
      .catch((e: unknown) => {
        console.error(`[whisper] model ${modelId} failed:`, e);
        pipelines.delete(model); // allow retry on next request
      });
    pipelines.set(model, p);
  }
  return p;
}

/** Read 16kHz mono WAV file → Float32Array for transformers.js */
export async function readWavAsFloat32(wavPath: string): Promise<Float32Array> {
  const buf = await readFile(wavPath);
  const wav = new WaveFile.WaveFile(buf);
  wav.toBitDepth('32f');
  wav.toSampleRate(16000);
  let samples = wav.getSamples();
  if (Array.isArray(samples)) samples = samples[0];
  return new Float32Array(samples);
}

/** Resolve an admitted audio encoding before handing data to ffmpeg. */
export function extForMime(mime: string): string | null {
  for (const [key, ext] of MIME_EXT) if (mime.includes(key)) return ext;
  return null;
}

