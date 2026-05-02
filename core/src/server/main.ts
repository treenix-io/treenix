import 'dotenv/config';
import { type NodeData } from '#core';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { treenix } from './factory';

// Lock CWD — no library may change it
process.chdir = () => { throw new Error('process.chdir is forbidden'); };

// Auto-generate schemas (oxc-parser is a devDependency — available in dev via tsx)
try {
  const { generateSchemas } = await import('#schema/extract-schemas-oxc');
  const coreDir = new URL('../..', import.meta.url).pathname;
  const engineDir = new URL('../../..', import.meta.url).pathname;
  await generateSchemas([
    join(coreDir, 'src'),
    join(engineDir, 'mods'),
    join(engineDir, 'packages'),
    resolve('mods'),
  ]);
} catch (err) {
  const code = (err as Record<string, unknown>).code;
  if (code === 'ERR_MODULE_NOT_FOUND') {
    console.log('[schema] skipped (production mode)');
  } else {
    throw err;
  }
}

const rootPath = resolve(process.argv[2] || 'root.json');
console.log(`[boot] root: ${rootPath}`);
const rootNode = JSON.parse(await readFile(rootPath, 'utf-8')) as NodeData;

const modsDir = process.env.MODS_DIR || undefined;
const t = await treenix({ rootNode, modsDir });
const port = Number(process.env.PORT) || 3211;
const host = process.env.HOST || '127.0.0.1';

// Optional SSR — wired only if @treenx/ssr is installed and SSR=1 (or default-on).
let htmlHandler;
if (process.env.SSR !== '0') {
  try {
    const ssr = await import('@treenx/ssr');
    htmlHandler = await ssr.installSsr(t);
    console.log('[ssr] enabled');
  } catch (err) {
    const code = (err as Record<string, unknown>).code;
    if (code !== 'ERR_MODULE_NOT_FOUND') console.warn('[ssr] init failed:', (err as Error).message);
  }
}

const server = await t.listen(port, { host, htmlHandler });

process.on('unhandledRejection', (err) => console.error('[UNHANDLED]', err));

process.on('SIGTERM', async () => {
  await t.stop();
  server.close();
  process.exit(0);
});
