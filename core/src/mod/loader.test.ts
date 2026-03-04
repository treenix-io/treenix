import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { clearModRegistry, getLoadedMods, getMod, isModLoaded, loadMods, sortByDependencies } from './loader';
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
