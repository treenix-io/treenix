import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { loadLocalMods } from '#mod/loader';

/** The ordinary core module directory must discover its actual native system owner. */
test('platform kernel entry publishes the existing native reflection owner', async () => {
  const loaded = await loadLocalMods(fileURLToPath(new URL('../', import.meta.url)), 'kernel');
  const failure = loaded.failed.find(entry => entry.name === 'platform');
  assert.equal(failure, undefined);
  assert.ok(loaded.loaded.includes('platform'));
  const manifest = loaded.manifests.find(entry => entry.id === 'treenix.system');
  assert.ok(manifest);
  assert.deepEqual(manifest.types.map(type => type.name), ['t.system']);
  assert.deepEqual(Object.keys(manifest.types[0].actions), ['deploy_prefab', 'catalog', 'describe_type', 'search_types']);
});
