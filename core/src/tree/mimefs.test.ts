import type { NodeData } from '#core';
import { register } from '#core';
import { clearRegistry } from '#core/index.test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { registerJsonCodec } from './json-codec';
import { createRawFsStore } from './mimefs';

describe('RawFsStore', () => {
  let dir: string;

  beforeEach(() => { clearRegistry(); registerJsonCodec(); });

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function setup() {
    dir = await mkdtemp(join(tmpdir(), 'treenity-rawfs-test-'));
    return createRawFsStore(dir);
  }

  it('file → typed node', async () => {
    const store = await setup();
    await writeFile(join(dir, 'photo.jpg'), 'fake-jpeg');
    const node = await store.get('/photo.jpg');

    assert.equal(node?.$path, '/photo.jpg');
    assert.equal(node?.$type, 'image/jpeg');
    assert.ok((node as any).meta?.size > 0);
  });

  it('directory → dir node', async () => {
    const store = await setup();
    await mkdir(join(dir, 'albums'));
    const node = await store.get('/albums');

    assert.equal(node?.$path, '/albums');
    assert.equal(node?.$type, 'dir');
  });

  it('missing path → undefined', async () => {
    const store = await setup();
    assert.equal(await store.get('/nope'), undefined);
  });

  it('getChildren lists typed entries', async () => {
    const store = await setup();
    await writeFile(join(dir, 'a.txt'), 'text');
    await writeFile(join(dir, 'b.csv'), 'col1,col2');
    await mkdir(join(dir, 'sub'));

    const { items } = await store.getChildren('/');
    assert.equal(items.length, 3);

    const byPath = Object.fromEntries(items.map(n => [n.$path, n.$type]));
    assert.equal(byPath['/a.txt'], 'text/plain');
    assert.equal(byPath['/b.csv'], 'text/csv');
    assert.equal(byPath['/sub'], 'dir');
  });

  it('getChildren respects depth', async () => {
    const store = await setup();
    await mkdir(join(dir, 'a'));
    await writeFile(join(dir, 'a', 'deep.md'), '# hello');

    const d1 = await store.getChildren('/', { depth: 1 });
    assert.equal(d1.items.length, 1);
    assert.equal(d1.items[0].$type, 'dir');

    const d2 = await store.getChildren('/', { depth: 2 });
    assert.equal(d2.items.length, 2);
  });

  it('skips hidden files', async () => {
    const store = await setup();
    await writeFile(join(dir, '.hidden'), 'secret');
    await writeFile(join(dir, 'visible.txt'), 'hi');

    const { items } = await store.getChildren('/');
    assert.equal(items.length, 1);
    assert.equal(items[0].$path, '/visible.txt');
  });

  it('mime type detection', async () => {
    const store = await setup();
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
      const node = await store.get('/' + name);
      assert.equal(node?.$type, expectedType, `${name} should be ${expectedType}`);
    }
  });

  it('json file → parsed object, no meta', async () => {
    const store = await setup();
    await writeFile(join(dir, 'config.json'), JSON.stringify({ name: 'test', count: 42 }));
    const node = await store.get('/config.json');

    assert.equal(node?.$path, '/config.json');
    assert.equal(node?.$type, 'application/json');
    assert.equal((node as any).name, 'test');
    assert.equal((node as any).count, 42);
    assert.equal((node as any).meta, undefined);
  });

  it('json file preserves $type from content', async () => {
    const store = await setup();
    await writeFile(join(dir, 'typed.json'), JSON.stringify({ $type: 'my.custom', foo: 'bar' }));
    const node = await store.get('/typed.json');

    assert.equal(node?.$type, 'my.custom');
    assert.equal((node as any).foo, 'bar');
  });

  it('custom decode enriches node', async () => {
    const store = await setup();
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

    const node = await store.get('/data.csv');
    assert.equal(node?.$type, 'text/csv');
    assert.deepEqual((node as any).columns, ['name', 'age']);
    assert.equal((node as any).rowCount, 2);

  });

  // --- Encode tests ---

  it('set() with registered encode writes file', async () => {
    const store = await setup();

    register('text/plain', 'encode', async (node: NodeData, filePath: string) => {
      await writeFile(filePath, (node as any).content ?? '');
    });

    await store.set({ $path: '/hello.txt', $type: 'text/plain', content: 'world' } as any);

    const raw = await readFile(join(dir, 'hello.txt'), 'utf-8');
    assert.equal(raw, 'world');

  });

  it('set() without encode throws', async () => {
    const store = await setup();
    await assert.rejects(
      () => store.set({ $path: '/x.bin', $type: 'application/octet-stream' } as any),
    );
  });

  it('set() creates parent directories', async () => {
    const store = await setup();

    register('text/plain', 'encode', async (node: NodeData, filePath: string) => {
      await writeFile(filePath, 'nested');
    });

    await store.set({ $path: '/deep/nested/file.txt', $type: 'text/plain' } as any);

    const raw = await readFile(join(dir, 'deep', 'nested', 'file.txt'), 'utf-8');
    assert.equal(raw, 'nested');

  });

  it('remove() deletes file', async () => {
    const store = await setup();
    await writeFile(join(dir, 'gone.txt'), 'bye');

    const result = await store.remove('/gone.txt');
    assert.equal(result, true);
    await assert.rejects(() => stat(join(dir, 'gone.txt')), { code: 'ENOENT' });
  });

  it('remove() missing file returns false', async () => {
    const store = await setup();
    const result = await store.remove('/nope.txt');
    assert.equal(result, false);
  });

  it('remove() deletes empty directory', async () => {
    const store = await setup();
    await mkdir(join(dir, 'empty'));

    const result = await store.remove('/empty');
    assert.equal(result, true);
    await assert.rejects(() => stat(join(dir, 'empty')), { code: 'ENOENT' });
  });

  // --- .env codec ---

  it('.env file → application/x-env', async () => {
    const store = await setup();
    await writeFile(join(dir, 'config.env'), 'PORT=3000\nDB=treenity\n');

    const node = await store.get('/config.env');
    assert.equal(node?.$type, 'application/x-env');
  });

  it('.env roundtrip: decode → encode → decode', async () => {
    const store = await setup();

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

    // Write via store
    await store.set({
      $path: '/config.env',
      $type: 'application/x-env',
      env: { PORT: '3000', DB_NAME: 'treenity', FEATURE_X: 'true' },
    } as any);

    // Verify file on disk
    const raw = await readFile(join(dir, 'config.env'), 'utf-8');
    assert.ok(raw.includes('PORT=3000'));
    assert.ok(raw.includes('DB_NAME=treenity'));

    // Read back via store — roundtrip
    const node = await store.get('/config.env');
    assert.equal(node?.$type, 'application/x-env');
    assert.deepEqual((node as any).env, { PORT: '3000', DB_NAME: 'treenity', FEATURE_X: 'true' });

  });

  it('.env decode skips comments and empty lines', async () => {
    const store = await setup();

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
    const node = await store.get('/config.env');
    assert.deepEqual((node as any).env, { KEY: 'value', FOO: 'bar' });

  });
});
