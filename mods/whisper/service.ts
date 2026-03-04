// Whisper service — autostart-compatible, registers HTTP route dynamically

import { getComp } from '@treenity/core/comp';
import { register } from '@treenity/core/core';
import { routeRegistry } from '@treenity/core/server/server';
import { createWhisperHandler } from './route';
import { WhisperConfig } from './types';

register('whisper.service', 'service', async (node, _ctx) => {
  const config = getComp(node, WhisperConfig);
  if (!config) throw new Error(`[whisper] missing config on ${node.$path}`);

  const routePath = config.url || node.$path;
  const handler = createWhisperHandler({
    nodePath: node.$path,
    model: config.model,
    language: config.language,
    audioDir: config.audioDir,
  });

  routeRegistry.set(routePath, handler);
  console.log(`[whisper] route ${routePath} (model: ${config.model})`);

  return {
    stop: async () => {
      routeRegistry.delete(routePath);
      console.log(`[whisper] unregistered ${routePath}`);
    },
  };
});
