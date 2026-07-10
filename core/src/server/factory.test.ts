// factory: extension points (wrapTree)
// E2E flows tested in e2e-treenix.test.ts; here only the bits of factory wiring
// that don't need an HTTP server.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { A, createNode, R, S, W } from '#core';
import { interceptConsole, queryLogs } from '#log';
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
    { g: 'system', p: R | W | A | S },
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

// jre7 (owner decision 2026-07-03): logs are DUAL-written — every console line
// becomes a /sys/logs/<ts> node (the full, ever-growing history on persistent
// roots) AND stays queryable from the ring buffer, which used to freeze once
// the wire attached (the old `listeners ? tree : buffer` branch).
describe('log flood (jre7)', () => {
  it('console lines land in BOTH /sys/logs nodes and the ring buffer', async () => {
    const app = await treenix({
      modsDir: false,
      autostart: false,
      seed: async () => {},
      rootNode: rootNode(tmp),
    });

    const savedInfo = console.info;
    console.info = () => {};
    interceptConsole();
    for (let i = 0; i < 20; i++) console.info(`jre7-flood-${i}`);
    console.info = savedInfo;

    // Ring buffer captured every line despite the attached tree wire.
    assert.equal(queryLogs({ grep: 'jre7-flood-' }).length, 20);

    // Tree writes are fire-and-forget onto the fs-mounted root — yield until
    // they settle (bounded; no wall-clock sleeps).
    let total = 0;
    for (let i = 0; i < 500 && total < 20; i++) {
      total = (await app.systemTree.getChildren('/sys/logs')).total;
      if (total < 20) await new Promise<void>(r => setImmediate(r));
    }
    assert.ok(total >= 20, `expected >= 20 /sys/logs nodes, saw ${total}`);

    await app.stop();
  });
});
