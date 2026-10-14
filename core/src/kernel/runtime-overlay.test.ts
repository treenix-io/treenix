import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { it } from 'node:test';
import { openNativeRuntime } from '#kernel/runtime';
import { drainSession } from '#kernel/session-delivery';
import { scanBudget } from '#kernel/store/contract';
import type { ModuleManifest } from '#kernel/types';
import { KernelError } from '#errors';
import { createFsOverlayLayout } from '#kernel/store/fs-overlay';

const module: ModuleManifest = {
  id: 'overlay-document',
  types: [
    {
      name: 'overlay.document',
      module: 'overlay-document',
      security: 'ordinary',
      version: 0,
      schema: { type: 'object', properties: { count: { type: 'number' } }, required: ['count'] },
      actions: {},
    },
  ],
  security: [],
  open: [],
};

/** Bound every generated base body, including its already closed native metadata. */
async function baseBodies(directory: string): Promise<ReadonlyMap<string, string>> {
  const bodies = new Map<string, string>();
  async function walk(path: string): Promise<void> {
    for (const entry of await readdir(join(directory, path), { withFileTypes: true })) {
      assert.ok(!entry.name.startsWith('.env') && entry.name !== 'secrets' && entry.name !== 'old');
      const file = path === '' ? entry.name : `${path}/${entry.name}`;
      if (entry.isDirectory()) await walk(file);
      else
        bodies.set(
          file,
          createHash('sha256')
            .update(await readFile(join(directory, file)))
            .digest('hex'),
        );
    }
  }
  await walk('');
  return bodies;
}

it(
  'boots one upper owner, preserves lower identities through copy-up and move, and reopens durable deletes',
  { timeout: 20_000 },
  async (t) => {
    const parent = resolve('../../temp/root-overlay-fixtures');
    await mkdir(parent, { recursive: true });
    const directory = await mkdtemp(join(parent, 'instance-')),
      base = join(directory, 'base'),
      work = join(directory, 'work');
    const id = randomUUID(),
      prepared = await openNativeRuntime({
        id,
        directory: base,
        credentialTtlMs: 60_000,
        modules: [module],
        firstAdmin: { path: '/admin', name: 'admin', password: 'overlay-fixture-password' },
      });
    assert.ok(prepared.instance.setupCredential);
    const seed = await prepared.instance.openSession(prepared.instance.setupCredential),
      seeded = drainSession(seed);
    try {
      const outcome = await seed.commit({
        opId: {
          epoch: prepared.instance.writer.intake.epoch,
          time: Date.now(),
          nonce: randomUUID(),
        },
        changes: [
          { op: 'put', node: { $path: '/folder', $type: 't.dir' } },
          { op: 'put', node: { $path: '/folder/doc', $type: 'overlay.document', count: 1 } },
          { op: 'put', node: { $path: '/folder/delete', $type: 'overlay.document', count: 3 } },
        ],
      }).outcome;
      assert.ok(outcome.pos);
    } finally {
      seed.close();
      await seeded;
      await prepared.close();
    }
    const bodies = await baseBodies(base);
    const config = {
      id,
      directory: work,
      baseDirectory: base,
      credentialTtlMs: 60_000,
      modules: [module],
      firstAdmin: { path: '/admin', name: 'admin', password: 'overlay-fixture-password' },
    };
    let runtime = await openNativeRuntime(config);
    t.after(() => runtime.close());
    assert.equal(runtime.instance.registry.type('overlay.document').module, module.id);
    assert.equal(runtime.instance.setupCredential, undefined);
    const credential = await runtime.instance.auth.login({
      account: '/admin',
      password: 'overlay-fixture-password',
    });
    const session = await runtime.instance.openSession(credential),
      delivery = drainSession(session);
    try {
      const original = (
        await runtime.store.scan({ range: { node: '/folder/doc' }, budget: scanBudget() })
      ).items[0];
      const key = () => ({
        epoch: runtime.instance.writer.intake.epoch,
        time: Date.now(),
        nonce: randomUUID(),
      });
      assert.ok(
        (
          await session.commit({
            opId: key(),
            changes: [{ op: 'patch', path: '/folder/doc', ops: { $inc: { count: 1 } } }],
          }).outcome
        ).pos,
      );
      assert.equal(
        (await runtime.store.scan({ range: { node: '/folder/doc' }, budget: scanBudget() }))
          .items[0].$id,
        original.$id,
      );
      assert.ok(
        (
          await session.commit({
            opId: key(),
            changes: [
              { op: 'move', from: '/folder/doc', to: '/moved' },
              { op: 'remove', path: '/folder/delete' },
            ],
          }).outcome
        ).pos,
      );
      assert.equal(
        (await runtime.store.scan({ range: { node: '/moved' }, budget: scanBudget() })).items[0]
          .$id,
        original.$id,
      );
    } finally {
      session.close();
      await delivery;
    }
    await runtime.close();
    runtime = await openNativeRuntime(config);
    assert.equal(
      (await runtime.store.scan({ range: { node: '/moved' }, budget: scanBudget() })).items[0]
        .count,
      2,
    );
    assert.deepEqual(
      (await runtime.store.scan({ range: { node: '/folder/doc' }, budget: scanBudget() })).items,
      [],
    );
    assert.deepEqual(
      (await runtime.store.scan({ range: { node: '/folder/delete' }, budget: scanBudget() })).items,
      [],
    );
    assert.ok(!(await readdir(base)).includes('whiteouts'));
    assert.deepEqual(await baseBodies(base), bodies);
  },
);

