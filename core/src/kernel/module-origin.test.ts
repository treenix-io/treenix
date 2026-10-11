import assert from 'node:assert/strict';
import { realpath, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { KernelError } from '#errors';
import { getCollectedModule } from '#kernel/manifest';
import { loadLocalMods } from '#mod/loader';
import { openNativeDeployment } from '#server/native-deployment';

/** Default discovery and explicit deployment must retain one actual imported side-effect owner. */
test('module cache retains discovered autostart across path and explicit file URL', { timeout: 10_000 }, async () => {
  const directory = fileURLToPath(new URL('../mods/', import.meta.url));
  const loaded = await loadLocalMods(directory, 'kernel');
  assert.equal(loaded.failed.find(entry => entry.name === 'autostart'), undefined);
  const first = loaded.manifests.find(manifest => manifest.id === '@treenx/core/autostart');
  assert.ok(first);
  assert.deepEqual(first.types.map(type => type.name), ['t.autostart']);
  const path = await realpath(fileURLToPath(new URL('../mods/autostart/kernel.ts', import.meta.url)));
  assert.equal(getCollectedModule(first.id, path), first);
  assert.equal(getCollectedModule(first.id, pathToFileURL(path).href), first);
  assert.equal(getCollectedModule(first.id, `${pathToFileURL(path).href}?deployment=other`), undefined);
  assert.equal(getCollectedModule(first.id, `${pathToFileURL(path).href}#other`), undefined);
  assert.throws(() => getCollectedModule('another-owner', pathToFileURL(path).href),
    error => error instanceof KernelError && error.code === 'CONFLICT');
  const data = await mkdtemp(resolve('temp/native-module-origin-'));
  const runtime = await openNativeDeployment({ runtime: { id: 'module-origin', directory: data, credentialTtlMs: 60_000,
    firstAdmin: { path: '/admin', name: 'admin', password: 'origin-password' } },
    modules: [{ id: first.id, entry: pathToFileURL(path).href }] });
  try {
    const type = runtime.instance.registry.type('t.autostart');
    assert.equal(type.module, first.id);
    assert.deepEqual(Object.keys(type.actions), ['start', 'stop']);
  } finally { await runtime.close(); }
});
