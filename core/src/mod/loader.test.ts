import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { clearModRegistry, getLoadedMods, getMod, isModLoaded, loadLocalMods, loadMods, sortByDependencies } from './loader';
import type { ModManifest } from './types';

function m(name: string, deps?: string[]): ModManifest {
  return { name, version: '1.0.0', dependencies: deps };
}

describe('sortByDependencies', () => {
  it('returns mods in dependency order', () => {
    const mods = [m('app', ['ui', 'auth']), m('auth', ['core']), m('ui', ['core']), m('core')];
    const sorted = sortByDependencies(mods);
    const names = sorted.map(m => m.name);

    // core must come before auth and ui; auth and ui before app
    assert.ok(names.indexOf('core') < names.indexOf('auth'));
    assert.ok(names.indexOf('core') < names.indexOf('ui'));
    assert.ok(names.indexOf('auth') < names.indexOf('app'));
    assert.ok(names.indexOf('ui') < names.indexOf('app'));
  });

  it('handles no dependencies', () => {
    const mods = [m('a'), m('b'), m('c')];
    const sorted = sortByDependencies(mods);
    assert.equal(sorted.length, 3);
  });

  it('throws on missing dependency', () => {
    assert.throws(
      () => sortByDependencies([m('app', ['ghost'])]),
    );
  });

  it('throws on circular dependency (simple cycle)', () => {
    assert.throws(
      () => sortByDependencies([m('a', ['b']), m('b', ['a'])]),
    );
  });

  it('throws on circular dependency (3-node cycle)', () => {
    assert.throws(
      () => sortByDependencies([m('a', ['b']), m('b', ['c']), m('c', ['a'])]),
    );
  });

  it('handles diamond dependency (A→B,C; B→D; C→D)', () => {
    const mods = [m('A', ['B', 'C']), m('B', ['D']), m('C', ['D']), m('D')];
    const sorted = sortByDependencies(mods);
    const names = sorted.map(m => m.name);

    assert.ok(names.indexOf('D') < names.indexOf('B'));
    assert.ok(names.indexOf('D') < names.indexOf('C'));
    assert.ok(names.indexOf('B') < names.indexOf('A'));
    assert.ok(names.indexOf('C') < names.indexOf('A'));
  });

  it('handles deep chain', () => {
    const chain = Array.from({ length: 10 }, (_, i) => m(`m${i}`, i > 0 ? [`m${i - 1}`] : []));
    const sorted = sortByDependencies(chain.reverse()); // reverse to make it harder
    const names = sorted.map(m => m.name);

    for (let i = 1; i < 10; i++) {
      assert.ok(names.indexOf(`m${i - 1}`) < names.indexOf(`m${i}`),
        `m${i - 1} should come before m${i}`);
    }
  });

  it('handles single mod with self-dependency as circular', () => {
    assert.throws(
      () => sortByDependencies([m('narcissist', ['narcissist'])]),
    );
  });

  it('detects partial cycle (some acyclic, some cyclic)', () => {
    assert.throws(
      () => sortByDependencies([m('ok'), m('a', ['b']), m('b', ['a'])]),
    );
  });
});

