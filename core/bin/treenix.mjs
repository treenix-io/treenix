#!/usr/bin/env node
// treenix CLI entry — built package runs dist/, dev checkout re-execs via tsx on src/.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '../dist/server/backup-cli.js');

if (existsSync(dist)) {
  await import(pathToFileURL(dist).href);
} else {
  const { spawnSync } = await import('node:child_process');
  const src = join(here, '../src/server/backup-cli.ts');
  // dev checkout: '#' imports must resolve to src/, same as npm test
  const r = spawnSync('npx', ['tsx', '--conditions', 'development', src, ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}
