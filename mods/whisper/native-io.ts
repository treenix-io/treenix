import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { KernelError } from '@treenx/core/errors';
import type { ActionIoBinding } from '@treenx/core/kernel/types';
import { extForMime, getTranscriber, readWavAsFloat32 } from './audio';

export interface WhisperSettings {
  readonly audioDir: string;
  readonly model: string;
  readonly language: string;
}

export interface SavedAudio {
  readonly filename: string;
  readonly size: number;
  readonly mime: string;
}

export interface RecognizedAudio {
  readonly content: string;
  readonly duration: number;
  readonly segments: number;
}

export interface WhisperIo {
  save(directory: string, body: Uint8Array, mime: string): Promise<SavedAudio>;
  recognize(settings: WhisperSettings, audio: SavedAudio): Promise<RecognizedAudio>;
}

declare module '@treenx/core/kernel/types' {
  interface Io {
    readonly whisper?: WhisperIo;
  }
}

const convert = promisify(execFile);
export type WhisperRecognition = (
  samples: Float32Array,
  settings: WhisperSettings,
) => Promise<RecognizedAudio>;

/** Use the shared cached model after audio has been converted to mono samples. */
async function recognizeAudio(
  samples: Float32Array,
  settings: WhisperSettings,
): Promise<RecognizedAudio> {
  const transcriber = await getTranscriber(settings.model);
  const output = await transcriber(samples, {
    language: settings.language,
    return_timestamps: true,
  });
  return {
    content: output.text.trim(),
    duration: output.chunks?.at(-1)?.timestamp[1] ?? 0,
    segments: output.chunks?.length ?? 0,
  };
}

/** Bind authored audio directory names to explicit host capabilities. */
export function createWhisperIo(
  directories: Readonly<Record<string, string>>,
  recognize: WhisperRecognition = recognizeAudio,
): ActionIoBinding {
  const admittedDirectories = new Map(
    Object.entries(directories).map(([name, path]) => [name, resolve(path)]),
  );

  return (scope) => {
    /** A node's configuration can select an admitted directory, never grant filesystem authority. */
    function directory(name: string): string {
      scope.assertActive();
      const path = admittedDirectories.get(name);
      if (path === undefined)
        throw new KernelError('FORBIDDEN', 'Whisper audio directory is not admitted');
      return path;
    }

    return {
      whisper: {
        async save(name, body, mime) {
          const path = directory(name),
            extension = extForMime(mime);
          if (extension === null) throw new KernelError('INVALID', 'Unsupported audio MIME type');
          const filename = `${randomUUID()}.${extension}`;
          await mkdir(path, { recursive: true });
          await writeFile(join(path, filename), body, { signal: scope.signal });
          scope.assertActive();
          return { filename, size: body.byteLength, mime };
        },

        async recognize(settings, audio) {
          const path = directory(settings.audioDir),
            wavPath = join(path, `${audio.filename}_16k.wav`);
          try {
            await convert(
              'ffmpeg',
              [
                '-i',
                join(path, audio.filename),
                '-ar',
                '16000',
                '-ac',
                '1',
                '-f',
                'wav',
                '-y',
                wavPath,
              ],
              { signal: scope.signal },
            );
            const samples = await readWavAsFloat32(wavPath);
            scope.assertActive();
            const output = await recognize(samples, settings);
            scope.assertActive();
            return output;
          } finally {
            try {
              await unlink(wavPath);
            } catch (error) {
              if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
                throw error;
            }
          }
        },
      },
    };
  };
}
