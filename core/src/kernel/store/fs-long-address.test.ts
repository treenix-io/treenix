import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import { KernelError } from '#errors';
import { openPersistentWriter } from '#kernel/persistence';
import { scanBudget, storeCommit, storedNode } from './contract';
import { createFsStore } from './fs';

/** Opens the actual lease and Store without discarding their durable files on cleanup. */
async function fixture(t: TestContext, directory?: string) {
  if (directory === undefined) {
    const parent = resolve('../../temp/k58-fs-long-address');
    await mkdir(parent, { recursive: true });
    directory = await mkdtemp(join(parent, 'store-'));
  }
  const lease = await openPersistentWriter({
    directory: join(directory, '.treenix'),
    instance: 'test',
  });
  const store = await createFsStore({ directory, lease });
  t.after(async () => {
    await store.close();
    await lease.close();
  });
  return { store, lease, directory };
}

describe('native filesystem long logical addresses', { timeout: 30_000 }, () => {
  it('persists, reopens and removes long directory addresses independently of optional legacy filenames', async (t) => {
    const first = await fixture(t);
    const names = ['a'.repeat(254), 'é'.repeat(127), 'é'.repeat(127) + 'x'];
    assert.deepEqual(
      names.map((name) => Buffer.byteLength(name)),
      [254, 254, 255],
    );
    const accepted = storeCommit(
      1,
      names.map((name) => storedNode('/' + name, { value: name })),
    );
    await first.store.commit(accepted);
    for (const name of names) {
      const physical: unknown = JSON.parse(
        await readFile(join(first.directory, name, '$'), 'utf8'),
      );
      assert.ok(typeof physical === 'object' && physical !== null && 'value' in physical);
      assert.equal(physical.value, name);
    }
    await first.store.close();
    await first.lease.close();
    const reopened = await fixture(t, first.directory);
    assert.deepEqual(
      (await reopened.store.scan({ range: { subtree: '/' }, budget: scanBudget() })).items,
      accepted.writes.map((write) => write.node),
    );
    const pos = { instance: 'test', epoch: 1, seq: 2 };
    await reopened.store.commit({
      pos,
      writerEpoch: reopened.lease.writerEpoch,
      writes: accepted.writes.map((write) => ({ path: write.path, node: null })),
      record: {
        pos,
        kind: 'commit',
        caller: 'kernel',
        executor: 'kernel',
        entries: accepted.writes.map((write) => {
          assert.ok(write.node);
          return {
            id: write.node.$id,
            path: write.path,
            change: { t: 'delete', before: write.node },
          };
        }),
      },
    });
    assert.deepEqual(
      (await reopened.store.scan({ range: { subtree: '/' }, budget: scanBudget() })).items,
      [],
    );
    for (const name of names) assert.deepEqual(await readdir(join(first.directory, name)), []);
    await reopened.store.close();
    await reopened.lease.close();
    const removed = await fixture(t, first.directory);
    assert.deepEqual(
      (await removed.store.scan({ range: { subtree: '/' }, budget: scanBudget() })).items,
      [],
    );
    assert.equal(
      (await removed.store.scan({ range: { journal: '/' }, budget: scanBudget() })).items.length,
      2,
    );
  });

  it('refuses genuine overlong directory names before accepting a journal record', async (t) => {
    const f = await fixture(t);
    const before = await readFile(join(f.directory, '.treenix/journal.log'));
    for (const name of ['a'.repeat(256), 'é'.repeat(256)]) {
      assert.equal(name.length, 256);
      await assert.rejects(
        f.store.commit(storeCommit(1, [storedNode('/' + name)])),
        (error) =>
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === 'ENAMETOOLONG',
      );
      assert.deepEqual(await readFile(join(f.directory, '.treenix/journal.log')), before);
    }
    assert.deepEqual(
      (await f.store.scan({ range: { subtree: '/' }, budget: scanBudget() })).items,
      [],
    );
  });

  it('keeps genuine symlink and ordinary-file failures loud for supported long names', async (t) => {
    const f = await fixture(t);
    const outside = await fixture(t);
    const linked = 's'.repeat(254);
    const occupied = 'f'.repeat(254);
    await symlink(outside.directory, join(f.directory, linked), 'dir');
    await writeFile(join(f.directory, occupied), 'occupied');
    const before = await readFile(join(f.directory, '.treenix/journal.log'));
    for (const [name, expected] of [
      [linked, 'FORBIDDEN'],
      [occupied, 'INVALID'],
    ]) {
      await assert.rejects(
        f.store.commit(storeCommit(1, [storedNode('/' + name)])),
        (error) => error instanceof KernelError && error.code === expected,
      );
      assert.deepEqual(await readFile(join(f.directory, '.treenix/journal.log')), before);
    }
  });
});
