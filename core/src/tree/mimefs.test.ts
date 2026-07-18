import type { NodeData } from '#core';
import { register } from '#core';
import { clearRegistry } from '#testing';
import { OpError } from '#errors';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { registerJsonCodec } from './json-codec';
import { createRawFsTree } from './mimefs';
import { mapSiftQuery } from './query';

describe('RawFsStore', () => {
  let dir: string;

  beforeEach(() => { clearRegistry(); registerJsonCodec(); });

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function setup() {
    dir = await mkdtemp(join(tmpdir(), 'treenix-rawfs-test-'));
    return createRawFsTree(dir);
  }

  it('file → typed node', async () => {
    const tree = await setup();
    await writeFile(join(dir, 'photo.jpg'), 'fake-jpeg');
    const node = await tree.get('/photo.jpg');

    assert.equal(node?.$path, '/photo.jpg');
    assert.equal(node?.$type, 'image/jpeg');
    assert.ok((node as any).meta?.size > 0);
  });

  it('directory → dir node', async () => {
    const tree = await setup();
    await mkdir(join(dir, 'albums'));
    const node = await tree.get('/albums');

    assert.equal(node?.$path, '/albums');
    assert.equal(node?.$type, 'dir');
  });

  it('missing path → undefined', async () => {
    const tree = await setup();
    assert.equal(await tree.get('/nope'), undefined);
  });

  // f9b8dbf narrowed walk's broad readdir catch to ENOENT-only. Calling
  // getChildren on a path that exists as a FILE makes readdir throw ENOTDIR;
  // that error must propagate instead of yielding an empty page.
  it('getChildren on a file path throws ENOTDIR (non-ENOENT readdir)', async () => {
    const tree = await setup();
    await writeFile(join(dir, 'note.txt'), 'a file, not a directory');
    await assert.rejects(
      () => tree.getChildren('/note.txt'),
      (e: NodeJS.ErrnoException) => e.code === 'ENOTDIR',
    );
  });

  it('getChildren lists typed entries', async () => {
    const tree = await setup();
    await writeFile(join(dir, 'a.txt'), 'text');
    await writeFile(join(dir, 'b.csv'), 'col1,col2');
    await mkdir(join(dir, 'sub'));

    const { items } = await tree.getChildren('/');
    assert.equal(items.length, 3);

    const byPath = Object.fromEntries(items.map(n => [n.$path, n.$type]));
    assert.equal(byPath['/a.txt'], 'text/plain');
    assert.equal(byPath['/b.csv'], 'text/csv');
    assert.equal(byPath['/sub'], 'dir');
  });

  it('getChildren applies query filter before limiting', async () => {
    const tree = await setup();
    await writeFile(join(dir, 'a.txt'), 'text');
    await writeFile(join(dir, 'b.txt'), 'text');
    await writeFile(join(dir, 'data.json'), JSON.stringify({ $type: 'custom.data', status: 'open' }));

    const page = await tree.getChildren('/', {
      query: mapSiftQuery({ $type: 'text/plain' }) as Record<string, unknown>,
      limit: 1,
    });

    assert.equal(page.total, 1);
    assert.ok(page.nextCursor);
    assert.deepEqual(page.items.map(n => n.$path), ['/a.txt']);
  });

  it('getChildren respects depth', async () => {
    const tree = await setup();
    await mkdir(join(dir, 'a'));
    await writeFile(join(dir, 'a', 'deep.md'), '# hello');

    const d1 = await tree.getChildren('/', { depth: 1 });
    assert.equal(d1.items.length, 1);
    assert.equal(d1.items[0].$type, 'dir');

    const d2 = await tree.getChildren('/', { depth: 2 });
    assert.equal(d2.items.length, 2);
  });

  it('getChildren depth=-1 returns all descendants (deep)', async () => {
    const tree = await setup();
    await mkdir(join(dir, 'a'));
    await mkdir(join(dir, 'a', 'b'));
    await writeFile(join(dir, 'a', 'b', 'c.md'), '# deep');

    const all = await tree.getChildren('/', { depth: -1 });
    assert.deepEqual(all.items.map(n => n.$path).sort(), ['/a', '/a/b', '/a/b/c.md']);
  });

  it('skips hidden files', async () => {
    const tree = await setup();
    await writeFile(join(dir, '.hidden'), 'secret');
    await writeFile(join(dir, 'visible.txt'), 'hi');

    const { items } = await tree.getChildren('/');
    assert.equal(items.length, 1);
    assert.equal(items[0].$path, '/visible.txt');
  });

  it('skips symlinked files that point outside root', async () => {
    const tree = await setup();
    const outsideDir = await mkdtemp(join(tmpdir(), 'treenix-rawfs-outside-file-'));
    try {
      await writeFile(join(outsideDir, 'secret.txt'), 'secret');
      await writeFile(join(dir, 'visible.txt'), 'visible');
      await symlink(join(outsideDir, 'secret.txt'), join(dir, 'link.txt'));

      const { items } = await tree.getChildren('/');

      assert.deepEqual(items.map(n => n.$path), ['/visible.txt']);
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  it('skips symlinked directories that point outside root', async () => {
    const tree = await setup();
    const outsideDir = await mkdtemp(join(tmpdir(), 'treenix-rawfs-outside-dir-'));
    try {
      await writeFile(join(outsideDir, 'secret.txt'), 'secret');
      await mkdir(join(dir, 'real'));
      await writeFile(join(dir, 'real', 'visible.txt'), 'visible');
      await symlink(outsideDir, join(dir, 'linked'));

      const { items } = await tree.getChildren('/', { depth: 2 });

      const paths = items.map(n => n.$path).sort();
      assert.deepEqual(paths, ['/real', '/real/visible.txt']);
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  it('blocks traversal outside root with typed error', async () => {
    const tree = await setup();
    const outsideDir = await mkdtemp(join(tmpdir(), 'treenix-rawfs-outside-traversal-'));
    try {
      await assert.rejects(
        () => tree.get(`/../${outsideDir.split('/').pop()}`),
        (e: unknown) => e instanceof OpError && e.code === 'FORBIDDEN',
      );
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  it('mime type detection', async () => {
    const tree = await setup();
    const cases: [string, string][] = [
      ['doc.pdf', 'application/pdf'],
      ['style.css', 'text/css'],
      ['data.json', 'application/json'],  // needs valid JSON — codec parses it
      ['clip.mp4', 'video/mp4'],
      ['song.mp3', 'audio/mpeg'],
      ['page.html', 'text/html'],
      ['notes.md', 'text/markdown'],
      ['unknown.xyz', 'application/octet-stream'],
    ];

    for (const [name, expectedType] of cases) {
      const content = name.endsWith('.json') ? '{}' : 'data';
      await writeFile(join(dir, name), content);
      const node = await tree.get('/' + name);
      assert.equal(node?.$type, expectedType, `${name} should be ${expectedType}`);
    }
  });

  it('json file → parsed object, no meta', async () => {
    const tree = await setup();
    await writeFile(join(dir, 'config.json'), JSON.stringify({ name: 'test', count: 42 }));
    const node = await tree.get('/config.json');

    assert.equal(node?.$path, '/config.json');
    assert.equal(node?.$type, 'application/json');
    assert.equal((node as any).name, 'test');
    assert.equal((node as any).count, 42);
    assert.equal((node as any).meta, undefined);
  });

  it('json file preserves $type from content', async () => {
    const tree = await setup();
    await writeFile(join(dir, 'typed.json'), JSON.stringify({ $type: 'my.custom', foo: 'bar' }));
    const node = await tree.get('/typed.json');

    assert.equal(node?.$type, 'my.custom');
    assert.equal((node as any).foo, 'bar');
  });

  it('custom decode enriches node', async () => {
    const tree = await setup();
    await writeFile(join(dir, 'data.csv'), 'name,age\nalice,30\nbob,25');

    register('text/csv', 'decode', async (filePath: string, nodePath: string) => {
      const { readFile } = await import('node:fs/promises');
      const content = await readFile(filePath, 'utf-8');
      const lines = content.trim().split('\n');
      return {
        $path: nodePath,
        $type: 'text/csv',
        columns: lines[0].split(','),
        rowCount: lines.length - 1,
      } as any;
    });

    const node = await tree.get('/data.csv');
    assert.equal(node?.$type, 'text/csv');
    assert.deepEqual((node as any).columns, ['name', 'age']);
    assert.equal((node as any).rowCount, 2);

  });

  // --- Encode tests ---

  it('set() with registered encode writes file', async () => {
    const tree = await setup();

    register('text/plain', 'encode', async (node: NodeData, filePath: string) => {
      await writeFile(filePath, (node as any).content ?? '');
    });

    await tree.set({ $path: '/hello.txt', $type: 'text/plain', content: 'world' } as any);

    const raw = await readFile(join(dir, 'hello.txt'), 'utf-8');
    assert.equal(raw, 'world');

  });

  it('set() without encode throws', async () => {
    const tree = await setup();
    await assert.rejects(
      () => tree.set({ $path: '/x.bin', $type: 'application/octet-stream' } as any),
    );
  });

  it('set() creates parent directories', async () => {
    const tree = await setup();

    register('text/plain', 'encode', async (node: NodeData, filePath: string) => {
      await writeFile(filePath, 'nested');
    });

    await tree.set({ $path: '/deep/nested/file.txt', $type: 'text/plain' } as any);

    const raw = await readFile(join(dir, 'deep', 'nested', 'file.txt'), 'utf-8');
    assert.equal(raw, 'nested');

  });

  it('remove() deletes file', async () => {
    const tree = await setup();
    await writeFile(join(dir, 'gone.txt'), 'bye');

    const result = await tree.remove('/gone.txt');
    assert.ok(result.changes?.length);
    await assert.rejects(() => stat(join(dir, 'gone.txt')), { code: 'ENOENT' });
  });

  it('remove() missing file returns false', async () => {
    const tree = await setup();
    const result = await tree.remove('/nope.txt');
    assert.deepEqual(result.changes, []);
  });

  it('remove() deletes empty directory', async () => {
    const tree = await setup();
    await mkdir(join(dir, 'empty'));

    const result = await tree.remove('/empty');
    assert.ok(result.changes?.length);
    await assert.rejects(() => stat(join(dir, 'empty')), { code: 'ENOENT' });
  });

  // --- .env codec ---

  it('.env file → application/x-env', async () => {
    const tree = await setup();
    await writeFile(join(dir, 'config.env'), 'PORT=3000\nDB=treenix\n');

    const node = await tree.get('/config.env');
    assert.equal(node?.$type, 'application/x-env');
  });

  it('.env roundtrip: decode → encode → decode', async () => {
    const tree = await setup();

    // Register env decode
    register('application/x-env', 'decode', async (filePath: string, nodePath: string) => {
      const content = await readFile(filePath, 'utf-8');
      const env: Record<string, string> = {};
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq === -1) continue;
        env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
      }
      return { $path: nodePath, $type: 'application/x-env', env } as any;
    });

    // Register env encode
    register('application/x-env', 'encode', async (node: NodeData, filePath: string) => {
      const env = (node as any).env as Record<string, string>;
      if (!env) throw new Error('env component required');
      const lines = Object.entries(env).map(([k, v]) => `${k}=${v}`);
      await writeFile(filePath, lines.join('\n') + '\n');
    });

    // Write via tree
    await tree.set({
      $path: '/config.env',
      $type: 'application/x-env',
      env: { PORT: '3000', DB_NAME: 'treenix', FEATURE_X: 'true' },
    } as any);

    // Verify file on disk
    const raw = await readFile(join(dir, 'config.env'), 'utf-8');
    assert.ok(raw.includes('PORT=3000'));
    assert.ok(raw.includes('DB_NAME=treenix'));

    // Read back via tree — roundtrip
    const node = await tree.get('/config.env');
    assert.equal(node?.$type, 'application/x-env');
    assert.deepEqual((node as any).env, { PORT: '3000', DB_NAME: 'treenix', FEATURE_X: 'true' });

  });

  it('.env decode skips comments and empty lines', async () => {
    const tree = await setup();

    register('application/x-env', 'decode', async (filePath: string, nodePath: string) => {
      const content = await readFile(filePath, 'utf-8');
      const env: Record<string, string> = {};
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq === -1) continue;
        env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
      }
      return { $path: nodePath, $type: 'application/x-env', env } as any;
    });

    await writeFile(join(dir, 'config.env'), '# comment\n\nKEY=value\n# another\nFOO=bar\n');
    const node = await tree.get('/config.env');
    assert.deepEqual((node as any).env, { KEY: 'value', FOO: 'bar' });

  });

  describe('scanChildren', () => {
    async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
      const out: T[] = [];
      for await (const e of iter) out.push(e);
      return out;
    }

    it('yields direct children with $path-asc cursor', async () => {
      const tree = await setup();
      await writeFile(join(dir, 'b.txt'), 'b');
      await writeFile(join(dir, 'a.txt'), 'a');
      await writeFile(join(dir, 'c.txt'), 'c');

      const entries = await collect(tree.scanChildren('/'));
      assert.deepEqual(entries.map(e => e.node.$path), ['/a.txt', '/b.txt', '/c.txt']);
      assert.deepEqual(entries.map(e => e.cursor), ['/a.txt', '/b.txt', '/c.txt']);
    });

    it('depth=2 includes subdir entries', async () => {
      const tree = await setup();
      await mkdir(join(dir, 'sub'));
      await writeFile(join(dir, 'sub', 'inner.txt'), 'x');
      await writeFile(join(dir, 'top.txt'), 'y');

      const paths = (await collect(tree.scanChildren('/', { depth: 2 }))).map(e => e.node.$path).sort();
      assert.deepEqual(paths, ['/sub', '/sub/inner.txt', '/top.txt']);
    });

    it('after: cursor is exclusive', async () => {
      const tree = await setup();
      await writeFile(join(dir, 'a'), 'a');
      await writeFile(join(dir, 'b'), 'b');
      await writeFile(join(dir, 'c'), 'c');

      const all = await collect(tree.scanChildren('/'));
      const rest = await collect(tree.scanChildren('/', { after: all[0].cursor }));
      assert.equal(rest.length, 2);
      assert.ok(!rest.some(e => e.cursor === all[0].cursor));
    });

    it('page concat under stable data equals full scan', async () => {
      const tree = await setup();
      for (const n of ['a', 'b', 'c', 'd', 'e']) await writeFile(join(dir, n), n);

      const all = await collect(tree.scanChildren('/'));
      assert.equal(all.length, 5);

      const page1: typeof all = [];
      for await (const e of tree.scanChildren('/')) {
        page1.push(e);
        if (page1.length === 2) break;
      }
      const page2 = await collect(tree.scanChildren('/', { after: page1[1].cursor }));

      assert.deepEqual(
        [...page1, ...page2].map(e => e.node.$path),
        all.map(e => e.node.$path),
      );
    });

    it('AbortSignal rejects pending scan', async () => {
      const tree = await setup();
      await writeFile(join(dir, 'x'), 'x');
      const ac = new AbortController();
      ac.abort();
      await assert.rejects(() => collect(tree.scanChildren('/', { signal: ac.signal })));
    });

    it('iterator return() runs cleanup', async () => {
      const tree = await setup();
      await writeFile(join(dir, 'a'), 'a');
      await writeFile(join(dir, 'b'), 'b');
      const it = tree.scanChildren('/')[Symbol.asyncIterator]();
      const first = await it.next();
      assert.equal(first.done, false);
      const ret = await it.return!();
      assert.equal(ret.done, true);
    });
  });

  // ns6p.4 §3.3.1: mimefs is rev-incapable BY DESIGN — arbitrary codecs
  // rebuild nodes from plain files, $rev is never persisted. A read must
  // come back rev-less and writes must not throw over it; the missing rev
  // routes clients into their refetch branch (invariant 24 scope pin).
  it('rev-incapable: nodes read without $rev stay without, overwrite does not throw', async () => {
    const tree = await setup();
    register('text/plain', 'encode', async (node: NodeData, filePath: string) => {
      await writeFile(filePath, (node as any).content ?? '');
    });
    await writeFile(join(dir, 'note.txt'), 'v1');

    const node = await tree.get('/note.txt');
    assert.ok(node);
    assert.equal(node.$rev, undefined, 'no rev machinery — none synthesized');

    await tree.set({ ...node, $path: '/note.txt', content: 'v2' });
    const again = await tree.get('/note.txt');
    assert.equal(again?.$rev, undefined, 'round-trip through set stays rev-less');
  });
});
