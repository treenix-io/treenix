import type { NodeData } from '@treenx/core';
import type { Tree } from '@treenx/core/tree';
import { createRawFsStore } from '@treenx/core/tree/mimefs';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

// Register the codec — side effect import
import './fs-codec';

describe('doc fs-codec', () => {
  let dir: string;
  let tree: Tree;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'treenix-doc-codec-'));
    tree = await createRawFsStore(dir);
  });

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('decode: .md file → doc.page node', async () => {
    await writeFile(join(dir, 'readme.md'), '# Hello World\n\nSome content here.\n');

    const node = await tree.get('/readme.md');
    assert.equal(node?.$type, 'doc.page');
    assert.equal((node as Record<string, unknown>).title, 'Hello World');

    const content = (node as Record<string, unknown>).content as { type: string; content: unknown[] };
    assert.equal(content.type, 'doc');
    assert.ok(content.content.length > 0);
  });

  it('decode: .md without H1 — empty title', async () => {
    await writeFile(join(dir, 'notes.md'), 'Just a paragraph.\n\n## Second heading\n');

    const node = await tree.get('/notes.md');
    assert.equal(node?.$type, 'doc.page');
    assert.equal((node as Record<string, unknown>).title, '');

    const content = (node as Record<string, unknown>).content as { content: { type: string }[] };
    assert.equal(content.content[0].type, 'paragraph');
    assert.equal(content.content[1].type, 'heading');
  });

  it('encode: doc.page node → .md file', async () => {
    const tiptapDoc = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello from Tiptap' }] }],
    };

    await tree.set({
      $path: '/output.md',
      $type: 'doc.page',
      title: 'My Doc',
      content: tiptapDoc,
    } as NodeData);

    const raw = await readFile(join(dir, 'output.md'), 'utf-8');
    assert.ok(raw.startsWith('# My Doc'));
    assert.ok(raw.includes('Hello from Tiptap'));
  });

  it('encode: no title — no H1 prefix', async () => {
    const tiptapDoc = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Just text' }] }],
    };

    await tree.set({
      $path: '/bare.md',
      $type: 'doc.page',
      title: '',
      content: tiptapDoc,
    } as NodeData);

    const raw = await readFile(join(dir, 'bare.md'), 'utf-8');
    assert.ok(!raw.startsWith('#'));
    assert.ok(raw.includes('Just text'));
  });

  it('roundtrip: .md → node → .md preserves content', async () => {
    const original = '# Project Notes\n\nThis is **bold** and *italic*.\n\n- item one\n- item two\n\n```ts\nconst x = 1;\n```\n';
    await writeFile(join(dir, 'notes.md'), original);

    // Decode
    const node = await tree.get('/notes.md');
    assert.equal(node?.$type, 'doc.page');
    assert.equal((node as Record<string, unknown>).title, 'Project Notes');

    // Encode back
    await tree.set(node!);
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

    const { items } = await tree.getChildren('/');
    const types = Object.fromEntries(items.map(n => [n.$path, n.$type]));

    assert.equal(types['/a.md'], 'doc.page');
    assert.equal(types['/b.md'], 'doc.page');
    assert.equal(types['/c.txt'], 'text/plain');
  });
});

// Regression: when rawfs is mounted at /docs, relative markdown links must resolve
// against the OUTER tree path so client navigation lands on /docs/public/concepts/types.md,
// not /public/concepts/types.md (which was the original bug).
describe('doc fs-codec — mounted rawfs link resolution', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'treenix-doc-codec-mount-'));
  });

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  function findNodeLink(content: unknown): { type: string; attrs?: Record<string, unknown> } | null {
    const stack: Array<{ marks?: Array<{ type: string; attrs?: Record<string, unknown> }>; content?: unknown[] }> = [content as never];
    while (stack.length) {
      const n = stack.pop()!;
      const mark = n.marks?.find((m) => m.type === 'nodeLink');
      if (mark) return mark;
      if (n.content) stack.push(...(n.content as typeof stack));
    }
    return null;
  }

  it('resolves ./relative.md against outer mount path', async () => {
    const subdir = join(dir, 'public');
    await mkdtemp(subdir + '-'); // ensure unique sibling, then create the real one
    await writeFile(join(dir, 'index.md'), 'See [Types](./public/types.md).\n');

    const tree = await createRawFsStore(dir, '/docs');
    const node = await tree.get('/index.md');

    const link = findNodeLink((node as Record<string, unknown>).content);
    assert.ok(link, 'expected a nodeLink mark');
    assert.equal(link.attrs?.path, '/docs/public/types.md');
  });

  it('resolves ./nested/file.md against deeper outer path', async () => {
    await writeFile(join(dir, 'index.md'), '[Types](./concepts/types.md)\n');

    const tree = await createRawFsStore(dir, '/docs/public');
    const node = await tree.get('/index.md');

    const link = findNodeLink((node as Record<string, unknown>).content);
    assert.ok(link);
    assert.equal(link.attrs?.path, '/docs/public/concepts/types.md');
  });

  it('resolves ../sibling.md across outer parent dir', async () => {
    const subdir = join(dir, 'public');
    await mkdtemp(subdir + '-tmp-');
    await writeFile(join(dir, 'sibling.md'), '# Sibling\n');
    await writeFile(join(dir, 'index.md'), '[Up](../sibling.md)\n');

    const tree = await createRawFsStore(dir, '/docs/public');
    const node = await tree.get('/index.md');

    const link = findNodeLink((node as Record<string, unknown>).content);
    assert.ok(link);
    assert.equal(link.attrs?.path, '/docs/sibling.md');
  });

  it('default (no mountPath) keeps inner path — backward compatible', async () => {
    await writeFile(join(dir, 'index.md'), '[Types](./types.md)\n');

    const tree = await createRawFsStore(dir);
    const node = await tree.get('/index.md');

    const link = findNodeLink((node as Record<string, unknown>).content);
    assert.ok(link);
    assert.equal(link.attrs?.path, '/types.md');
  });

  it('mountPath with trailing slash is normalized', async () => {
    await writeFile(join(dir, 'index.md'), '[X](./x.md)\n');

    const tree = await createRawFsStore(dir, '/docs/');
    const node = await tree.get('/index.md');

    const link = findNodeLink((node as Record<string, unknown>).content);
    assert.ok(link);
    assert.equal(link.attrs?.path, '/docs/x.md');
  });
});

