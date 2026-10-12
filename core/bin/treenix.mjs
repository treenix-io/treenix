#!/usr/bin/env node
// treenix CLI entry — built package runs dist/, dev checkout re-execs via tsx on src/.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const serve = args[0] === 'serve';
if (serve) {
  const [target, option, deployment, ...extra] = args.slice(1);
  if (!target || target.startsWith('--') || extra.length !== 0
    || option !== undefined && (option !== '--deployment' || !deployment)) {
    console.error('Usage: treenix serve path/to/kernel-config.json | treenix serve root.json --deployment path/to/kernel-config.json');
    process.exit(2);
  }
}
const entry = serve ? 'main' : 'backup-cli';
const forwarded = serve ? args.slice(1) : args;
const dist = join(here, `../dist/server/${entry}.js`);
if (serve) process.argv = [process.argv[0], dist, ...forwarded];

const sourceCheckout = serve && existsSync(join(here, '../tsconfig.json'));
if (!sourceCheckout && existsSync(dist)) {
  await import(pathToFileURL(dist).href);
} else {
  const { spawnSync } = await import('node:child_process');
  const src = join(here, `../src/server/${entry}.ts`);
  // dev checkout: '#' imports must resolve to src/, same as npm test
  const r = spawnSync('npx', ['tsx', '--conditions', 'development', src, ...forwarded], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}
