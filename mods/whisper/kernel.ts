import { A, R, W, type ModuleManifest, type TypeDef } from '@treenx/core/kernel/types';
import type { NativeModuleDeployment, NativeModuleHost } from '@treenx/core/kernel/manifest';
import { nativeSeed } from '#prefab/seed';
import { ingestAction, whisperService } from './native-http';
import config from './schemas/whisper.config.json' with { type: 'json' };
import audio from './schemas/whisper.audio.json' with { type: 'json' };
import text from './schemas/whisper.text.json' with { type: 'json' };
import meta from './schemas/whisper.meta.json' with { type: 'json' };
import checklist from './schemas/whisper.checklist.json' with { type: 'json' };
import channel from './schemas/whisper.channel.json' with { type: 'json' };
import transcription from './schemas/whisper.transcription.json' with { type: 'json' };

const owner = '@treenx/mods/whisper';
const { methods, ...transcriptionSchema } = transcription;

/** Construct security handlers under the current deployment's HTTP route owner. */
export default function createNativeWhisper(host: NativeModuleHost = {}): NativeModuleDeployment {
  const types: TypeDef[] = [config, audio, text, meta, checklist, channel, transcriptionSchema].map(
    (schema) => ({
      name: schema.$id,
      module: owner,
      security: 'ordinary',
      version: 0,
      schema,
      actions: {},
    }),
  );
  types.push({
    name: 'whisper.service',
    module: owner,
    security: 'user-capability',
    version: 0,
    schema: { type: 'object', properties: {} },
    actions: { ingest: ingestAction },
  });

  const manifest: ModuleManifest = {
    id: owner,
    types,
    security: [{ type: 'whisper.service', context: 'service', handler: whisperService(host) }],
    open: [],
  };

  return {
    manifest,
    seeds: nativeSeed(
      'whisper',
      [
        {
          $path: 'whisper',
          $type: 'whisper.service',
          $acl: [
            { subject: { group: 'admins' }, grant: R | W | A },
            { subject: { group: 'system' }, grant: R | W | A },
          ],
          '#config': {
            $type: 'whisper.config',
            model: 'small',
            language: 'ru',
            audioDir: './data/audio',
            url: '/api/notice/audio',
            channels: { default: '/whisper/default' },
            keepDays: 0,
          },
        },
        { $path: 'whisper/default', $type: 'whisper.channel' },
        { $path: '/sys/autostart/whisper', $type: 'ref', $ref: '/whisper' },
      ],
      [],
      [
        { executor: 'whisper', target: 'whisper', grant: R },
        { executor: '/sys/autostart', target: 'whisper', grant: R },
      ],
    ),
  };
}
