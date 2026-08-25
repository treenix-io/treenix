// Whisper service — autostart-compatible, registers HTTP route dynamically,
// sweeps old raw audio when keepDays is set (transcript text stays in the tree)

import { getComponent, register } from '@treenx/core';
import { routeRegistry } from '@treenx/core/server/server';
import { readdir, stat, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createWhisperHandler } from './route';
import { WhisperConfig } from './types';

const SWEEP_INTERVAL = 6 * 60 * 60 * 1000;

async function sweepAudio(audioDir: string, keepDays: number): Promise<void> {
  const dir = resolve(audioDir);
  const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
  let files: string[];
  try {
    files = await readdir(dir);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return; // no audio received yet
    throw e;
  }
  for (const f of files) {
    const p = join(dir, f);
    const s = await stat(p);
    if (s.isFile() && s.mtimeMs < cutoff) {
      await unlink(p);
      console.log(`[whisper] retention: deleted ${f}`);
    }
  }
}

register('whisper.service', 'service', async (node, _ctx) => {
  const config = getComponent(node, WhisperConfig);
  if (!config) throw new Error(`[whisper] missing config on ${node.$path}`);

  const routePath = config.url || node.$path;
  const handler = createWhisperHandler({
    nodePath: node.$path,
    model: config.model,
    language: config.language,
    audioDir: config.audioDir,
    channels: config.channels,
  });

  routeRegistry.set(routePath, handler);
  console.log(`[whisper] route ${routePath} (model: ${config.model}, channels: ${Object.keys(config.channels).join(',') || 'none'})`);

  let sweeper: NodeJS.Timeout | null = null;
  if (config.keepDays > 0) {
    const run = () => sweepAudio(config.audioDir, config.keepDays)
      .catch(e => console.error('[whisper] retention sweep failed:', e));
    run();
    sweeper = setInterval(run, SWEEP_INTERVAL);
  }

  return {
    stop: async () => {
      routeRegistry.delete(routePath);
      if (sweeper) clearInterval(sweeper);
      console.log(`[whisper] unregistered ${routePath}`);
    },
  };
});
