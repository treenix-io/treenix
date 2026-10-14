import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { it, type TestContext } from 'node:test';
import { KernelError } from '@treenx/core/errors';
import { A, R, W, type ChangeMember, type Session } from '@treenx/core/kernel';
import { openNativeRuntime } from '@treenx/core/kernel/runtime';
import { createTrashManifest } from './native';
import { decodeRequests } from '@treenx/core/protocol/twp';
import type { JournalAddress } from '@treenx/core/kernel/types';

async function drain(session: Session) {
  for await (const frame of session.lane) void frame;
}

async function setup(t: TestContext) {
  const parent = resolve('../temp/native-trash');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'dataset-'));
  const runtime = await openNativeRuntime({
    id: randomUUID(),
    directory,
    rootExternal: 'none',
    credentialTtlMs: 60_000,
    firstAdmin: { path: '/admin', name: 'admin', password: 'trash-test-password' },
    modules: [createTrashManifest('/docs')],
  });
  assert.ok(runtime.instance.setupCredential);
  const admin = await runtime.instance.openSession(runtime.instance.setupCredential);
  const writer = await runtime.instance.openSession();
  const deliveries = [drain(admin), drain(writer)];
  t.after(async () => {
    await runtime.close();
    await Promise.all(deliveries);
  });
  const key = () => ({
    epoch: runtime.instance.writer.intake.epoch,
    time: Date.now(),
    nonce: randomUUID(),
  });
  const commit = (changes: readonly ChangeMember[]) =>
    admin.commit({ changes, opId: key() }).outcome;
  const acl = [{ subject: { group: 'public' }, grant: R | W }];
  return { runtime, admin, writer, key, commit, acl };
}

it(
  'shows native deletion rows only to current A and restores the issued identity',
  { timeout: 10_000 },
  async (t) => {
    const { admin, writer, key, commit, acl } = await setup(t);
    await commit([
      { op: 'put', node: { $path: '/docs', $type: 't.dir', $acl: acl } },
      { op: 'put', node: { $path: '/docs/item', $type: 't.dir', value: 7 } },
      {
        op: 'put',
        node: {
          $path: '/trash',
          $type: 't.dir',
          $acl: acl,
          '#trash': { $type: 't.mount.trash', pattern: 'result' },
        },
      },
    ]);
    const before = (await admin.read({ node: '/docs/item' })).copies[0];
    assert.ok('node' in before);
    await commit([{ op: 'remove', path: '/docs/item' }]);
    const result = await admin.read({ children: '/trash/result' });
    assert.ok(result.rows);
    assert.equal(result.rows.length, 1);
    const row = result.rows[0];
    assert.equal(row.path, '/docs/item');
    assert.deepEqual((await writer.read({ children: '/trash/result' })).rows, []);
    await assert.rejects(
      writer.act({
        path: '/trash',
        component: '#trash',
        action: 'restore',
        args: row.address,
        opId: key(),
      }).outcome,
      (error) => error instanceof KernelError && error.code === 'NOT_FOUND',
    );
    await admin.act({
      path: '/trash',
      component: '#trash',
      action: 'restore',
      args: row.address,
      opId: key(),
    }).outcome;
    const restored = (await admin.read({ node: '/docs/item' })).copies[0];
    assert.ok('node' in restored);
    assert.equal(restored.node.$id, before.node.$id);
    assert.equal(restored.node.value, 7);
  },
);

it(
  'undoes a150-node native deletion in two bounded commits and retains every issued identity',
  { timeout: 30_000 },
  async (t) => {
    const { runtime, admin, key, commit } = await setup(t);
    await commit([
      { op: 'put', node: { $path: '/docs', $type: 't.dir' } },
      {
        op: 'put',
        node: {
          $path: '/trash',
          $type: 't.dir',
          '#trash': { $type: 't.mount.trash', pattern: 'result' },
        },
      },
    ]);
    await commit([
      { op: 'put', node: { $path: '/docs/folder', $type: 't.dir' } },
      ...Array.from(
        { length: 99 },
        (_, index): ChangeMember => ({
          op: 'put',
          node: { $path: `/docs/folder/item${index}`, $type: 't.dir' },
        }),
      ),
    ]);
    await commit(
      Array.from(
        { length: 50 },
        (_, index): ChangeMember => ({
          op: 'put',
          node: { $path: `/docs/folder/item${index + 99}`, $type: 't.dir' },
        }),
      ),
    );
    const before = await admin.read({ children: '/docs/folder' });
    const issued = new Map(
      before.copies.map((copy) => {
        assert.ok('node' in copy);
        return [copy.node.$path, copy.node.$id];
      }),
    );
    const cursor = runtime.instance.writer.stream.cursor().pos;
    await commit(
      Array.from(
        { length: 100 },
        (_, index): ChangeMember => ({ op: 'remove', path: `/docs/folder/item${index}` }),
      ),
    );
    await commit([{ op: 'remove', path: '/docs/folder' }]);
    const history = await admin.read({ history: '/docs/folder', after: cursor });
    assert.ok(history.history);
    assert.equal(history.history.length, 150);
    const records: number[] = [];
    const reads = new Map<string, number>(),
      fill = runtime.instance.writer.cache.fill;
    t.mock.method(
      runtime.instance.writer.cache,
      'fill',
      async (...args: Parameters<typeof fill>) => {
        const range = args[1],
          path =
            'node' in range ? range.node : 'children' in range ? range.children : range.subtree;
        reads.set(path, (reads.get(path) ?? 0) + 1);
        return fill(...args);
      },
    );
    const stop = runtime.instance.writer.stream.observe((event) => {
      if (event.t === 'commit') records.push(event.record.entries.length);
    });
    try {
      const pending = admin.act({
        path: '/trash',
        component: '#trash',
        action: 'undo',
        args: history.history.map((entry) => entry.address),
        opId: key(),
      });
      const chunks = (async () => {
        for await (const chunk of pending.chunks) void chunk;
      })();
      await Promise.all([pending.outcome, chunks]);
    } finally {
      stop();
      t.diagnostic(
        JSON.stringify({
          cacheFills: [...reads].sort((a, b) => b[1] - a[1]),
          total: [...reads.values()].reduce((sum, value) => sum + value, 0),
        }),
      );
    }
    assert.deepEqual(records, [100, 50, 0]);
    const after = await admin.read({ children: '/docs/folder' });
    assert.equal(after.copies.length, 149);
    for (const copy of after.copies) {
      assert.ok('node' in copy);
      assert.equal(copy.node.$id, issued.get(copy.node.$path));
    }
  },
);