describe('loadMods', () => {
  beforeEach(() => clearModRegistry());

  it('loads mods without entry points (manifest-only)', async () => {
    const result = await loadMods([m('simple')], 'server');
    assert.deepEqual(result.loaded, ['simple']);
    assert.deepEqual(result.failed, []);
    assert.equal(isModLoaded('simple'), true);
  });

  it('tracks loaded mods in registry', async () => {
    await loadMods([m('a'), m('b')], 'server');
    assert.equal(getLoadedMods().length, 2);
    assert.equal(getMod('a')?.state, 'loaded');
    assert.equal(getMod('b')?.state, 'loaded');
  });

  it('fails if dependency not loaded', async () => {
    const manifest: ModManifest = {
      name: 'orphan',
      version: '1.0.0',
      dependencies: ['missing'],
    };

    // sortByDependencies will throw on unknown dep
    await assert.rejects(
      () => loadMods([manifest], 'server'),
    );
  });

  it('fails gracefully on bad import path', async () => {
    const manifest: ModManifest = {
      name: 'bad-import',
      version: '1.0.0',
      server: './nonexistent.js',
      packagePath: '/tmp/fake-package',
    };

    const result = await loadMods([manifest], 'server');
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].name, 'bad-import');
    assert.equal(getMod('bad-import')?.state, 'failed');
  });

  it('clearModRegistry resets state', async () => {
    await loadMods([m('x')], 'server');
    assert.equal(getLoadedMods().length, 1);
    clearModRegistry();
    assert.equal(getLoadedMods().length, 0);
    assert.equal(getMod('x'), undefined);
  });

  it('records loadedAt timestamp', async () => {
    const before = Date.now();
    await loadMods([m('timed')], 'server');
    const after = Date.now();
    const mod = getMod('timed')!;
    assert.ok(mod.loadedAt! >= before && mod.loadedAt! <= after);
  });

  it('loads dependencies before dependents', async () => {
    const order: string[] = [];

    // We can't easily mock dynamic imports, but we can verify the sorted order
    // by checking that dependencies resolve in order within the registry
    const mods = [m('child', ['parent']), m('parent')];
    await loadMods(mods, 'client');

    const loaded = getLoadedMods();
    const parentIdx = loaded.findIndex(m => m.manifest!.name === 'parent');
    const childIdx = loaded.findIndex(m => m.manifest!.name === 'child');
    assert.ok(parentIdx < childIdx, 'parent should load before child');
  });

  it('records loadDurationMs on success', async () => {
    await loadMods([m('dur')], 'server');
    const mod = getMod('dur')!;
    assert.equal(typeof mod.loadDurationMs, 'number');
    assert.ok(mod.loadDurationMs! >= 0);
  });

  it('times out on hanging onLoad', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'treenix-timeout-'));
    const modDir = join(dir, 'hang-mod');
    mkdirSync(modDir);
    writeFileSync(join(modDir, 'server.mjs'), `
      export default {
        name: 'hang-mod',
        onLoad: () => new Promise(() => {}),
      };
    `);

    const manifest = {
      name: 'hang-mod',
      version: '1.0.0',
      server: './server.mjs',
      packagePath: modDir,
    };

    const result = await loadMods([manifest], 'server', undefined, { modTimeout: 100 });
    assert.equal(result.failed.length, 1);
    assert.ok(result.failed[0].error.message.includes('timed out'));
    assert.equal(getMod('hang-mod')?.state, 'failed');

    rmSync(dir, { recursive: true });
  });

  it('times out on hanging seed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'treenix-timeout-'));
    const modDir = join(dir, 'hang-seed');
    mkdirSync(modDir);
    writeFileSync(join(modDir, 'server.mjs'), `
      export default {
        name: 'hang-seed',
        seed: () => new Promise(() => {}),
      };
    `);

    const manifest = {
      name: 'hang-seed',
      version: '1.0.0',
      server: './server.mjs',
      packagePath: modDir,
    };

    const { createMemoryTree } = await import('#tree');
    const tree = createMemoryTree();
    const result = await loadMods([manifest], 'server', tree, { modTimeout: 100 });
    assert.equal(result.failed.length, 1);
    assert.ok(result.failed[0].error.message.includes('timed out'));

    rmSync(dir, { recursive: true });
  });

  it('subsequent failed mod does not block already-loaded mods', async () => {
    const mods: ModManifest[] = [
      m('ok-mod'),
      { name: 'fail-mod', version: '1.0.0', server: './nope.js', packagePath: '/bad' },
    ];

    const result = await loadMods(mods, 'server');
    assert.equal(result.loaded.length, 1);
    assert.equal(result.failed.length, 1);
    assert.equal(isModLoaded('ok-mod'), true);
    assert.equal(isModLoaded('fail-mod'), false);
  });
});

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

  beforeEach(() => {
    clearModRegistry();
    tmpDir = mkdtempSync(join(tmpdir(), 'treenix-mods-'));
  });

  it('discovers mod with server.ts in a directory', async () => {
    const modDir = join(tmpDir, 'my-mod');
    mkdirSync(modDir);
    writeFileSync(join(modDir, 'server.ts'), 'globalThis.__canary_server_loaded = true;');

    const result = await loadLocalMods(tmpDir, 'server');
    assert.deepEqual(result.loaded, ['my-mod']);
    assert.equal(result.failed.length, 0);

    rmSync(tmpDir, { recursive: true });
  });

  it('skips mod without matching entry file', async () => {
    const modDir = join(tmpDir, 'server-only');
    mkdirSync(modDir);
    writeFileSync(join(modDir, 'server.ts'), '');

    const result = await loadLocalMods(tmpDir, 'client');
    assert.deepEqual(result.loaded, []);

    rmSync(tmpDir, { recursive: true });
  });

  it('returns empty for nonexistent directory', async () => {
    const result = await loadLocalMods('/tmp/no-such-dir-xyz-42', 'server');
    assert.deepEqual(result.loaded, []);
    assert.deepEqual(result.failed, []);
  });

  it('skips hidden directories', async () => {
    const modDir = join(tmpDir, '.hidden-mod');
    mkdirSync(modDir);
    writeFileSync(join(modDir, 'server.ts'), '');

    const result = await loadLocalMods(tmpDir, 'server');
    assert.deepEqual(result.loaded, []);

    rmSync(tmpDir, { recursive: true });
  });
});
