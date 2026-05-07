// factory: extension points (wrapTree)
// E2E flows tested in e2e-treenix.test.ts; here only the bits of factory wiring
// that don't need an HTTP server.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { createNode, R, S, W } from '#core';
import type { Tree } from '#tree';
import { treenix } from './factory';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'treenix-factory-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function rootNode(dir: string) {
  const n = createNode('/', 'root', {}, {
    mount: { $type: 't.mount.overlay', layers: ['base', 'work'] },
    base: { $type: 't.mount.fs', root: dir + '/base' },
    work: { $type: 't.mount.fs', root: dir + '/work' },
  });
  n.$acl = [
    { g: 'authenticated', p: R | W | S },
    { g: 'admins', p: R | W | S },
  ];
  return n;
}

describe('treenix({ wrapTree })', () => {
  it('applies wrapTree to pipeline.tree (mutations go through wrapper)', async () => {
    const seenSets: string[] = [];
    const wrapTree = (inner: Tree): Tree => ({
      ...inner,
      async set(node, ctx) {
        seenSets.push(node.$path);
        return inner.set(node, ctx);
      },
    });

    const app = await treenix({
      modsDir: false,
      autostart: false,
      seed: async () => {},
      rootNode: rootNode(tmp),
      wrapTree,
    });

    await app.tree.set({ $path: '/probe', $type: 'leaf', value: 1 });
    assert.ok(seenSets.includes('/probe'), `expected wrapTree to observe /probe set; saw [${seenSets.join(',')}]`);

    await app.stop();
  });

  it('wrapTree=undefined leaves pipeline unchanged (default behaviour)', async () => {
    const app = await treenix({
      modsDir: false,
      autostart: false,
      seed: async () => {},
      rootNode: rootNode(tmp),
    });

    await app.tree.set({ $path: '/probe', $type: 'leaf', value: 2 });
    const node = await app.tree.get('/probe');
    assert.equal(node?.value, 2);

    await app.stop();
  });
});

describe('treenix({ healthCheck })', () => {
  async function bootWith(unhealthy: boolean) {
    const app = await treenix({
      modsDir: false,
      autostart: false,
      seed: async () => {},
      rootNode: rootNode(tmp),
      healthCheck: () => ({ healthy: !unhealthy, reason: unhealthy ? 'audit down' : '' }),
    });
    const server = await app.listen(0);
    const port = (server.address() as { port: number }).port;
    return { app, server, port };
  }

  async function fetchPath(port: number, path: string) {
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    const body = await res.text();
    return { status: res.status, body };
  }

  it('healthy: /health returns 200 + body', async () => {
    const { app, server, port } = await bootWith(false);
    const { status, body } = await fetchPath(port, '/health');
    assert.equal(status, 200);
    assert.deepEqual(JSON.parse(body), { healthy: true, reason: '' });
    await app.stop();
    server.close();
  });

  it('unhealthy: /health returns 503 + reason', async () => {
    const { app, server, port } = await bootWith(true);
    const { status, body } = await fetchPath(port, '/health');
    assert.equal(status, 503);
    assert.deepEqual(JSON.parse(body), { healthy: false, reason: 'audit down' });
    await app.stop();
    server.close();
  });

  it('unhealthy: non-/health endpoints return 503', async () => {
    const { app, server, port } = await bootWith(true);
    const { status } = await fetchPath(port, '/trpc/anything');
    assert.equal(status, 503);
    await app.stop();
    server.close();
  });

  it('healthCheck=undefined: server stays available', async () => {
    const app = await treenix({
      modsDir: false,
      autostart: false,
      seed: async () => {},
      rootNode: rootNode(tmp),
    });
    const server = await app.listen(0);
    const port = (server.address() as { port: number }).port;
    // /health is reserved — without healthCheck it falls through to tRPC; expect non-503.
    const { status } = await fetchPath(port, '/anything');
    assert.notEqual(status, 503);
    await app.stop();
    server.close();
  });
});
