import type { Tree } from '@treenity/core/tree';
import { createFsTree } from '@treenity/core/tree/fs';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

// Register the codec — side effect import
import './fs-codec';

describe('doc fs-codec', () => {
  let dir: string;
  let store: Tree;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'treenity-doc-codec-'));
    store = await createFsTree(dir);
  });

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('decode: .md file → doc.page node', async () => {
    await writeFile(join(dir, 'readme.md'), '# Hello World\n\nSome content here.\n');

    const node = await store.get('/readme');
    assert.equal(node?.$type, 'doc.page');
    assert.equal((node as any).title, 'Hello World');

    const content = JSON.parse((node as any).content);
    assert.equal(content.type, 'doc');
    assert.ok(content.content.length > 0);
  });

  it('decode: .md without H1 — empty title', async () => {
    await writeFile(join(dir, 'notes.md'), 'Just a paragraph.\n\n## Second heading\n');

    const node = await store.get('/notes');
    assert.equal(node?.$type, 'doc.page');
    assert.equal((node as any).title, '');

    const content = JSON.parse((node as any).content);
    assert.equal(content.content[0].type, 'paragraph');
    assert.equal(content.content[1].type, 'heading');
  });

  it('encode: doc.page node → .md file', async () => {
    const tiptapDoc = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello from Tiptap' }] }],
    };

    await store.set({
      $path: '/output',
      $type: 'doc.page',
      title: 'My Doc',
      content: JSON.stringify(tiptapDoc),
    } as any);

    const raw = await readFile(join(dir, 'output.md'), 'utf-8');
    assert.ok(raw.startsWith('# My Doc'));
    assert.ok(raw.includes('Hello from Tiptap'));
  });

  it('encode: no title — no H1 prefix', async () => {
    const tiptapDoc = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Just text' }] }],
    };

    await store.set({
      $path: '/bare',
      $type: 'doc.page',
      title: '',
      content: JSON.stringify(tiptapDoc),
    } as any);

    const raw = await readFile(join(dir, 'bare.md'), 'utf-8');
    assert.ok(!raw.startsWith('#'));
    assert.ok(raw.includes('Just text'));
  });

  it('roundtrip: .md → node → .md preserves content', async () => {
    const original = '# Project Notes\n\nThis is **bold** and *italic*.\n\n- item one\n- item two\n\n```ts\nconst x = 1;\n```\n';
    await writeFile(join(dir, 'notes.md'), original);

    // Decode
    const node = await store.get('/notes');
    assert.equal(node?.$type, 'doc.page');
    assert.equal((node as any).title, 'Project Notes');

    // Encode back
    await store.set(node!);
    const result = await readFile(join(dir, 'notes.md'), 'utf-8');

    // Verify key elements survived roundtrip
    assert.ok(result.includes('# Project Notes'));
    assert.ok(result.includes('**bold**'));
    assert.ok(result.includes('*italic*'));
    assert.ok(result.includes('- item one'));
    assert.ok(result.includes('```ts'));
    assert.ok(result.includes('const x = 1;'));
  });

  it('getChildren lists .md files as doc.page', async () => {
    await writeFile(join(dir, 'a.md'), '# Alpha\n\nContent A\n');
    await writeFile(join(dir, 'b.md'), '# Beta\n\nContent B\n');
    await writeFile(join(dir, 'c.txt'), 'plain text');

    const { items } = await store.getChildren('/');
    const types = Object.fromEntries(items.map(n => [n.$path, n.$type]));

    assert.equal(types['/a'], 'doc.page');
    assert.equal(types['/b'], 'doc.page');
    assert.equal(types['/c'], 'text/plain');
  });
});