describe('doc fs-codec — YAML frontmatter', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'treenix-doc-codec-fm-'));
  });

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('strips frontmatter and attaches doc.frontmatter component', async () => {
    const raw = `---\ntitle: Introduction\ndescription: Overview\ntags: [intro, overview]\norder: 0\nsection: root\n---\n\n# Body Heading\n\nSome text.\n`;
    await writeFile(join(dir, 'index.md'), raw);

    const tree = await createRawFsStore(dir);
    const node = await tree.get('/index.md') as Record<string, unknown>;

    // Frontmatter title takes precedence over H1
    assert.equal(node.title, 'Introduction');

    const fm = node['doc.frontmatter'] as Record<string, unknown> | undefined;
    assert.ok(fm, 'expected doc.frontmatter component on node');
    assert.equal(fm.$type, 'doc.frontmatter');
    assert.equal(fm.title, 'Introduction');
    assert.equal(fm.description, 'Overview');
    assert.equal(fm.section, 'root');
    assert.equal(fm.order, 0);
    assert.deepEqual(fm.tags, ['intro', 'overview']);

    // Frontmatter raw text must NOT appear in body content
    const content = node.content as { content?: unknown[] };
    const flat = JSON.stringify(content);
    assert.ok(!flat.includes('---'));
    assert.ok(!flat.includes('section: root'));
  });

  it('falls back to H1 when frontmatter has no title', async () => {
    const raw = `---\ndescription: only desc\n---\n\n# H1 Title\n\nBody.\n`;
    await writeFile(join(dir, 'page.md'), raw);

    const tree = await createRawFsStore(dir);
    const node = await tree.get('/page.md') as Record<string, unknown>;

    assert.equal(node.title, 'H1 Title');
    const fm = node['doc.frontmatter'] as Record<string, unknown>;
    assert.equal(fm.description, 'only desc');
  });

  it('preserves unknown keys in extra', async () => {
    const raw = `---\ntitle: T\nlayout: post\ndraft: true\n---\nbody`;
    await writeFile(join(dir, 'p.md'), raw);

    const tree = await createRawFsStore(dir);
    const node = await tree.get('/p.md') as Record<string, unknown>;
    const fm = node['doc.frontmatter'] as Record<string, unknown>;
    assert.deepEqual(fm.extra, { layout: 'post', draft: true });
  });

  it('no frontmatter → no doc.frontmatter component', async () => {
    await writeFile(join(dir, 'plain.md'), '# Just a heading\n\ntext\n');

    const tree = await createRawFsStore(dir);
    const node = await tree.get('/plain.md') as Record<string, unknown>;
    assert.equal(node['doc.frontmatter'], undefined);
    assert.equal(node.title, 'Just a heading');
  });

  it('roundtrip preserves frontmatter on encode', async () => {
    const original = `---\ntitle: T\ndescription: D\ntags: [a, b]\norder: 3\n---\n\n# T\n\nBody.\n`;
    await writeFile(join(dir, 'r.md'), original);

    const tree = await createRawFsStore(dir);
    const node = await tree.get('/r.md');

    await tree.set(node!);
    const result = await readFile(join(dir, 'r.md'), 'utf-8');

    // Re-decode and verify identical frontmatter component
    const reTree = await createRawFsStore(dir);
    const reNode = await reTree.get('/r.md') as Record<string, unknown>;
    const fm = reNode['doc.frontmatter'] as Record<string, unknown>;
    assert.equal(fm.title, 'T');
    assert.equal(fm.description, 'D');
    assert.equal(fm.order, 3);
    assert.deepEqual(fm.tags, ['a', 'b']);

    // Result must start with a fence
    assert.ok(result.startsWith('---\n'));
    assert.ok(result.includes('# T'));
    assert.ok(result.includes('Body.'));
  });
});
