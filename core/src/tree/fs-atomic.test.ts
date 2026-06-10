import { createNode } from '#core';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { createFsTree } from './fs';
import { atomicWrite } from './fs-atomic';

describe('atomicWrite', () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function setup() {
    dir = await mkdtemp(join(tmpdir(), 'treenix-fs-atomic-'));
    return dir;
  }

  async function tmpFiles(root: string): Promise<string[]> {
    const out: string[] = [];
    for (const e of await readdir(root, { withFileTypes: true, recursive: true })) {
      if (e.name.endsWith('.tmp')) out.push(e.name);
    }
    return out;
  }

  it('writes exact content and overwrites an existing file', async () => {
    const d = await setup();
    const file = join(d, 'a.json');

    await atomicWrite(file, '{"v":1}');
    assert.equal(await readFile(file, 'utf-8'), '{"v":1}');

    await atomicWrite(file, '{"v":2}');
    assert.equal(await readFile(file, 'utf-8'), '{"v":2}');

    assert.deepEqual(await tmpFiles(d), []);
  });

  it('sets restrictive mode on the created file', async () => {
    const d = await setup();
    const file = join(d, 'a.json');
    await atomicWrite(file, '{}');
    const mode = (await stat(file)).mode & 0o777;
    assert.equal(mode, 0o600);
  });

  it('readers never observe torn content under concurrent overwrites', async () => {
    const d = await setup();
    const file = join(d, 'big.json');
    // Two large, structurally-valid payloads with distinct markers. An in-place
    // writeFile tears under a concurrent read; rename can only swap whole inodes.
    const a = JSON.stringify({ marker: 'A', pad: 'a'.repeat(256 * 1024) });
    const b = JSON.stringify({ marker: 'B', pad: 'b'.repeat(256 * 1024) });

    await atomicWrite(file, a);

    let writing = true;
    const writer = (async () => {
      for (let i = 0; i < 50; i++) await atomicWrite(file, i % 2 ? a : b);
      writing = false;
    })();

    const reader = (async () => {
      let reads = 0;
      while (writing) {
        const raw = await readFile(file, 'utf-8');
        assert.ok(raw === a || raw === b, `torn read after ${reads} reads`);
        reads++;
      }
      assert.ok(reads > 0, 'reader never ran');
    })();

    await Promise.all([writer, reader]);
    assert.deepEqual(await tmpFiles(d), []);
  });

  it('on rename failure the original target survives and no tmp is left behind', async () => {
    const d = await setup();
    const target = join(d, 'node.json');
    // Make rename fail: a non-empty directory occupies the target path.
    await mkdir(target);
    await writeFile(join(target, 'occupied'), 'x');

    await assert.rejects(() => atomicWrite(target, '{"v":1}'));

    assert.ok((await stat(target)).isDirectory(), 'target was replaced');
    assert.equal(await readFile(join(target, 'occupied'), 'utf-8'), 'x');
    assert.deepEqual(await tmpFiles(d), []);
  });
});

describe('FsStore atomicity contract', () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function setup() {
    dir = await mkdtemp(join(tmpdir(), 'treenix-fs-atomic-tree-'));
    return createFsTree(dir);
  }

  it('set/promote/demote leave no tmp files on disk', async () => {
    const tree = await setup();

    await tree.set(createNode('/a', 'dir'));        // leaf write
    await tree.set(createNode('/a/b', 'dir'));      // promotes /a to dir form
    await tree.set(createNode('/a', 'dir', { n: 1 })); // dir-form write
    await tree.remove('/a/b');                      // demotes /a back to leaf

    const leftovers = (await readdir(dir, { withFileTypes: true, recursive: true }))
      .filter(e => e.name.endsWith('.tmp'));
    assert.deepEqual(leftovers, []);

    const a = await tree.get('/a');
    assert.equal((a as { n?: number })?.n, 1);
  });

  it('a stray tmp file is invisible to get/getChildren/scanChildren', async () => {
    const tree = await setup();
    await tree.set(createNode('/a', 'dir'));
    await tree.set(createNode('/a/b', 'dir'));

    // Simulates a crash between tmp write and rename: truncated JSON in a tmp file.
    await writeFile(join(dir, 'a', '.999.0.tmp'), '{"$type":"di', { mode: 0o600 });

    assert.ok(await tree.get('/a'));
    assert.ok(await tree.get('/a/b'));

    const children = await tree.getChildren('/a');
    assert.deepEqual(children.items.map(n => n.$path), ['/a/b']);

    const scanned: string[] = [];
    for await (const entry of tree.scanChildren('/a')) scanned.push(entry.node.$path);
    assert.deepEqual(scanned, ['/a/b']);
  });
});
