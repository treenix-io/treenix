// HTTP edge hardening: request limits, handler failures, static read errors.

import { A, createNode, R, S, W } from '#core';
import { TRPC_MAX_BATCH } from '#client/trpc';
import { createMemoryTree } from '#tree';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { createHttpServer, createPipeline } from './server';

let server: Server | undefined;
let tmp: string | undefined;

async function start(opts?: Parameters<typeof createHttpServer>[1]): Promise<string> {
  const bootstrap = createMemoryTree();
  await bootstrap.set({ ...createNode('/', 'root'), $acl: [{ g: 'public', p: R }, { g: 'system', p: R | W | A | S }] });
  const s = createHttpServer(createPipeline(bootstrap), opts);
  server = s;
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const addr = s.address();
  if (!addr || typeof addr === 'string') throw new Error('no tcp address');
  return `http://127.0.0.1:${addr.port}`;
}

afterEach(async () => {
  const s = server;
  server = undefined;
  if (s) await new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); });
  if (tmp) await rm(tmp, { recursive: true, force: true });
  tmp = undefined;
});

describe('http edge', () => {
  it('rejects an oversized tRPC body (413)', async () => {
    const url = await start();
    const res = await fetch(`${url}/trpc/set`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blob: 'x'.repeat(17 * 1024 * 1024) }),
    });
    assert.equal(res.status, 413);
  });

  it('rejects a batch above TRPC_MAX_BATCH (400)', async () => {
    const url = await start();
    const procs = Array(TRPC_MAX_BATCH + 1).fill('get').join(',');
    const res = await fetch(`${url}/trpc/${procs}?batch=1&input=${encodeURIComponent('{}')}`);
    assert.equal(res.status, 400);
  });

  it('a throwing handler step answers 500 instead of hanging', async () => {
    const url = await start({ healthCheck: () => { throw new Error('probe down'); } });
    const res = await fetch(`${url}/anything`, { signal: AbortSignal.timeout(5000) });
    assert.equal(res.status, 500);
  });

  it('an unreadable static file does not take the process down', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'treenix-static-'));
    await writeFile(join(tmp, 'index.html'), '<html></html>');
    await writeFile(join(tmp, 'locked.js'), 'x');
    await chmod(join(tmp, 'locked.js'), 0o000);
    const url = await start({ staticDir: tmp });

    await fetch(`${url}/locked.js`).then((r) => r.arrayBuffer()).catch(() => undefined);
    const after = await fetch(`${url}/some/spa/route`);
    assert.equal(after.status, 200);
  });
});
