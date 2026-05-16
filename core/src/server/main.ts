import 'dotenv/config';
import { type NodeData } from '#core';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { treenix } from './factory';
import { devBannerLines } from './dev-defaults';

// Lock CWD — no library may change it
process.chdir = () => { throw new Error('process.chdir is forbidden'); };

// Refuse to boot if the dev-login flag is set outside development.
// Catches the "env-var typo in prod" failure mode loudly, before any request hits the dev-login handler.
if (process.env.VITE_DEV_LOGIN && process.env.NODE_ENV !== 'development') {
  console.error('[boot] FATAL: VITE_DEV_LOGIN is set but NODE_ENV is not "development". Refusing to start — this would expose the dev-login admin route in production.');
  process.exit(1);
}

const rootPath = resolve(process.argv[2] || 'root.json');
console.log(`[boot] root: ${rootPath}`);
const rootNode = JSON.parse(await readFile(rootPath, 'utf-8')) as NodeData;

// Harness/audit wiring — gated on `'audit'` ∈ rootNode.seeds. Single source of truth:
// if the seed prefab deploys /sys/audit/event, also wire (a) the audit wrapper,
// (b) health-check, (c) workload session executor. Soft dep on @treenx/mods/*
// (engine/core has no static dep on mods to avoid workspace cycle).
let wrapTree: ((tree: import('#tree').Tree) => import('#tree').Tree) | undefined;
let healthCheck: (() => { healthy: boolean; reason: string }) | undefined;
let executor: import('./trpc').SessionExecutor | undefined;
const seeds = (rootNode as Record<string, unknown>).seeds;
if (Array.isArray(seeds) && seeds.includes('audit')) {
  const { withAudit } = await import('@treenx/mods/audit/with-audit');
  const { isHealthy, unhealthyReason } = await import('@treenx/mods/audit/health');
  const { executeForSession } = await import('@treenx/mods/harness/session');
  wrapTree = withAudit;
  healthCheck = () => ({ healthy: isHealthy(), reason: unhealthyReason() });
  executor = executeForSession;
  console.log('[boot] audit + harness: enabled (seeds includes "audit")');
}

const modsDir = process.env.MODS_DIR || undefined;
const t = await treenix({ rootNode, modsDir, wrapTree, healthCheck, executor });
const port = Number(process.env.PORT) || 3211;
const host = process.env.HOST || '127.0.0.1';

const server = await t.listen(port, { host });

const banner = devBannerLines(port);
if (banner) for (const line of banner) console.log(line);

process.on('unhandledRejection', (err) => console.error('[UNHANDLED]', err));

process.on('SIGTERM', async () => {
  await t.stop();
  server.close();
  process.exit(0);
});
