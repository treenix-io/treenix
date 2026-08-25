import { registerPrefab } from '@treenx/core/mod';

registerPrefab('whisper', 'seed', [
  { $path: 'whisper', $type: 'whisper.service',
    '#config': {
      $type: 'whisper.config', model: 'small', language: 'ru',
      audioDir: './data/audio', url: '/api/notice/audio',
      channels: { default: '/whisper/default' }, keepDays: 0,
    },
  },
  { $path: '/sys/autostart/whisper', $type: 'ref', $ref: '/whisper' },
]);
