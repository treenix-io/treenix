import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { migrateFsRoot } from './migrate-component-namespace';

describe('migrate-component-namespace (offline FS pass)', () => {
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

  it('warns on query-mount match keys that may need the # prefix', async () => {
    await setup({
      'q.json': {
        $type: 'dir',
        mount: { $type: 't.mount.query', source: '/orders', match: { 'run.status': 'open' } },
      },
    });

    const lines: string[] = [];
    const stats = await migrateFsRoot(dir, false, l => lines.push(l));
    assert.equal(stats.warnings, 1);
    assert.ok(lines.some(l => l.includes('run.status')));
  });

  it('leaves no tmp files after a write pass', async () => {
    await setup({ 'a.json': { $type: 't', run: { $type: 'flow.run' } } });
    await migrateFsRoot(dir, true, () => {});
    const leftovers = (await readdir(dir, { withFileTypes: true, recursive: true }))
      .filter(e => e.name.endsWith('.tmp'));
    assert.deepEqual(leftovers, []);
  });
});
