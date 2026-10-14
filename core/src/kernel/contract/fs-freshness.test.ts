import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { it, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { KernelError } from '#errors';
import { prepareCredential } from '#kernel/auth/credentials';
import { createMemoryBlobStore } from '#kernel/blob-store-memory';
import { createInstance } from '#kernel/instance';
import { openPersistentWriter } from '#kernel/persistence';
import { createReader } from '#kernel/reader';
import { openNativeRuntime } from '#kernel/runtime';
import { drainSession } from '#kernel/session-delivery';
import { createFsStore } from '#kernel/store/fs';
import {
  R,
  type Budget,
  type ChangeMember,
  type JournalCommit,
  type Principal,
} from '#kernel/types';

/** Match the public hidden-or-absent contract without inspecting diagnostic wording. */
function hidden(error: unknown): boolean {
  return error instanceof KernelError && error.code === 'NOT_FOUND';
}

/** Seed only through native Sessions; all filesystem edits remain in this unique retained deployment. */
async function fixture(t: TestContext, mounted = false) {
  const parent = fileURLToPath(new URL('../../../../../temp/fs-freshness-data/', import.meta.url));
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'instance-'));
  const root = join(directory, 'root'),
    target = join(directory, 'target');
  await mkdir(target);
  if (mounted)
    await writeFile(join(target, 'doc.json'), JSON.stringify({ $type: 't.dir', label: 'before' }));
  const config = {
    id: randomUUID(),
    directory: root,
    rootExternal: mounted ? ('none' as const) : ('trusted' as const),
    credentialTtlMs: 60_000,
    firstAdmin: { path: '/admin', name: 'admin', password: randomUUID() },
    modules: [],
    mountDirectories: { data: target },
  };
  const runtimes: Awaited<ReturnType<typeof openNativeRuntime>>[] = [];
  const deliveries: Promise<void>[] = [];
  const admissions: { close(): void }[] = [];
  t.after(async () => {
    for (const admission of admissions) admission.close();
    for (const runtime of runtimes.reverse()) await runtime.close();
    await Promise.all(deliveries);
  });
  let runtime = await openNativeRuntime(config);
  runtimes.push(runtime);
  assert.ok(runtime.instance.setupCredential);
  const setupCredential = runtime.instance.setupCredential;
  let admin = await runtime.instance.openSession(setupCredential);
  deliveries.push(drainSession(admin));

  /** Native mutation completion is consumed by the actual admin lane. */
  function commit(changes: readonly ChangeMember[]) {
    return admin.commit({
      changes,
      opId: { epoch: runtime.instance.writer.intake.epoch, time: Date.now(), nonce: randomUUID() },
    }).outcome;
  }

  await commit([
    {
      op: 'put',
      node: {
        $path: '/reader',
        $type: 't.user',
        name: 'reader',
        status: 'active',
        '#groups': { $type: 't.groups', list: ['readers'] },
      },
    },
    { op: 'put', node: { $path: '/other', $type: 't.user', name: 'other', status: 'active' } },
    {
      op: 'put',
      node: {
        $path: '/sibling',
        $type: 't.dir',
        label: 'unrelated',
        $acl: [{ subject: { group: 'readers' }, grant: R }],
      },
    },
  ]);
  const account = (await admin.read({ node: '/reader' })).copies[0];
  const other = (await admin.read({ node: '/other' })).copies[0];
  assert.ok('node' in account && 'node' in other);
  const prepared = prepareCredential(account.node.$id, { expiresAt: Date.now() + 60_000 });
  await commit([{ op: 'put', node: prepared.node }]);
  if (mounted) {
    await commit([
      {
        op: 'put',
        node: {
          $path: '/mounted',
          $type: 't.dir',
          $acl: [{ subject: { group: 'readers' }, grant: R }],
          '#mount': { $type: 't.mount.fs', pattern: '', directory: 'data', external: 'trusted' },
          '#groups': { $type: 't.groups', list: ['admins'] },
        },
      },
    ]);
    await runtime.close();
    runtime = await openNativeRuntime(config);
    runtimes.push(runtime);
    admin = await runtime.instance.openSession(setupCredential);
    deliveries.push(drainSession(admin));
  }
  const session = await runtime.instance.openSession(prepared.credential);
  const welcome = await session.frames.next();
  assert.ok(!welcome.done && welcome.value.t === 'welcome');
  const admission = await runtime.instance.auth.openCredential(prepared.credential);
  admissions.push(admission);

  /** Give each borrowed Reader a real bounded allowance and composed source. */
  function inputs() {
    const limits = runtime.instance.limits();
    const budget: Budget = {
      nodes: limits.readNodes,
      bytes: limits.readBytes,
      exprWork: limits.exprWork,
      deadline: Date.now() + limits.queryMs,
    };
    const source = runtime.instance.readerSource(budget);
    return {
      registry: runtime.instance.registry,
      writer: runtime.instance.writer,
      admission,
      source,
      budget,
      limits,
    };
  }

  /** Edit one actual physical body atomically; this does not emit an artificial notification. */
  async function edit(file: string, fields: Record<string, unknown>) {
    const body = JSON.parse(await readFile(file, 'utf8'));
    const temporary = join(dirname(file), '.freshness.tmp');
    await writeFile(temporary, JSON.stringify({ ...body, ...fields }));
    await rename(temporary, file);
  }

  /** Await only the canonical accepted reconciliation for this physical address. */
  function reconciled(path: string) {
    let remove = () => {};
    const accepted = new Promise<JournalCommit>((done) => {
      remove = runtime.instance.writer.stream.observe((event) => {
        if (
          event.t === 'commit' &&
          event.record.kind === 'reconcile' &&
          event.record.entries.some((entry) => entry.path === path)
        ) {
          remove();
          done(event.record);
        }
      });
    });
    t.after(() => remove());
    return accepted;
  }

  const otherOwner: Principal = `u:${other.node.$id}`;
  return {
    runtime,
    session,
    inputs,
    commit,
    edit,
    reconciled,
    root,
    target,
    owner: session.actor.principal,
    otherOwner,
  };
}

