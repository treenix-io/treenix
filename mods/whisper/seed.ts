import { registerPrefab } from '@treenx/core/mod';

registerPrefab('whisper', 'seed', [
  { $path: 'whisper', $type: 'whisper.service',
    config: {
      $type: 'whisper.config', model: 'small', language: 'ru',
      audioDir: './data/audio', url: '/api/notice/audio',
    },
  },
  { $path: '/sys/autostart/whisper', $type: 'ref', $ref: '/whisper' },
  { $path: 'whisper/inbox', $type: 'whisper.inbox',
    source: '/whisper/default', target: '/agent' },
  { $path: '/sys/autostart/whisper-inbox', $type: 'ref', $ref: '/whisper/inbox' },
]);
