import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { createNode } from '#core';
import { createFsTree } from '#tree/fs';
import { NS_VERSION, VERSION_FILE } from '#tree/migrate-component-namespace';
import { backupInstance, BackupError, restoreArtifact, verifyArtifact } from '#server/backup';

const silent = () => {};

describe('instance backup/restore (gk8.9)', () => {
  let tmp: string;
  let baseDir: string;
  let workDir: string;
  let rootJson: string;
  let out: string;
  let cwd: string;

  // Real fs-adapter data: version marker, leaf and dir node forms.
  async function seedInstance() {
    const base = await createFsTree(baseDir);
    await base.set(createNode('/', 'root'));
    await base.set(createNode('/app', 'dir', { title: 'App' }));
    await base.set(createNode('/app/config', 'dir', { theme: 'dark' }));

    const work = await createFsTree(workDir);
    await work.set(createNode('/', 'root'));
    await work.set(createNode('/notes', 'dir', { body: 'hello' }));

    await writeFile(rootJson, JSON.stringify({
      $path: '/', $type: 'root',
      '#mount': { $type: 't.mount.overlay', layers: ['base', 'work'] },
      '#base': { $type: 't.mount.fs', root: baseDir },
      '#work': { $type: 't.mount.fs', root: workDir },
    }, null, 2));
  }

  beforeEach(async () => {
    cwd = process.cwd();
    tmp = await mkdtemp(join(tmpdir(), 'treenix-gk89-'));
    baseDir = join(tmp, 'tree', 'base');
    workDir = join(tmp, 'tree', 'work');
    rootJson = join(tmp, 'root.json');
    out = join(tmp, 'backups');
    await seedInstance();
  });

  afterEach(async () => {
    process.chdir(cwd);
    mock.restoreAll();
    await rm(tmp, { recursive: true, force: true });
  });

  it('backup produces one artifact: config + dirs + manifest with counts', async () => {
    const { artifactDir, manifest } = await backupInstance(rootJson, out, silent);

    assert.equal(manifest.treenixBackup, 1);
    assert.equal(manifest.rootConfig, 'root.json');
    assert.equal(manifest.dirs.length, 2);
    assert.ok(manifest.dirs.every((d) => d.kind === 'fs' && d.nodes > 0));
    assert.ok(manifest.dirs.every((d) => d.files >= 1), 'version marker counted as file');
    assert.ok(manifest.engineVersion.length > 0);

    const top = await readdir(artifactDir);
    assert.ok(top.includes('manifest.json'));
    assert.ok(top.includes('root.json'));
    assert.ok(top.includes('dirs'));

    const copied = await readFile(join(artifactDir, manifest.dirs[0].artifactPath, 'app', '$.json'), 'utf-8');
    assert.equal(JSON.parse(copied).title, 'App');
  });

  it('verify passes on a fresh artifact and is read-only', async () => {
    const { artifactDir } = await backupInstance(rootJson, out, silent);
    const before = JSON.stringify(await readdir(artifactDir, { recursive: true }));

    const m = await verifyArtifact(artifactDir, silent);
    assert.equal(m.dirs.length, 2);
    assert.equal(JSON.stringify(await readdir(artifactDir, { recursive: true })), before);
  });

  it('keeps previous backups intact when another backup has the same timestamp', async () => {
    mock.method(Date.prototype, 'toISOString', () => '2026-01-01T00:00:00.000Z');
    const first = await backupInstance(rootJson, out, silent);
    const oldManifest = await readFile(join(first.artifactDir, 'manifest.json'));
    const baseEntry = first.manifest.dirs.find((d) => d.root === baseDir)!;
    const savedNode = join(first.artifactDir, baseEntry.artifactPath, 'app', 'config.json');
    const oldNode = await readFile(savedNode);

    const base = await createFsTree(baseDir);
    await base.set(createNode('/app/config', 'dir', { theme: 'light' }));
    const second = await backupInstance(rootJson, out, silent);

    assert.notEqual(first.artifactDir, second.artifactDir);
    assert.deepEqual(await readFile(join(first.artifactDir, 'manifest.json')), oldManifest);
    assert.deepEqual(await readFile(savedNode), oldNode);
    const newEntry = second.manifest.dirs.find((d) => d.root === baseDir)!;
    assert.equal(JSON.parse(await readFile(join(second.artifactDir, newEntry.artifactPath, 'app', 'config.json'), 'utf-8')).theme, 'light');
    assert.equal((await readdir(out)).length, 2);
    await verifyArtifact(first.artifactDir, silent);
    await verifyArtifact(second.artifactDir, silent);
  });

  it('can retry an interrupted backup without deleting old artifacts', async () => {
    mock.method(Date.prototype, 'toISOString', () => '2026-01-01T00:00:00.000Z');
    const first = await backupInstance(rootJson, out, silent);
    const config = await readFile(rootJson, 'utf-8');
    const oldManifest = await readFile(join(first.artifactDir, 'manifest.json'));
    await writeFile(rootJson, JSON.stringify(createNode('/', 'root', {}, {
      mount: { $type: 't.mount.fs', root: join(tmp, 'missing') },
    })));
    await assert.rejects(() => backupInstance(rootJson, out, silent), (error: unknown) => error instanceof BackupError && error.code === 'BAD_MOUNT');

    await writeFile(rootJson, config);
    const next = await backupInstance(rootJson, out, silent);
    assert.notEqual(next.artifactDir, first.artifactDir);
    assert.deepEqual(await readFile(join(first.artifactDir, 'manifest.json')), oldManifest);
    assert.equal((await readdir(out)).length, 3);
    await verifyArtifact(first.artifactDir, silent);
    await verifyArtifact(next.artifactDir, silent);
  });

  it('disaster recovery: dirs and config lost → restore in place → fs adapter reads the data', async () => {
    const configBytes = await readFile(rootJson, 'utf-8');
    const { artifactDir } = await backupInstance(rootJson, out, silent);

    await rm(join(tmp, 'tree'), { recursive: true });
    await rm(rootJson);
    await restoreArtifact(artifactDir, {}, silent);

    assert.equal(await readFile(rootJson, 'utf-8'), configBytes, 'config restored at its original path');
    const base = await createFsTree(baseDir);
    const node = await base.get('/app/config');
    assert.ok(node);
    assert.equal((node as Record<string, unknown>).theme, 'dark');
    assert.equal(node.$rev, 1, 'revision survives byte-faithful restore');
  });

  it('discovers fs mounts declared by nodes inside the data (fixpoint)', async () => {
    const extraDir = join(tmp, 'tree', 'extra');
    const extra = await createFsTree(extraDir);
    await extra.set(createNode('/', 'root'));
    await extra.set(createNode('/deep', 'dir', { v: 1 }));

    const work = await createFsTree(workDir);
    await work.set(createNode('/mnt', 'mount-point', {}, { mount: { $type: 't.mount.fs', root: extraDir } }));

    const { manifest } = await backupInstance(rootJson, out, silent);
    const roots = manifest.dirs.map((d) => d.root);
    assert.ok(roots.includes(extraDir), `in-tree mount dir backed up, got ${roots}`);
  });

  it('lists mongo mounts as external — db/collection in manifest, URI only in data files', async () => {
    const work = await createFsTree(workDir);
    await work.set(createNode('/db', 'mount-point', {}, {
      mount: { $type: 't.mount.mongo', uri: 'mongodb://admin:s3cret@host/x', db: 'mydb', collection: 'data' },
    }));

    const { artifactDir, manifest } = await backupInstance(rootJson, out, silent);

    assert.equal(manifest.external.length, 1);
    assert.equal(manifest.external[0].type, 't.mount.mongo');
    assert.ok(manifest.external[0].detail.includes('mydb'));

    const manifestRaw = await readFile(join(artifactDir, 'manifest.json'), 'utf-8');
    assert.ok(!manifestRaw.includes('s3cret'), 'credentials never enter the manifest');

    const workEntry = manifest.dirs.find((d) => d.root === workDir)!;
    const copied = await readFile(join(artifactDir, workEntry.artifactPath, 'db.json'), 'utf-8');
    assert.ok(copied.includes('s3cret'), 'data files stay byte-faithful');
  });

  it('same dir mounted twice is copied once', async () => {
    await writeFile(rootJson, JSON.stringify({
      $path: '/', $type: 'root',
      '#a': { $type: 't.mount.fs', root: workDir },
      '#b': { $type: 't.mount.fs', root: workDir },
    }));

    const { manifest } = await backupInstance(rootJson, out, silent);
    assert.equal(manifest.dirs.length, 1);
  });

  it('backup of a corrupted source fails loudly', async () => {
    await writeFile(join(workDir, 'broken.json'), '{ not json');
    await assert.rejects(() => backupInstance(rootJson, out, silent), (e: Error) => e instanceof Error);
  });

  it('config with no fs mounts → config-only artifact with a warning', async () => {
    await writeFile(rootJson, JSON.stringify({ $path: '/', $type: 'root' }));
    const { manifest } = await backupInstance(rootJson, out, silent);
    assert.equal(manifest.dirs.length, 0);
    assert.equal(manifest.warnings.length, 1);
  });

  it('verify rejects: corrupted node, tampered counts, missing manifest, newer data version', async () => {
    const { artifactDir, manifest } = await backupInstance(rootJson, out, silent);
    const dir0 = join(artifactDir, manifest.dirs[0].artifactPath);

    const victim = join(dir0, 'app', 'config.json');
    const original = await readFile(victim, 'utf-8');
    await writeFile(victim, '{ broken');
    await assert.rejects(() => verifyArtifact(artifactDir, silent), (e: BackupError) => e.code === 'CORRUPT_NODE');
    await writeFile(victim, original);

    const mPath = join(artifactDir, 'manifest.json');
    const mRaw = await readFile(mPath, 'utf-8');
    const tampered = JSON.parse(mRaw);
    tampered.dirs[0].nodes += 1;
    await writeFile(mPath, JSON.stringify(tampered));
    await assert.rejects(() => verifyArtifact(artifactDir, silent), (e: BackupError) => e.code === 'COUNT_MISMATCH');
    await writeFile(mPath, mRaw);

    await writeFile(join(dir0, VERSION_FILE), `${NS_VERSION + 1}\n`);
    await assert.rejects(() => verifyArtifact(artifactDir, silent), (e: BackupError) => e.code === 'VERSION_AHEAD');
    await writeFile(join(dir0, VERSION_FILE), `${NS_VERSION}\n`);

    await rm(mPath);
    await assert.rejects(() => verifyArtifact(artifactDir, silent), (e: BackupError) => e.code === 'NOT_A_BACKUP');
  });

  it('restores into empty directories without permission to remove them', async () => {
    const { artifactDir } = await backupInstance(rootJson, out, silent);
    for (const dir of [baseDir, workDir]) {
      await rm(dir, { recursive: true });
      await mkdir(dir);
    }
    const parent = join(tmp, 'tree');
    await chmod(parent, 0o555);
    try {
      await restoreArtifact(artifactDir, {}, silent);
      const base = await createFsTree(baseDir), work = await createFsTree(workDir);
      assert.equal((await base.get('/app/config'))?.theme, 'dark');
      assert.equal((await work.get('/notes'))?.body, 'hello');
      await verifyArtifact(artifactDir, silent);
    } finally {
      await chmod(parent, 0o755);
    }
  });

  it('restore refuses a non-empty target; --replace moves it aside instead of deleting', async () => {
    const { artifactDir } = await backupInstance(rootJson, out, silent);

    const work = await createFsTree(workDir);
    await work.set(createNode('/newer', 'dir', { v: 'post-backup' }));

    await assert.rejects(() => restoreArtifact(artifactDir, {}, silent), (e: BackupError) => e.code === 'TARGET_NOT_EMPTY');

    await restoreArtifact(artifactDir, { replace: true }, silent);

    const parent = await readdir(join(tmp, 'tree'));
    const aside = parent.find((n) => n.startsWith('work.pre-restore-'));
    assert.ok(aside, 'previous data moved aside, not deleted');
    assert.ok((await readdir(join(tmp, 'tree', aside!))).includes('newer.json'));

    const restored = await createFsTree(workDir);
    assert.equal(await restored.get('/newer'), undefined, 'restored state is the backup, not the newer write');
    assert.ok(await restored.get('/notes'));
  });

  it('restore keeps an existing differing config and reports it', async () => {
    const { artifactDir } = await backupInstance(rootJson, out, silent);
    await rm(join(tmp, 'tree'), { recursive: true });

    const customized = JSON.stringify({ $path: '/', $type: 'root', custom: true });
    await writeFile(rootJson, customized);

    const lines: string[] = [];
    await restoreArtifact(artifactDir, {}, (l) => lines.push(l));

    assert.equal(await readFile(rootJson, 'utf-8'), customized);
    assert.ok(lines.some((l) => l.includes('WARNING')));
  });

  it('--into redirects relative roots and rejects absolute ones', async () => {
    const { artifactDir: absArtifact } = await backupInstance(rootJson, out, silent);
    await assert.rejects(
      () => restoreArtifact(absArtifact, { into: join(tmp, 'elsewhere') }, silent),
      (e: BackupError) => e.code === 'ABSOLUTE_ROOT',
    );

    // Relative root is resolved from the server CWD.
    process.chdir(tmp);
    const relBase = 'relative';
    const relWork = join(relBase, 'work');
    const t = await createFsTree(relWork);
    await t.set(createNode('/x', 'dir', { ok: true }));
    const relRoot = join(tmp, 'rel-root.json');
    await writeFile(relRoot, JSON.stringify({ $path: '/', $type: 'root', '#m': { $type: 't.mount.fs', root: relWork } }));

    const { artifactDir } = await backupInstance(relRoot, out, silent);
    const into = join(tmp, 'elsewhere');
    await restoreArtifact(artifactDir, { into }, silent);

    const restored = await createFsTree(join(into, relWork));
    assert.ok(await restored.get('/x'));
    assert.equal(JSON.parse(await readFile(join(into, 'rel-root.json'), 'utf-8')).$type, 'root');
  });
});
