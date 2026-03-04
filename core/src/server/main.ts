import 'dotenv/config';
import { startServices } from '#contexts/service/index';
import { type NodeData } from '#core';
import { loadLocalMods } from '#mod';
import { createMemoryTree } from '#tree';
import './mount-adapters';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { seed } from './seed';
import '#schema/load';
import '#contexts/text/index';
import '#contexts/schema/index';
import { createTreenityServer } from './server';

// Lock CWD — no library may change it
process.chdir = () => { throw new Error('process.chdir is forbidden'); };

// ── Root config ──
const rootPath = resolve(process.argv[2] || 'root.json');
const rootNode = JSON.parse(await readFile(rootPath, 'utf-8')) as NodeData;

// Internal mods (core/src/mods/)
const internalModsDir = new URL('../mods', import.meta.url).pathname;
const internal = await loadLocalMods(internalModsDir, 'server');

// External mods (root mods/)
const externalModsDir = new URL('../../../mods', import.meta.url).pathname;
const external = await loadLocalMods(externalModsDir, 'server');

const allFailed = [...internal.failed, ...external.failed];
if (allFailed.length) console.error('failed mods:', allFailed.map(f => `${f.name}: ${f.error.message}`).join(', '));
console.log(`mods: ${[...internal.loaded, ...external.loaded].join(', ')}`);

const port = Number(process.env.PORT) || 3211;

// ── Bootstrap from root.json ──
const bootstrap = createMemoryTree();
await bootstrap.set(rootNode);

const { server, store, mountable } = createTreenityServer(bootstrap);
await seed(mountable);

// MCP now starts via autostart service (/sys/autostart/mcp → /sys/mcp)
const serviceHandle = process.env.NO_SERVICES ? null
  : await startServices(store, store.subscribe.bind(store) as import('#contexts/service/index').ServiceCtx['subscribe']);

const host = process.env.HOST || '127.0.0.1';
server.listen(port, host, () => console.log(`treenity trpc ${host}:${port}`));

process.on('unhandledRejection', (err) => console.error('[UNHANDLED]', err));

process.on('SIGTERM', async () => {
  await serviceHandle?.stop();
  server.close();
  process.exit(0);
});
