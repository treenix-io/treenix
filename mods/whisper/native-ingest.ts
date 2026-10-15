import { KernelError } from '@treenx/core/errors';
import type { WriteActionContext } from '@treenx/core/kernel/types';
import type { WhisperSettings } from './native-io';

/** Publish the pending transcript before recognition, then commit the result through the same caller. */
export async function* ingestNativeAudio(
  context: WriteActionContext,
  settings: WhisperSettings,
  body: Uint8Array,
  mime: string,
  path: string,
  components: Record<string, unknown> = {},
) {
  await context.requireReadWrite(path);
  const io = context.io?.whisper;
  if (io === undefined) throw new KernelError('UNAVAILABLE', 'Whisper I/O is not bound');
  const audio = await io.save(settings.audioDir, body, mime);
  const meta = {
    $type: 'whisper.meta',
    model: settings.model,
    language: settings.language,
    duration: 0,
    segments: 0,
    transcribedAt: Date.now(),
    error: '',
  };

  context.change.put({
    ...components,
    $path: path,
    $type: 'whisper.transcription',
    '#audio': { $type: 'whisper.audio', ...audio },
    '#text': { $type: 'whisper.text', content: '...' },
    '#meta': meta,
  });
  yield { path, status: 'pending' };

  try {
    const result = await io.recognize(settings, audio);
    context.change.patch(path, {
      $set: {
        '#text': { $type: 'whisper.text', content: result.content },
        '#meta': {
          ...meta,
          duration: result.duration,
          segments: result.segments,
          transcribedAt: Date.now(),
        },
      },
    });
  } catch (error) {
    context.change.patch(path, {
      $set: { '#meta': { ...meta, error: error instanceof Error ? error.message : String(error) } },
    });
    yield { path, status: 'failed' };
    throw error;
  }

  return { path };
}