it(
  'bootstraps an empty overlay through the upper administrator and module owner',
  { timeout: 20_000 },
  async () => {
    const parent = resolve('../../temp/root-overlay-fixtures');
    await mkdir(parent, { recursive: true });
    const directory = await mkdtemp(join(parent, 'bootstrap-')),
      base = join(directory, 'base');
    await mkdir(base);
    const runtime = await openNativeRuntime({
      id: randomUUID(),
      directory: join(directory, 'work'),
      baseDirectory: base,
      credentialTtlMs: 60_000,
      modules: [module],
      firstAdmin: { path: '/admin', name: 'admin', password: 'overlay-fixture-password' },
    });
    try {
      assert.ok(runtime.instance.setupCredential);
      assert.equal(runtime.instance.registry.type('overlay.document').module, module.id);
      assert.deepEqual(await readdir(base), []);
      assert.equal(
        (await runtime.store.scan({ range: { node: '/' }, budget: scanBudget() })).items[0].$type,
        't.root',
      );
    } finally {
      await runtime.close();
    }
  },
);

it('keeps a malformed upper image authoritative and charges both physical layers', async () => {
  const parent = resolve('../../temp/root-overlay-fixtures');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'quarantine-')),
    base = join(directory, 'base'),
    upper = join(directory, 'work');
  await mkdir(base);
  await mkdir(upper);
  await writeFile(join(base, 'doc.json'), JSON.stringify({ $type: 'overlay.document', count: 1 }));
  await writeFile(join(upper, 'doc.json'), '{');
  const layout = await createFsOverlayLayout(upper, base),
    pos = { instance: 'overlay', epoch: 0, seq: 0 };
  const result = await layout.scan(upper, pos, { node: '/doc' }, scanBudget(), true);
  assert.deepEqual(result.nodes, []);
  assert.equal(result.faults[0].path, '/doc');
  assert.equal(result.cost.nodes, 2);
  await assert.rejects(
    layout.scan(upper, pos, { node: '/doc' }, { ...scanBudget(), nodes: 1 }, true),
    (error: unknown) => error instanceof KernelError && error.code === 'BUDGET',
  );
});

it('refuses overlapping physical capabilities before creating lease metadata', async () => {
  const parent = resolve('../../temp/root-overlay-fixtures');
  await mkdir(parent, { recursive: true });
  const base = await mkdtemp(join(parent, 'overlap-')),
    alias = `${base}-alias`;
  await symlink(base, alias);
  await assert.rejects(
    openNativeRuntime({
      id: randomUUID(),
      directory: join(alias, 'work'),
      baseDirectory: base,
      credentialTtlMs: 60_000,
      modules: [],
    }),
    (error: unknown) => error instanceof KernelError && error.code === 'INVALID',
  );
  assert.deepEqual(await readdir(base), []);
});
