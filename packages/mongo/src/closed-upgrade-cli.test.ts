import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { it } from 'node:test';
import { loadUpgradeDeployment, upgradeKernelCli } from '@treenx/core/tools/upgrade-kernel';

it('loads closed Mongo deployment mappings through the real offline CLI and preserves its backup and repeat result', async () => {
  const parent = resolve('temp/closed-upgrade-cli-fixtures');
  await mkdir(parent, { recursive: true });
  const area = await mkdtemp(`${parent}/run-`);
  const root = join(area, 'data');
  await mkdir(join(root, 'mount'), { recursive: true });
  await writeFile(join(root, '.treenix-version'), '1\n');
  await writeFile(join(root, '$.json'), JSON.stringify({ $type: 'dir', $id: 'root-id' }));
  const uri = 'mongodb://127.0.0.1:27017/?replicaSet=upgrade';
  const legacy = JSON.stringify({
    $type: 't.mount.mongo',
    $id: 'mount-id',
    uri,
    db: 'data',
    collection: 'nodes',
  });
  await writeFile(join(root, 'mount', '$.json'), legacy);
  const deployment = join(area, 'deployment.mjs');
  await writeFile(
    deployment,
    `import { createRegistry } from ${JSON.stringify(new URL('../../../core/src/kernel/registry.ts', import.meta.url).href)};
import { kernelManifest } from ${JSON.stringify(new URL('../../../core/src/kernel/builtins.ts', import.meta.url).href)};
import { createMongoManifest } from ${JSON.stringify(new URL('./native-mount.ts', import.meta.url).href)};
const registry = createRegistry();
registry.publish(kernelManifest);
registry.publish(createMongoManifest({ cluster: { connection: '/connection', domain: 'upgrade', instance: 'upgrade', journalDb: 'journal', journalCollection: 'records' } }));
export const upgradeDeployment = { registry, mongoConnections: { ${JSON.stringify(uri)}: { cluster: 'cluster', path: '/connection' } } };
`,
  );
  assert.deepEqual((await loadUpgradeDeployment(deployment)).mongoConnections, {
    [uri]: { cluster: 'cluster', path: '/connection' },
  });
  const plan = join(area, 'plan.json');
  const args = ['--root', root, '--deployment', deployment, '--plan', plan];
  await upgradeKernelCli([...args, '--dry-run']);
  assert.equal(await readFile(join(root, 'mount', '$.json'), 'utf8'), legacy);
  const backup = join(area, 'backup');
  await upgradeKernelCli([...args, '--apply', '--backup', backup]);
  assert.equal(await readFile(join(backup, 'files', 'mount', '$.json'), 'utf8'), legacy);
  const mount = JSON.parse(await readFile(join(root, 'mount', '$.json'), 'utf8'));
  assert.equal(mount.$id, 'mount-id');
  assert.equal(mount.cluster, 'cluster');
  assert.equal('uri' in mount, false);
  const connection = await readFile(join(root, 'connection', '$.json'), 'utf8');
  const closed = JSON.parse(connection);
  assert.equal(closed.$type, 't.mongo.connection');
  assert.equal(closed.uri, uri);
  assert.ok(typeof closed.$id === 'string' && closed.$id.length !== 0);
  assert.deepEqual(closed.$acl, [
    { subject: { group: 'admins' }, grant: 7 },
    { subject: { group: 'n:mount-id' }, grant: 1 },
  ]);
  await upgradeKernelCli([...args, '--apply', '--backup', backup]);
  assert.equal(await readFile(join(root, 'connection', '$.json'), 'utf8'), connection);
});