for (const revoked of ['leaf', 'ancestor', 'owner'] as const)
  it(
    `uses current physical ${revoked} authority before reconciliation can accept it`,
    { timeout: 10_000 },
    async (t) => {
      const f = await fixture(t);
      await f.commit([
        {
          op: 'put',
          node: {
            $path: '/box',
            $type: 't.dir',
            ...(revoked === 'owner' ? {} : { $acl: [{ subject: { group: 'readers' }, grant: R }] }),
          },
        },
        {
          op: 'put',
          node: {
            $path: '/box/item',
            $type: 't.dir',
            label: 'private-after-revoke',
            ...(revoked === 'owner'
              ? { $owner: f.owner, $acl: [{ subject: { owner: true }, grant: R }] }
              : {}),
          },
        },
      ]);
      assert.ok('node' in (await f.session.read({ node: '/box/item' })).copies[0]);
      const address = revoked === 'ancestor' ? '/box' : '/box/item';
      const accepted = f.reconciled(address);
      const options = f.inputs(),
        before = f.runtime.instance.writer.position;
      await f.runtime.instance.writer.read(options.source.domains, async () => {
        await f.edit(
          join(f.root, address.slice(1), '$'),
          revoked === 'owner'
            ? { $owner: f.otherOwner }
            : { $acl: [{ subject: { group: 'readers' }, deny: R }] },
        );
        const current = createReader(options);
        await assert.rejects(current.selectInSpan({ node: '/box/item' }), hidden);
        assert.ok(
          current
            .expect()
            .dependencies?.some((input) => input.kind === 'rights' && input.key === address),
        );
        const sibling = await createReader(f.inputs()).selectInSpan({ node: '/sibling' });
        assert.equal(sibling.images.length, 1);
        const siblingCopy = sibling.images[0].copy;
        assert.ok('node' in siblingCopy);
        assert.equal(siblingCopy.node.label, 'unrelated');
        assert.deepEqual(f.runtime.instance.writer.position, before);
      });
      const record = await accepted;
      assert.equal(record.executor, `external:${f.runtime.store.domain}`);
      assert.ok(record.pos.seq > before.seq);
      await assert.rejects(f.session.read({ node: '/box/item' }), hidden);
    },
  );

