import 'dotenv/config';
import { type NodeData } from '#core';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { treenity } from './factory';

// Lock CWD — no library may change it
process.chdir = () => { throw new Error('process.chdir is forbidden'); };

const rootPath = resolve(process.argv[2] || 'root.json');
console.log(`[boot] root: ${rootPath}`);
const rootNode = JSON.parse(await readFile(rootPath, 'utf-8')) as NodeData;

const modsDir = process.env.MODS_DIR || undefined;
const t = await treenity({ rootNode, modsDir });
const port = Number(process.env.PORT) || 3211;
const host = process.env.HOST || '127.0.0.1';
const server = await t.listen(port, { host });

process.on('unhandledRejection', (err) => console.error('[UNHANDLED]', err));

process.on('SIGTERM', async () => {
  await t.stop();
  server.close();
  process.exit(0);
});
