// End-to-end: a mod's schema migrations over the production layering —
// the storage policy's migration step over withMounts(bootstrap) with a REAL
// fs adapter underneath. Old-shape JSON on disk (pre-# namespace, pre-$v)
// arrives to callers fully migrated; the persistent $v-ladder shape converges
// on disk only when the node is next written (core-anz4.9 — reads never write).
import { createNode, register } from '#core';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { withMounts } from '#mount';
import { createMemoryTree, type Tree } from '#tree';
import { createFsTree } from '#tree/fs';
import { withStoragePolicy } from '#tree/policy';
import { createRepathTree } from '#tree/repath';
import './types';

let dir: string;
let tree: Tree;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'treenix-versioned-mod-'));

  // Oldest possible shape: bare component key (pre-#) + v0 fields (pre-$v).
  await writeFile(join(dir, 'doc.json'), JSON.stringify({
    $type: 'example.versioned.doc',
    text: 'hello brave world',
    note: { $type: 'example.versioned.note', txt: 'remember' },
  }, null, 2) + '\n');

  // createFsTree runs the one-shot # namespace pass (note → #note);
  // the policy's migration step then runs the per-type $v ladders on read.
  // Repath like the real t.mount.fs adapter: outer /data/* → adapter-local /*.
  const fsTree = await createFsTree(dir);
  register('example.versioned.mount', 'mount', () => createRepathTree(fsTree, '/data', '/'));

  const bootstrap = createMemoryTree();
  await bootstrap.set(createNode('/', 'root', {}));
  await bootstrap.set(createNode('/data', 'mount-point', {}, {
    mount: { $type: 'example.versioned.mount' },
  }));

  tree = withStoragePolicy(withMounts(bootstrap)).tree;
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('example.versioned mod (migrations e2e)', () => {
  it('get serves a v0 node fully migrated — node ladder and #component ladder', async () => {
    const doc = await tree.get('/data/doc');
    assert.ok(doc);
    assert.equal(doc.body, 'hello brave world');
    assert.equal(doc.words, 3);
    assert.equal(doc.$v, 2);
    assert.ok(!('text' in doc));

    const note = doc['#note'] as Record<string, unknown>;
    assert.equal(note.note, 'remember');
    assert.equal(note.$v, 1);
    assert.ok(!('txt' in note));
  });

  it('a read does NOT converge disk — the $v-ladder shape stays on disk untouched (core-anz4.9)', async () => {
    await tree.get('/data/doc');
    const onDisk = JSON.parse(await readFile(join(dir, 'doc.json'), 'utf-8'));
    // The # namespace pass ran once at createFsTree; the $v ladder runs on read
    // in memory only, so the persistent shape stays pre-ladder (text, txt, no $v).
    assert.equal(onDisk.text, 'hello brave world');
    assert.equal(onDisk.$v, undefined);
    assert.ok(!('body' in onDisk));
    assert.equal(onDisk['#note'].txt, 'remember');
    assert.equal(onDisk['#note'].$v, undefined);
  });

  it('getChildren and scanChildren serve migrated nodes', async () => {
    const { items } = await tree.getChildren('/data');
    const doc = items.find(n => n.$path === '/data/doc');
    assert.equal(doc?.body, 'hello brave world');
    assert.equal(doc?.$v, 2);

    assert.ok(tree.scanChildren, 'mounted tree must expose scanChildren');
    const scanned = [];
    for await (const entry of tree.scanChildren('/data')) scanned.push(entry.node);
    const scannedDoc = scanned.find(n => n.$path === '/data/doc');
    assert.equal(scannedDoc?.words, 3);
    assert.equal(scannedDoc?.$v, 2);
  });

  it('set stamps $v so fresh writes never re-enter the ladder', async () => {
    await tree.set(createNode('/data/fresh', 'example.versioned.doc', { body: 'one two', words: 2 }));

    const onDisk = JSON.parse(await readFile(join(dir, 'fresh.json'), 'utf-8'));
    assert.equal(onDisk.$v, 2);

    const got = await tree.get('/data/fresh');
    assert.equal(got?.body, 'one two');
    assert.equal(got?.words, 2);
  });
});