it(
  'denies a captured deletion after current declaration W or current history A is revoked',
  { timeout: 10_000 },
  async (t) => {
    const { runtime, writer, admin, key, commit } = await setup(t);
    const grant = (bits: number) => [{ subject: { group: 'public' }, grant: bits }];
    await commit([
      { op: 'put', node: { $path: '/docs', $type: 't.dir', $acl: grant(R | W | A) } },
      { op: 'put', node: { $path: '/docs/item', $type: 't.dir', value: 42 } },
      {
        op: 'put',
        node: {
          $path: '/trash',
          $type: 't.dir',
          $acl: grant(R | W),
          '#chosen': { $type: 't.mount.trash', pattern: 'deleted' },
        },
      },
    ]);
    await commit([{ op: 'remove', path: '/docs/item' }]);
    const visible = await writer.read({ children: '/trash/deleted' });
    assert.deepEqual(visible.viewOwner, { path: '/trash', component: '#chosen' });
    assert.equal(visible.rows?.length, 1);
    const captured = visible.rows![0].address;
    await commit([{ op: 'patch', path: '/trash', ops: { $set: { $acl: grant(R) } } }]);
    const beforeW = runtime.instance.writer.stream.cursor().pos;
    await assert.rejects(
      writer.act({
        path: '/trash',
        component: '#chosen',
        action: 'restore',
        args: captured,
        opId: key(),
      }).outcome,
      (error) => error instanceof KernelError && error.code === 'FORBIDDEN',
    );
    assert.deepEqual(runtime.instance.writer.stream.cursor().pos, beforeW);
    await commit([
      { op: 'patch', path: '/trash', ops: { $set: { $acl: grant(R | W) } } },
      { op: 'patch', path: '/docs', ops: { $set: { $acl: grant(R | W) } } },
    ]);
    assert.deepEqual((await writer.read({ children: '/trash/deleted' })).rows, []);
    const beforeA = runtime.instance.writer.stream.cursor().pos;
    await assert.rejects(
      writer.act({
        path: '/trash',
        component: '#chosen',
        action: 'restore',
        args: captured,
        opId: key(),
      }).outcome,
      (error) => error instanceof KernelError && error.code === 'NOT_FOUND',
    );
    assert.deepEqual(runtime.instance.writer.stream.cursor().pos, beforeA);
    assert.deepEqual((await admin.read({ children: '/docs' })).copies, []);
  },
);

it(
  'commits a decoded public undo through the actual Session journal owner and denies current A revocation',
  { timeout: 10_000 },
  async (t) => {
    const { runtime, writer, admin, key, commit } = await setup(t);
    const grant = (bits: number) => [{ subject: { group: 'public' }, grant: bits }];
    await commit([
      { op: 'put', node: { $path: '/docs', $type: 't.dir', $acl: grant(R | W | A) } },
      { op: 'put', node: { $path: '/docs/item', $type: 't.dir', value: 1 } },
    ]);
    const original = (await admin.read({ node: '/docs/item' })).copies[0];
    assert.ok('node' in original);
    await commit([{ op: 'patch', path: '/docs/item', ops: { $set: { value: 2 } } }]);
    const history = (await writer.read({ history: '/docs/item' })).history!;
    const update = history.at(-1)!;
    assert.equal(update.kind, 'commit');

    /** Send the decoded public member into the real Session commit route. */
    function undo(record: JournalAddress) {
      const request = decodeRequests(
        JSON.stringify({
          t: 'commit',
          req: 'direct-inverse',
          changes: [{ op: 'undo', record }],
          opId: key(),
        }),
        512 * 1024,
      )[0];
      assert.ok(request.t === 'commit');
      return writer.commit(request).outcome;
    }

    await undo(update.address);
    const reversed = (await admin.read({ node: '/docs/item' })).copies[0];
    assert.ok('node' in reversed);
    assert.equal(reversed.node.$id, original.node.$id);
    assert.equal(reversed.node.value, 1);
    await commit([{ op: 'patch', path: '/docs/item', ops: { $set: { value: 3 } } }]);
    const captured = (await writer.read({ history: '/docs/item' })).history!.at(-1)!.address;
    await commit([{ op: 'patch', path: '/docs', ops: { $set: { $acl: grant(R | W) } } }]);
    const position = runtime.instance.writer.stream.cursor().pos;
    await assert.rejects(
      undo(captured),
      (error) => error instanceof KernelError && error.code === 'NOT_FOUND',
    );
    assert.deepEqual(runtime.instance.writer.stream.cursor().pos, position);
    const unchanged = (await admin.read({ node: '/docs/item' })).copies[0];
    assert.ok('node' in unchanged);
    assert.equal(unchanged.node.$id, original.node.$id);
    assert.equal(unchanged.node.value, 3);
  },
);
