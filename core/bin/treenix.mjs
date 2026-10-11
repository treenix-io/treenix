#!/usr/bin/env node
// treenix CLI entry — built package runs dist/, dev checkout re-execs via tsx on src/.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const nativeServe = args[0] === 'serve';
if (nativeServe && (args.length !== 3 || args[1] !== '--native' || args[2].length === 0)) {
  console.error('Usage: treenix serve --native path/to/kernel-config.json');
  process.exit(2);
}
const entry = nativeServe ? 'native-main' : 'backup-cli';
const forwarded = nativeServe ? [args[2]] : args;
const dist = join(here, `../dist/server/${entry}.js`);
if (nativeServe) process.argv = [process.argv[0], dist, ...forwarded];

if (existsSync(dist)) {
  await import(pathToFileURL(dist).href);
} else {
  const { spawnSync } = await import('node:child_process');
  const src = join(here, `../src/server/${entry}.ts`);
  // dev checkout: '#' imports must resolve to src/, same as npm test
  const r = spawnSync('npx', ['tsx', '--conditions', 'development', src, ...forwarded], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}
