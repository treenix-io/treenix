import { registerPrefab } from '@treenx/core/mod';

registerPrefab('whisper', 'seed', [
  // transcripts are personal — closed to non-admins by default
  { $path: 'whisper', $type: 'whisper.service',
    $acl: [{ g: 'admins', p: 15 }, { g: 'system', p: 15 }],
    '#config': {
      $type: 'whisper.config', model: 'small', language: 'ru',
      audioDir: './data/audio', url: '/api/notice/audio',
      channels: { default: '/whisper/default' }, keepDays: 0,
    },
  },
  { $path: '/sys/autostart/whisper', $type: 'ref', $ref: '/whisper' },
]);
