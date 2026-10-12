import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { it } from 'node:test';
import { openNativeRuntime } from '#kernel/runtime';
import { drainSession } from '#kernel/session-delivery';
import { backupInstance, restoreArtifact, verifyArtifact } from '#server/backup';

/** Capture every private control file without changing the closed dataset. */
async function controlFiles(directory: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const root = join(directory, '.treenix');
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      const file = join(entry.parentPath, entry.name);
      result[file.slice(root.length)] = (await readFile(file)).toString('base64');
    }
  }
  return result;
}

it(
  'backs up native control files and reopens the restored accepted node',
  { timeout: 15000 },
  async (t) => {
    const parent = resolve(import.meta.dirname, '../../../../temp/native-backup-first-pass');
    await mkdir(parent, { recursive: true });
    const fixture = await mkdtemp(join(parent, 'dataset-'));
    const directory = join(fixture, 'source');
    const config = {
      id: randomUUID(),
      directory,
      rootExternal: 'none' as const,
      credentialTtlMs: 60000,
      firstAdmin: { path: '/admin', name: 'admin', password: randomUUID() },
      modules: [],
    };
    const runtime = await openNativeRuntime(config);
    assert.ok(runtime.instance.setupCredential);
    const credential = runtime.instance.setupCredential;
    const session = await runtime.instance.openSession(credential);
    const delivery = drainSession(session);
    t.after(async () => {
      session.close();
      await delivery;
      await runtime.close();
    });

    await session.commit({
      opId: { epoch: runtime.instance.writer.intake.epoch, time: Date.now(), nonce: randomUUID() },
      changes: [{ op: 'put', node: { $path: '/kept', $type: 't.dir', title: 'preserved' } }],
    }).outcome;
    const before = (await session.read({ node: '/kept' })).copies[0];
    if ('error' in before) throw before.error;
    session.close();
    await delivery;
    await runtime.close();

    const controls = await controlFiles(directory);
    assert.ok(Object.keys(controls).some((file) => file.endsWith('.json')));
    const rootConfig = join(fixture, 'root.json');
    await writeFile(
      rootConfig,
      JSON.stringify({
        $path: '/',
        $type: 'root',
        '#mount': { $type: 't.mount.fs', root: 'source' },
      }),
    );
    const cwd = process.cwd();
    process.chdir(fixture);
    t.after(() => process.chdir(cwd));
    const artifact = await backupInstance(rootConfig, join(fixture, 'backups'));
    assert.ok(artifact.manifest.dirs[0].nodes > 0);
    assert.deepEqual(await verifyArtifact(artifact.artifactDir), artifact.manifest);

    const target = join(fixture, 'restored');
    await restoreArtifact(artifact.artifactDir, { into: target });
    const restoredDirectory = join(target, 'source');
    assert.deepEqual(await controlFiles(restoredDirectory), controls);
    assert.deepEqual(await controlFiles(directory), controls);

    const restored = await openNativeRuntime({ ...config, directory: restoredDirectory });
    const reader = await restored.instance.openSession(credential);
    const restoredDelivery = drainSession(reader);
    try {
      const after = (await reader.read({ node: '/kept' })).copies[0];
      if ('error' in after) throw after.error;
      assert.deepEqual(after.node, before.node);
    } finally {
      reader.close();
      await restoredDelivery;
      await restored.close();
    }
  },
);
