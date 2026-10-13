import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';
import { openNativeRuntime } from '#kernel/runtime';
import { drainSession } from '#kernel/session-delivery';
import { scanBudget } from '#kernel/store/contract';
import type { JournalCommit } from '#kernel/types';

for (const layout of ['keyed', 'flat'] as const) {
  it(
    `reconciles a ${layout} atomic replacement through the actual recursive watcher`,
    { timeout: 3_000 },
    async (t) => {
      const parent = new URL(
        '../../../../../temp/fs-atomic-replacement/',
        import.meta.url,
      );
      await mkdir(parent, { recursive: true });
      const directory = await mkdtemp(
        fileURLToPath(new URL('dataset-', parent)),
      );
      await mkdir(join(directory, 'document'));
      const target =
        layout === 'keyed'
          ? join(directory, 'document', '$')
          : join(directory, 'document', 'item.json');
      const path = layout === 'keyed' ? '/document' : '/document/item';
      const runtime = await openNativeRuntime({
        id: randomUUID(),
        directory,
        rootExternal: 'trusted',
        credentialTtlMs: 60_000,
        firstAdmin: { path: '/admin', name: 'admin', password: randomUUID() },
      });
      t.after(() => runtime.close());
      assert.ok(runtime.instance.setupCredential);
      const admin = await runtime.instance.openSession(
        runtime.instance.setupCredential,
      );
      const delivery = drainSession(admin);
      t.after(async () => {
        admin.close();
        await delivery;
      });
      await admin.commit({
        opId: {
          epoch: runtime.instance.writer.intake.epoch,
          time: Date.now(),
          nonce: randomUUID(),
        },
        changes: [
          { op: 'put', node: { $path: path, $type: 't.dir', value: 1 } },
        ],
      }).outcome;
      if (layout === 'flat')
        await rename(join(directory, 'document', 'item', '$'), target);
      const before = (await admin.read({ node: path })).copies[0];
      assert.ok('node' in before);
      let resolve = (_record: JournalCommit) => {};
      const reconciled = new Promise<JournalCommit>((done) => {
        resolve = done;
      });
      const remove = runtime.instance.writer.stream.observe((event) => {
        if (
          event.t === 'commit' &&
          event.record.kind === 'reconcile' &&
          event.record.entries.some((entry) => entry.path === path)
        )
          resolve(event.record);
      });
      t.after(remove);
      const body = JSON.parse(await readFile(target, 'utf8'));
      const temporary = join(directory, 'document', '.editor.tmp');
      await writeFile(temporary, JSON.stringify({ ...body, value: 2 }));
      await rename(temporary, target);
      const record = await reconciled;
      assert.equal(record.executor, `external:${runtime.store.domain}`);
      const after = (await admin.read({ node: path })).copies[0];
      assert.ok('node' in after);
      assert.equal(after.node.$id, before.node.$id);
      assert.notEqual(after.node.$rev, before.node.$rev);
      assert.equal(after.node.value, 2);
      await admin.commit({
        opId: {
          epoch: runtime.instance.writer.intake.epoch,
          time: Date.now(),
          nonce: randomUUID(),
        },
        changes: [{ op: 'patch', path, ops: { $set: { value: 3 } } }],
      }).outcome;
      assert.equal(
        (await runtime.store.readExternal!(['/document'], scanBudget())).items
          .length,
        0,
      );
    },
  );
}
