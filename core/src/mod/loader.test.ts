import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { chmod, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { resolveExact, unregister } from '#core';
import { clearModRegistry, confine, getLoadedMods, isModLoaded, loadLocalMods } from './loader';
import { getCurrentMod } from './tracking';

describe('all engine mods import', () => {
  beforeEach(() => clearModRegistry());

  it('every engine mod server.ts imports without error', async () => {
    // engine/core/src/mod/ → engine/mods (3 levels up + sibling)
    const modsDir = resolve(import.meta.dirname, '../../../mods');
    const result = await loadLocalMods(modsDir, 'server');

    if (result.failed.length) {
      const details = result.failed.map(f => `  ${f.name}: ${f.error.message}`).join('\n');
      assert.fail(`${result.failed.length} mod(s) failed:\n${details}`);
    }

    assert.ok(result.loaded.length > 0, 'should discover at least one mod');
  });
});

describe('loadLocalMods', () => {
  let tmpDir: string;

  beforeEach(async () => {
    clearModRegistry();
    const scratch = resolve(import.meta.dirname, '../../../../temp');
    await mkdir(scratch, { recursive: true });
    tmpDir = await mkdtemp(join(scratch, 'treenix-mods-'));
  });

  afterEach(async () => {
    unregister('loader.item', 'schema');
    clearModRegistry();
  });

  async function mod(name: string, source = 'export const ready = true;'): Promise<string> {
    const dir = join(tmpDir, name);
    await mkdir(dir);
    await writeFile(join(dir, 'server.ts'), source);
    return dir;
  }

  it('discovers a server entry and publishes success after its schemas load', async () => {
    const dir = await mod('my-mod');
    await mkdir(join(dir, 'schemas'));
    await writeFile(join(dir, 'schemas', 'item.json'), JSON.stringify({
      $id: 'loader.item', type: 'object', properties: {},
    }));
    const result = await loadLocalMods(tmpDir, 'server');
    assert.deepEqual(result.loaded, ['my-mod']);
    assert.deepEqual(result.failed, []);
    assert.equal(isModLoaded('my-mod'), true);
    assert.equal(typeof getLoadedMods()[0].loadedAt, 'number');
    assert.equal(resolveExact('loader.item', 'schema')?.().$id, 'loader.item');
    assert.equal(getCurrentMod(), null);
  });

  it('reports an invalid schema only as a failed module and leaves siblings available', async () => {
    const dir = await mod('bad-schema');
    await mod('good');
    await mkdir(join(dir, 'schemas'));
    await writeFile(join(dir, 'schemas', 'broken.json'), '{');
    const result = await loadLocalMods(tmpDir, 'server');
    assert.deepEqual(result.loaded, ['good']);
    assert.deepEqual(result.failed.map(f => f.name), ['bad-schema']);
    assert.ok(result.failed[0].error instanceof SyntaxError);
    assert.equal(isModLoaded('bad-schema'), false);
    assert.equal(getLoadedMods().find(m => m.name === 'bad-schema')?.state, 'failed');
    assert.equal(getCurrentMod(), null);
  });

  it('resets module attribution after an import failure and still loads siblings', async () => {
    await mod('bad-import', 'throw new TypeError();');
    await mod('good');
    const result = await loadLocalMods(tmpDir, 'server');
    assert.deepEqual(result.loaded, ['good']);
    assert.deepEqual(result.failed.map(f => f.name), ['bad-import']);
    assert.ok(result.failed[0].error instanceof TypeError);
    assert.equal(getCurrentMod(), null);
  });

  it('skips a module without a matching client entry and hidden directories', async () => {
    await mod('server-only');
    await mod('.hidden-mod');
    const client = await loadLocalMods(tmpDir, 'client');
    assert.deepEqual(client.loaded, []);
    const server = await loadLocalMods(tmpDir, 'server');
    assert.deepEqual(server.loaded, ['server-only']);
  });

  it('treats a missing optional directory as absence', async () => {
    const result = await loadLocalMods(join(tmpDir, 'missing'), 'server');
    assert.deepEqual(result.loaded, []);
    assert.deepEqual(result.failed, []);
  });

  it('propagates directory discovery failures instead of reporting an empty module set', async () => {
    const file = join(tmpDir, 'file');
    await writeFile(file, 'not a directory');
    await assert.rejects(() => loadLocalMods(file, 'server'),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOTDIR');
  });

  it('propagates inaccessible entry discovery instead of silently omitting the module', async () => {
    const dir = await mod('inaccessible');
    await chmod(dir, 0o600);
    try {
      await assert.rejects(() => loadLocalMods(tmpDir, 'server'),
        (error: unknown) => error instanceof Error && 'code' in error && error.code === 'EACCES');
    } finally {
      await chmod(dir, 0o755);
    }
  });

  it('propagates malformed package metadata while discovering a published mod package', async () => {
    const dir = join(tmpDir, 'node_modules', 'test-package');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'package.json'), '{');
    await assert.rejects(() => loadLocalMods(dir, 'server'), SyntaxError);
  });

  it('rejects published package metadata without a nonempty package name', async () => {
    const dir = join(tmpDir, 'node_modules', 'test-package');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'package.json'), '{}');
    await assert.rejects(() => loadLocalMods(dir, 'server'), TypeError);
  });

  it('rejects an entry symlink that leaves its module root', async () => {
    const outside = join(tmpDir, 'outside.ts');
    await writeFile(outside, 'throw new TypeError();');
    const dir = join(tmpDir, 'symlink-mod');
    await mkdir(dir);
    await symlink(outside, join(dir, 'server.ts'));
    const result = await loadLocalMods(tmpDir, 'server');
    assert.deepEqual(result.loaded, []);
    assert.deepEqual(result.failed.map(f => f.name), ['symlink-mod']);
    assert.ok(result.failed[0].error instanceof Error);
    assert.equal(getCurrentMod(), null);
  });
});

describe('confine — F11 manifest path containment', () => {
  it('returns resolved path when candidate stays inside packagePath', () => {
    assert.equal(confine('/pkg/foo', 'server.js'), resolve('/pkg/foo', 'server.js'));
    assert.equal(confine('/pkg/foo', './sub/server.js'), resolve('/pkg/foo', 'sub/server.js'));
  });

  it('throws when candidate escapes via ..', () => {
    assert.throws(() => confine('/pkg/foo', '../../etc/passwd.js'), Error);
  });

  it('throws when candidate is absolute', () => {
    assert.throws(() => confine('/pkg/foo', '/etc/passwd.js'), Error);
  });

  it('allows packagePath itself (empty candidate)', () => {
    assert.equal(confine('/pkg/foo', ''), resolve('/pkg/foo'));
  });
});