it(
  'folds a newly created sparse ancestor denial from root to leaf before its accepted event',
  { timeout: 10_000 },
  async (t) => {
    const f = await fixture(t);
    await f.commit([
      { op: 'put', node: { $path: '/sparse', $type: 't.dir' } },
      {
        op: 'put',
        node: {
          $path: '/sparse/item',
          $type: 't.dir',
          label: 'leaf-grant',
          $acl: [{ subject: { group: 'readers' }, grant: R }],
        },
      },
    ]);
    const removed = f.reconciled('/sparse');
    const file = join(f.root, 'sparse', '$');
    await unlink(file);
    await removed;
    assert.ok('node' in (await f.session.read({ node: '/sparse/item' })).copies[0]);
    const accepted = f.reconciled('/sparse');
    const options = f.inputs(),
      before = f.runtime.instance.writer.position;
    await f.runtime.instance.writer.read(options.source.domains, async () => {
      const temporary = join(f.root, 'sparse', '.ancestor.tmp');
      await writeFile(
        temporary,
        JSON.stringify({ $type: 't.dir', $acl: [{ subject: { group: 'readers' }, deny: R }] }),
      );
      await rename(temporary, file);
      const current = createReader(options);
      await assert.rejects(current.selectInSpan({ node: '/sparse/item' }), hidden);
      assert.ok(
        current
          .expect()
          .dependencies?.some((input) => input.kind === 'rights' && input.key === '/sparse'),
      );
      assert.deepEqual(f.runtime.instance.writer.position, before);
    });
    const record = await accepted;
    assert.equal(record.executor, `external:${f.runtime.store.domain}`);
    assert.ok(record.pos.seq > before.seq);
    await assert.rejects(f.session.read({ node: '/sparse/item' }), hidden);
  },
);

it(
  'keeps an activated trusted mounted owner fresh for both payload and leaf authority',
  { timeout: 10_000 },
  async (t) => {
    const f = await fixture(t, true);
    const prior = (await f.session.read({ node: '/mounted/doc' })).copies[0];
    assert.ok('node' in prior);
    assert.equal(prior.node.label, 'before');
    const options = f.inputs(),
      target = options.source.resolve('/mounted/doc');
    assert.equal(target.external, 'trusted');
    assert.notEqual(target.store, f.runtime.store);
    const accepted = f.reconciled('/mounted/doc');
    const before = f.runtime.instance.writer.position;
    await f.runtime.instance.writer.read(options.source.domains, async () => {
      const file = join(f.target, 'doc.json');
      await f.edit(file, { label: 'fresh-before-event' });
      const selected = await createReader(options).selectInSpan({ node: '/mounted/doc' });
      assert.equal(selected.images.length, 1);
      const fresh = selected.images[0].copy;
      assert.ok('node' in fresh);
      assert.equal(fresh.node.label, 'fresh-before-event');
      assert.equal(fresh.node.$rev, prior.node.$rev);
      assert.ok(
        selected.reads.dependencies?.some(
          (input) => input.kind === 'rights' && input.key === '/mounted/doc',
        ),
      );
      await f.edit(file, {
        label: 'private-after-revoke',
        $acl: [{ subject: { group: 'readers' }, deny: R }],
      });
      await assert.rejects(createReader(f.inputs()).selectInSpan({ node: '/mounted/doc' }), hidden);
      assert.deepEqual(f.runtime.instance.writer.position, before);
    });
    const record = await accepted;
    assert.equal(record.executor, `external:${target.store.domain}`);
    assert.ok(record.pos.seq > before.seq);
    await assert.rejects(f.session.read({ node: '/mounted/doc' }), hidden);
  },
);

it(
  'refuses canonical fresh provisioning over a corrupt physical root without replacing its bytes',
  { timeout: 10_000 },
  async (t) => {
    const parent = fileURLToPath(
      new URL('../../../../../temp/fs-freshness-data/', import.meta.url),
    );
    await mkdir(parent, { recursive: true });
    const directory = await mkdtemp(join(parent, 'corrupt-root-'));
    const file = join(directory, '$'),
      malformed = '{"$type":';
    await writeFile(file, malformed);
    const id = randomUUID();
    const lease = await openPersistentWriter({
      directory: join(directory, '.treenix'),
      instance: id,
    });
    const store = await createFsStore({ directory, lease, external: 'trusted' });
    t.after(async () => {
      await store.close();
      await lease.close();
    });
    const before = await lease.load();

    await assert.rejects(
      createInstance({
        id,
        root: { kind: 'store', store },
        rootExternal: 'trusted',
        blobs: createMemoryBlobStore(),
        modules: [],
        provisioning: {
          counter: lease,
          writerEpoch: lease.writerEpoch,
          domains: [{ store, epoch: lease.epoch, persistent: true }],
          credentialTtlMs: 60_000,
          bootstrap: {
            kind: 'fresh',
            admin: { path: '/admin', name: 'admin', password: randomUUID() },
          },
        },
      }),
      (error) => error instanceof KernelError && error.code === 'INVALID',
    );
    assert.equal(await readFile(file, 'utf8'), malformed);
    assert.deepEqual(await lease.load(), before);
  },
);
