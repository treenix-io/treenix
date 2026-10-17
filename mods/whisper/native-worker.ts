import { parentPort } from 'node:worker_threads';
import { getTranscriber, readWavAsFloat32 } from './audio';
import type { RecognitionJob, RecognitionReply } from './native-recognizer';

if (parentPort === null) throw new Error('Whisper recognition requires a worker');
const port = parentPort;
port.on('message', async ({ wavPath, settings }: RecognitionJob) => {
  let reply: RecognitionReply;
  try {
    const samples = await readWavAsFloat32(wavPath);
    const transcriber = await getTranscriber(settings.model);
    const output = await transcriber(samples, {
      language: settings.language,
      return_timestamps: true,
    });
    reply = {
      ok: true,
      result: {
        content: output.text.trim(),
        duration: output.chunks?.at(-1)?.timestamp[1] ?? 0,
        segments: output.chunks?.length ?? 0,
      },
    };
  } catch (error) {
    reply = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  port.postMessage(reply);
});
