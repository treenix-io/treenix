import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { resolve } from 'node:path';
import { clearModRegistry, confine, loadLocalMods } from './loader';
import { createTwpHttpRoutes } from '#server/http-routes';

describe('all engine mods import', () => {
  beforeEach(() => clearModRegistry());

  it('every engine native module factory loads without error', async t => {
    const httpRoutes = createTwpHttpRoutes();
    const owner = httpRoutes.bind();
    t.after(() => owner.close());

    // engine/core/src/mod/ → engine/mods (3 levels up + sibling)
    const modsDir = resolve(import.meta.dirname, '../../../mods');
    const result = await loadLocalMods(modsDir, 'kernel', { host: { httpRoutes } });

    if (result.failed.length) {
      const details = result.failed.map(f => `  ${f.name}: ${f.error.message}`).join('\n');
      assert.fail(`${result.failed.length} mod(s) failed:\n${details}`);
    }

    assert.ok(result.loaded.length > 0, 'should discover at least one mod');
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
