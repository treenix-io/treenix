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
