import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { discoverMods } from './discover';

let tmp: string;

async function makePkg(dir: string, pkg: Record<string, unknown>) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'package.json'), JSON.stringify(pkg));
}

describe('discoverMods', () => {
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'treenity-discover-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('finds packages with "treenity" field', async () => {
    await makePkg(join(tmp, 'treenity-mod-weather'), {
      name: 'treenity-mod-weather',
      version: '1.2.3',
      treenity: {
        name: 'weather',
        types: ['weather.sensor', 'weather.config'],
        server: './dist/server.js',
        client: './dist/client.js',
      },
    });

    const mods = await discoverMods(tmp);
    assert.equal(mods.length, 1);
    assert.equal(mods[0].name, 'weather');
    assert.equal(mods[0].version, '1.2.3');
    assert.deepEqual(mods[0].types, ['weather.sensor', 'weather.config']);
    assert.equal(mods[0].server, './dist/server.js');
    assert.equal(mods[0].packagePath, join(tmp, 'treenity-mod-weather'));
  });

  it('ignores packages without "treenity" field', async () => {
    await makePkg(join(tmp, 'express'), { name: 'express', version: '4.0.0' });
    await makePkg(join(tmp, 'treenity-mod-foo'), {
      name: 'treenity-mod-foo',
      treenity: { name: 'foo' },
    });

    const mods = await discoverMods(tmp);
    assert.equal(mods.length, 1);
    assert.equal(mods[0].name, 'foo');
  });

  it('discovers scoped packages (@scope/pkg)', async () => {
    await makePkg(join(tmp, '@myorg', 'treenity-mod-billing'), {
      name: '@myorg/treenity-mod-billing',
      version: '2.0.0',
      treenity: { name: 'billing', dependencies: ['auth'] },
    });

    const mods = await discoverMods(tmp);
    assert.equal(mods.length, 1);
    assert.equal(mods[0].name, 'billing');
    assert.deepEqual(mods[0].dependencies, ['auth']);
  });

  it('handles multiple mods including mixed scoped/unscoped', async () => {
    await makePkg(join(tmp, 'treenity-mod-a'), { name: 'a', treenity: { name: 'alpha' } });
    await makePkg(join(tmp, '@org', 'mod-b'), { name: 'b', treenity: { name: 'beta' } });
    await makePkg(join(tmp, 'lodash'), { name: 'lodash' });
    await makePkg(join(tmp, '@org', 'other'), { name: 'other' });

    const mods = await discoverMods(tmp);
    assert.equal(mods.length, 2);
    const names = mods.map(m => m.name).sort();
    assert.deepEqual(names, ['alpha', 'beta']);
  });

  it('returns empty array for nonexistent directory', async () => {
    const mods = await discoverMods('/nonexistent/path/12345');
    assert.deepEqual(mods, []);
  });

  it('skips packages with malformed package.json', async () => {
    await mkdir(join(tmp, 'broken-mod'), { recursive: true });
    await writeFile(join(tmp, 'broken-mod', 'package.json'), 'NOT JSON{{{');
    await makePkg(join(tmp, 'good-mod'), { name: 'g', treenity: { name: 'good' } });

    const mods = await discoverMods(tmp);
    assert.equal(mods.length, 1);
    assert.equal(mods[0].name, 'good');
  });

  it('skips dot-directories', async () => {
    await makePkg(join(tmp, '.cache'), { name: 'cache', treenity: { name: 'cache' } });
    const mods = await discoverMods(tmp);
    assert.equal(mods.length, 0);
  });

  it('falls back to pkg.name and pkg.version when treenity field is minimal', async () => {
    await makePkg(join(tmp, 'treenity-mod-simple'), {
      name: '@scope/treenity-mod-simple',
      version: '3.0.0',
      treenity: {},
    });

    const mods = await discoverMods(tmp);
    assert.equal(mods.length, 1);
    assert.equal(mods[0].name, '@scope/treenity-mod-simple');
    assert.equal(mods[0].version, '3.0.0');
  });

  it('handles missing version gracefully', async () => {
    await makePkg(join(tmp, 'mod-no-ver'), {
      name: 'mod-no-ver',
      treenity: { name: 'no-ver' },
    });

    const mods = await discoverMods(tmp);
    assert.equal(mods[0].version, '0.0.0');
  });

  it('handles packages with no package.json at all', async () => {
    await mkdir(join(tmp, 'empty-dir'), { recursive: true });
    await makePkg(join(tmp, 'real-mod'), { name: 'r', treenity: { name: 'real' } });

    const mods = await discoverMods(tmp);
    assert.equal(mods.length, 1);
  });
});
