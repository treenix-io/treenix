import { getComponentByName } from '#core';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { createFsTree } from './fs';
import { ensureMigrated, migrateFsRoot, NS_VERSION, stampVersion, VERSION_FILE } from './migrate-component-namespace';

let dir: string;

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function setup(files: Record<string, unknown>) {
  dir = await mkdtemp(join(tmpdir(), 'treenix-comp-migrate-'));
  for (const [rel, body] of Object.entries(files)) {
    const file = join(dir, rel);
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, JSON.stringify(body, null, 2) + '\n');
  }
  return dir;
}

const read = async (rel: string) => JSON.parse(await readFile(join(dir, rel), 'utf-8'));
const marker = () => readFile(join(dir, VERSION_FILE), 'utf-8');

describe('migrate-component-namespace (offline FS pass)', () => {
  it('moves bare component entries to # keys, leaves fields and system keys alone', async () => {
    await setup({
      'a.json': {
        $type: 'crm.deal', $rev: 3,
        title: 'plain field',
        status: { $type: 'status', value: 'open' },
        mount: { $type: 't.mount.fs', root: './data' },
      },
    });

    const stats = await migrateFsRoot(dir, true, () => {});
    assert.equal(stats.renames, 2);

    const a = await read('a.json');
    assert.equal(a['#status'].value, 'open');
    assert.equal(a['#mount'].root, './data');
    assert.equal(a.title, 'plain field');
    assert.equal(a.$rev, 3);
    assert.ok(!('status' in a) && !('mount' in a));
  });

  it('dry-run reports but writes nothing', async () => {
    await setup({ 'a.json': { $type: 't', run: { $type: 'flow.run' } } });

    const stats = await migrateFsRoot(dir, false, () => {});
    assert.equal(stats.renames, 1);

    const a = await read('a.json');
    assert.ok('run' in a && !('#run' in a), 'file untouched in dry-run');
  });

  it('walks dir-form $.json files recursively', async () => {
    await setup({
      'sys/$.json': { $type: 'dir', mount: { $type: 't.mount.memory' } },
      'sys/child.json': { $type: 't', note: 'no components here' },
    });

    const stats = await migrateFsRoot(dir, true, () => {});
    assert.equal(stats.renames, 1);
    assert.ok('#mount' in await read('sys/$.json'));
  });

  it('is idempotent — second pass renames nothing', async () => {
    await setup({ 'a.json': { $type: 't', run: { $type: 'flow.run' } } });
    await migrateFsRoot(dir, true, () => {});
    const second = await migrateFsRoot(dir, true, () => {});
    assert.equal(second.renames, 0);
  });

  it('throws on # collision and on malformed existing # entry', async () => {
    await setup({ 'a.json': { $type: 't', run: { $type: 'flow.run' }, '#run': { $type: 'flow.run' } } });
    await assert.rejects(() => migrateFsRoot(dir, false, () => {}), /already exists/);

    await rm(dir, { recursive: true, force: true });
    await setup({ 'b.json': { $type: 't', '#bad': { nope: 1 } } });
    await assert.rejects(() => migrateFsRoot(dir, false, () => {}), /malformed/);
  });

  it('collects query-mount match keys that may need the # prefix as warnings', async () => {
    await setup({
      'q.json': {
        $type: 'dir',
        mount: { $type: 't.mount.query', source: '/orders', match: { 'run.status': 'open' } },
      },
    });

    const stats = await migrateFsRoot(dir, false, () => {});
    assert.equal(stats.warnings.length, 1);
    assert.ok(stats.warnings[0].includes('run.status'));
  });

  it('leaves no tmp files after a write pass', async () => {
    await setup({ 'a.json': { $type: 't', run: { $type: 'flow.run' } } });
    await migrateFsRoot(dir, true, () => {});
    const leftovers = (await readdir(dir, { withFileTypes: true, recursive: true }))
      .filter(e => e.name.endsWith('.tmp'));
    assert.deepEqual(leftovers, []);
  });
});

describe('ensureMigrated (boot gate)', () => {
  it('migrates an unmarked old-shape root and stamps the version marker', async () => {
    await setup({ 'a.json': { $type: 't', run: { $type: 'flow.run', status: 'done' } } });

    await ensureMigrated(dir, () => {});

    const a = await read('a.json');
    assert.ok('#run' in a && !('run' in a));
    assert.equal((await marker()).trim(), String(NS_VERSION));
  });

  it('stamps a fresh root without touching anything', async () => {
    await setup({});
    await ensureMigrated(dir, () => {});
    assert.equal((await marker()).trim(), String(NS_VERSION));
  });

  it('marker present → bare $type values are plain data and survive (snapshot escape)', async () => {
    await setup({ 'snap.json': { $type: 't', snapshot: { $type: 'crm.deal', title: 'frozen' } } });
    await stampVersion(dir);

    await ensureMigrated(dir, () => {});

    const s = await read('snap.json');
    assert.ok('snapshot' in s && !('#snapshot' in s), 'post-cutover bare $type value must stay data');
  });

  it('match-key warnings abort the open: zero writes, no marker', async () => {
    await setup({
      'q.json': { $type: 'dir', mount: { $type: 't.mount.query', source: '/x', match: { 'run.status': 'open' } } },
      'a.json': { $type: 't', run: { $type: 'flow.run' } },
    });

    await assert.rejects(() => ensureMigrated(dir, () => {}));

    const a = await read('a.json');
    assert.ok('run' in a && !('#run' in a), 'no partial writes on abort');
    await assert.rejects(() => marker(), (e: any) => e.code === 'ENOENT');
  });

  it('rejects a corrupted version marker', async () => {
    await setup({});
    await writeFile(join(dir, VERSION_FILE), 'garbage\n');
    await assert.rejects(() => ensureMigrated(dir, () => {}));
  });

  it('rejects data stamped by a newer engine', async () => {
    await setup({});
    await writeFile(join(dir, VERSION_FILE), `${NS_VERSION + 1}\n`);
    await assert.rejects(() => ensureMigrated(dir, () => {}));
  });

  it('resumes an interrupted pass — marker is stamped last', async () => {
    await setup({
      'done.json': { $type: 't', '#run': { $type: 'flow.run' } },
      'todo.json': { $type: 't', run: { $type: 'flow.run' } },
    });

    await ensureMigrated(dir, () => {});

    assert.ok('#run' in await read('todo.json'));
    assert.equal((await marker()).trim(), String(NS_VERSION));
  });

  it('createFsTree migrates an old-shape root once; later bare $type writes stay data', async () => {
    await setup({ 'deal.json': { $type: 'crm.deal', status: { $type: 'status', value: 'open' } } });

    const tree = await createFsTree(dir);
    const node = await tree.get('/deal');
    assert.ok(node);
    assert.equal(getComponentByName(node, 'status')?.['value'], 'open');

    // Post-cutover file with a bare $type value = data; the second open must not rewrite it.
    await writeFile(join(dir, 'snap.json'), JSON.stringify({ $type: 't', snapshot: { $type: 'crm.deal' } }) + '\n');
    const tree2 = await createFsTree(dir);
    const snap = await tree2.get('/snap');
    assert.ok(snap);
    assert.equal(getComponentByName(snap, 'snapshot'), undefined);
    assert.ok('snapshot' in (await read('snap.json')), 'snapshot survives as bare data on disk');
  });
});
