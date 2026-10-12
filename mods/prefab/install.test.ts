import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { it, type TestContext } from 'node:test';
import { getComponent } from '@treenx/core';
import { KernelError } from '@treenx/core/errors';
import { openNativeRuntime } from '@treenx/core/kernel/runtime';
import { drainSession } from '@treenx/core/kernel/session-delivery';
import { installNativeSeeds, type NativeSeedPlan } from '#prefab/install';
import {
  R,
  W,
  type CommitRequest,
  type ModuleManifest,
  type OpId,
  type Pending,
  type Session,
} from '@treenx/core/kernel/types';
import type { NativePrefabSource } from '@treenx/core/mod/native-prefab';
import prefabModule from '#prefab/kernel';
import { nativeSystemManifest } from '@treenx/core/system/native-actions';
import { readNode as readPrefabNode, SOURCE_TYPE, type PrefabInput } from '#prefab/data';

const module: ModuleManifest = {
  id: 'seed-fixture',
  security: [],
  open: [],
  types: [
    {
      name: 'seed.fixture',
      module: 'seed-fixture',
      security: 'ordinary',
      version: 0,
      schema: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'] },
      actions: {},
    },
  ],
};

/** Open an isolated native runtime and record its installation requests. */
async function fixture(t: TestContext) {
  const fixtures = resolve(import.meta.dirname, '../../../temp/native-seed-fixtures');
  await mkdir(fixtures, { recursive: true });
  const directory = await mkdtemp(resolve(fixtures, 'dataset-'));
  const config = {
    id: randomUUID(),
    directory,
    rootExternal: 'none' as const,
    credentialTtlMs: 60_000,
    firstAdmin: { path: '/admin', name: 'admin', password: 'seed-fixture-password' },
    modules: [module, (await prefabModule()).manifest, nativeSystemManifest()],
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
  const requests: CommitRequest[] = [];
  const commit = session.commit.bind(session);
  t.mock.method(session, 'commit', (request: CommitRequest) => {
    requests.push(request);
    return commit(request);
  });
  const key = (): OpId => ({
    epoch: runtime.instance.writer.intake.epoch,
    time: Date.now(),
    nonce: randomUUID(),
  });
  return { session, requests, key, runtime, config, credential, delivery };
}

/** Read one node or surface the kernel's refusal as an error. */
async function read(session: Session, path: string) {
  const copy = (await session.read({ node: path })).copies[0];
  if ('error' in copy) throw new KernelError(copy.error.code, copy.error.message);
  return copy.node;
}

/** Own streamed pieces until the final action outcome arrives. */
async function finish(pending: Pending) {
  for await (const _chunk of pending.chunks) {
  }
  return pending.outcome;
}

/** Build the shared catalog and prefab input for installation tests. */
function plan(opId: OpId, target = '/seed'): NativeSeedPlan {
  return {
    opId,
    sources: [
      { $path: '/sys/mods', $type: 't.dir' },
      { $path: '/sys/mods/demo', $type: 't.dir' },
      { $path: '/sys/mods/demo/prefabs', $type: 't.dir' },
      { $path: '/outside', $type: 'seed.fixture', value: 4 },
    ],
    prefabs: [
      {
        target,
        allowAbsolute: true,
        source: {
          $path: '/sys/mods/demo/prefabs/seed',
          $type: 't.prefab',
          mod: 'demo',
          name: 'seed',
          nodes: [
            {
              $path: '.',
              $type: 'seed.fixture',
              value: 1,
              links: [{ $ref: '/child' }, { $ref: '/absolute' }, { $ref: '/outside' }],
              $id: 'captured-id',
              $rev: 'captured-rev',
              $refId: 'captured-ref',
            },
            { $path: 'child', $type: 'seed.fixture', value: 2 },
            { $path: '/absolute', $type: 'seed.fixture', value: 3 },
          ],
        },
      },
    ],
  };
}

it(
  'links seeded copies to an editable source and propagates fields through native actions',
  { timeout: 10_000 },
  async (t) => {
    const f = await fixture(t);
    const input = plan(f.key());
    await installNativeSeeds(f.session, input);

    const instance = await readPrefabNode(f.session, '/seed/child');
    assert.ok(instance.$prefab);
    assert.equal(instance.$prefab.base.value, 2);
    const record = await read(f.session, instance.$prefab.src);
    assert.equal(record.$type, SOURCE_TYPE);
    const source = getComponent<{ readonly body: PrefabInput }>(record, SOURCE_TYPE);
    assert.ok(source);
    assert.equal(source.body.value, 2);
    const root = await readPrefabNode(f.session, '/seed');
    const absolute = await readPrefabNode(f.session, '/absolute');
    assert.ok(root.$prefab);
    assert.ok(absolute.$prefab);
    await f.session.act({
      opId: f.key(),
      path: input.prefabs[0].source.$path,
      action: 'apply',
      args: { target: root.$path, field: 'links' },
    }).outcome;
    const rootSource = getComponent<{
      readonly body: { readonly links: readonly { readonly $ref: string }[] };
    }>(await read(f.session, root.$prefab.src), SOURCE_TYPE);
    assert.ok(rootSource);
    assert.deepEqual(
      rootSource.body.links.map((link) => link.$ref),
      [instance.$prefab.src, absolute.$prefab.src, '/outside'],
    );

    await f.session.commit({
      opId: f.key(),
      changes: [
        { op: 'patch', path: record.$path, ops: { $set: { body: { ...source.body, value: 4 } } } },
      ],
    }).outcome;
    const invoke = async (action: string, field?: string) => {
      const pending = f.session.act({
        opId: f.key(),
        path: input.prefabs[0].source.$path,
        action,
        args: { target: instance.$path, ...(field === undefined ? {} : { field }) },
      });
      for await (const _chunk of pending.chunks) {
      }
      return pending.outcome;
    };
    await invoke('pull');
    assert.equal((await read(f.session, instance.$path)).value, 4);

    await f.session.commit({
      opId: f.key(),
      changes: [{ op: 'patch', path: instance.$path, ops: { $set: { value: 7 } } }],
    }).outcome;
    await invoke('apply', 'value');
    const changed = getComponent<{ readonly body: PrefabInput }>(
      await read(f.session, record.$path),
      SOURCE_TYPE,
    );
    assert.ok(changed);
    assert.equal(changed.body.value, 7);
    await invoke('pull');
    assert.equal((await readPrefabNode(f.session, instance.$path)).$prefab?.base.value, 4);
    await invoke('revert', 'value');
    assert.equal((await readPrefabNode(f.session, instance.$path)).$prefab?.base.value, 7);
  },
);

it(
  'installs accepted prefab data through bounded requests and preserves it on repeat',
  { timeout: 10_000 },
  async (t) => {
    const f = await fixture(t),
      first = plan(f.key());
    const installed = await installNativeSeeds(f.session, first);
    assert.ok(installed.installed.includes('/seed/child'));
    assert.equal((await read(f.session, '/seed')).value, 1);
    assert.equal((await read(f.session, '/absolute')).value, 3);
    assert.notEqual((await read(f.session, '/seed')).$id, 'captured-id');
    const source = await read(f.session, first.prefabs[0].source.$path);
    const prefab = getComponent<NativePrefabSource>(source, 't.prefab');
    assert.ok(prefab);
    for (const node of prefab.nodes) {
      assert.equal(node.$id, undefined);
      assert.equal(node.$rev, undefined);
      assert.equal(node.$refId, undefined);
    }
    assert.ok(f.requests.every((request) => request.changes.length <= 2));
    const before = f.requests.length;
    assert.deepEqual(
      (await installNativeSeeds(f.session, { ...first, opId: f.key() })).installed,
      [],
    );
    assert.equal(f.requests.length, before);
    assert.deepEqual(await read(f.session, source.$path), source);

    await f.session.commit({ opId: f.key(), changes: [{ op: 'remove', path: '/seed/child' }] })
      .outcome;
    const changedInput: NativeSeedPlan = {
      ...first,
      opId: f.key(),
      prefabs: first.prefabs.map((prefab) => ({
        ...prefab,
        source: {
          ...prefab.source,
          nodes: prefab.source.nodes.map((node) => ({ ...node, value: 99 })),
        },
      })),
    };
    await installNativeSeeds(f.session, changedInput);
    await assert.rejects(
      read(f.session, '/seed/child'),
      (error) => error instanceof KernelError && error.code === 'NOT_FOUND',
    );
    assert.equal((await readPrefabNode(f.session, '/seed')).$prefabChildren?.child.removed, true);
    assert.equal((await read(f.session, '/seed')).value, 1);
    assert.deepEqual(await read(f.session, source.$path), source);
  },
);

it(
  'refuses a replayed installation whose target was subsequently deleted',
  { timeout: 10_000 },
  async (t) => {
    const f = await fixture(t),
      input = plan(f.key(), '/victim');
    await installNativeSeeds(f.session, input);
    const request = f.requests.find((request) =>
      request.changes.some((change) => change.op === 'put' && change.node.$path === '/victim'),
    );
    assert.ok(request);
    const replay = await f.session.commit(request).outcome;
    assert.ok(replay.pos);
    await f.session.commit({
      opId: f.key(),
      changes: [
        { op: 'remove', path: '/victim/child' },
        { op: 'remove', path: '/victim' },
      ],
    }).outcome;
    await assert.rejects(
      installNativeSeeds(f.session, input),
      (error) => error instanceof KernelError && error.code === 'CONFLICT',
    );
    await assert.rejects(
      read(f.session, '/victim'),
      (error) => error instanceof KernelError && error.code === 'NOT_FOUND',
    );
  },
);

it('rejects retiring setup before publishing any source', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t),
    input = plan(f.key());
  await assert.rejects(
    installNativeSeeds(f.session, {
      ...input,
      prefabs: input.prefabs.map((prefab) => ({ ...prefab, setup: () => [] })),
    }),
    (error) => error instanceof KernelError && error.code === 'UNAVAILABLE',
  );
  assert.equal(f.requests.length, 0);
  await assert.rejects(
    read(f.session, '/sys/mods/demo'),
    (error) => error instanceof KernelError && error.code === 'NOT_FOUND',
  );
});

it(
  'reuses the durable accepted source and preserves installed identities after reopening',
  { timeout: 10_000 },
  async (t) => {
    const f = await fixture(t),
      input = plan(f.key());
    await installNativeSeeds(f.session, input);
    const source = await read(f.session, input.prefabs[0].source.$path);
    const target = await read(f.session, '/seed');
    f.session.close();
    await f.delivery;
    await f.runtime.close();
    const reopened = await openNativeRuntime(f.config);
    const session = await reopened.instance.openSession(f.credential);
    const delivery = drainSession(session);
    try {
      const opId = {
        epoch: reopened.instance.writer.intake.epoch,
        time: Date.now(),
        nonce: randomUUID(),
      };
      assert.deepEqual((await installNativeSeeds(session, { ...input, opId })).installed, []);
      assert.deepEqual(await read(session, source.$path), source);
      assert.deepEqual(await read(session, '/seed'), target);
    } finally {
      session.close();
      await delivery;
      await reopened.close();
    }
  },
);

it(
  'deploys accepted prefab data through its public action and skips installed nodes on repeat',
  { timeout: 10_000 },
  async (t) => {
    const f = await fixture(t),
      input = plan(f.key());
    await installNativeSeeds(f.session, input);
    const source = input.prefabs[0].source.$path;
    await f.session.commit({
      opId: f.key(),
      changes: [{ op: 'patch', path: '/sys/limits', ops: { $set: { changeSet: 2 } } }],
    }).outcome;
    const outcome = await finish(
      f.session.act({
        opId: f.key(),
        path: source,
        action: 'deploy',
        args: { target: '/public-copy', allowAbsolute: true },
      }),
    );
    assert.deepEqual(outcome.value, {
      deployed: ['/public-copy', '/public-copy/child'],
      skipped: ['/absolute'],
    });
    const target = await read(f.session, '/public-copy');
    assert.equal(target.value, 1);
    assert.notEqual(target.$id, 'captured-id');
    assert.equal((await read(f.session, '/public-copy/child')).value, 2);
    const provenance = await readPrefabNode(f.session, '/public-copy');
    assert.ok(provenance.$prefab);
    assert.equal((await read(f.session, provenance.$prefab.src)).$type, SOURCE_TYPE);
    const repeat = await finish(
      f.session.act({
        opId: f.key(),
        path: source,
        action: 'deploy',
        args: { target: '/public-copy', allowAbsolute: true },
      }),
    );
    assert.deepEqual(repeat.value, {
      deployed: [],
      skipped: ['/public-copy', '/public-copy/child', '/absolute'],
    });
    assert.deepEqual(await read(f.session, '/public-copy'), target);
  },
);

it(
  'deploys through the system entry point using the prefab owner',
  { timeout: 10_000 },
  async (t) => {
    const f = await fixture(t),
      input = plan(f.key());
    await installNativeSeeds(f.session, input);
    await f.session.commit({
      opId: f.key(),
      changes: [{ op: 'put', node: { $path: '/system', $type: 't.system' } }],
    }).outcome;

    const outcome = await finish(
      f.session.act({
        path: '/system',
        action: 'deploy_prefab',
        args: {
          source: input.prefabs[0].source.$path,
          target: '/system-copy',
          allowAbsolute: true,
        },
        opId: f.key(),
      }),
    );

    assert.deepEqual(outcome.value, {
      deployed: ['/system-copy', '/system-copy/child'],
      skipped: ['/absolute'],
    });
    assert.equal((await read(f.session, '/system-copy/child')).value, 2);
  },
);

it(
  'refuses invalid public deployment paths before publishing any target',
  { timeout: 10_000 },
  async (t) => {
    const f = await fixture(t),
      input = plan(f.key());
    await installNativeSeeds(f.session, input);
    await assert.rejects(
      f.session.act({
        opId: f.key(),
        path: input.prefabs[0].source.$path,
        action: 'deploy',
        args: { target: '/refused' },
      }).outcome,
      (error) => error instanceof KernelError && error.code === 'INVALID',
    );
    await assert.rejects(
      read(f.session, '/refused'),
      (error) => error instanceof KernelError && error.code === 'NOT_FOUND',
    );
  },
);

it(
  'uses the ordinary caller rights for every deployment destination and refuses the whole decision',
  { timeout: 10_000 },
  async (t) => {
    const f = await fixture(t);
    const publicWrite = [{ subject: { group: 'public' }, grant: R | W }];
    await f.session.commit({
      opId: f.key(),
      changes: [
        {
          op: 'put',
          node: {
            $path: '/prefab',
            $type: 't.prefab',
            mod: 'demo',
            name: 'copy',
            $acl: publicWrite,
            nodes: [
              { $path: 'first', $type: 'seed.fixture', value: 1 },
              { $path: '/blocked/new', $type: 'seed.fixture', value: 2 },
            ],
          },
        },
        { op: 'put', node: { $path: '/allowed', $type: 't.dir', $acl: publicWrite } },
        { op: 'put', node: { $path: '/blocked', $type: 't.dir' } },
      ],
    }).outcome;
    const caller = await f.runtime.instance.openSession();
    const delivery = drainSession(caller);
    t.after(async () => {
      caller.close();
      await delivery;
    });
    const invoke = () =>
      finish(
        caller.act({
          opId: f.key(),
          path: '/prefab',
          action: 'deploy',
          args: { target: '/allowed', allowAbsolute: true },
        }),
      );

    await assert.rejects(
      invoke(),
      (error) => error instanceof KernelError && error.code === 'FORBIDDEN',
    );
    await assert.rejects(
      read(f.session, '/allowed/first'),
      (error) => error instanceof KernelError && error.code === 'NOT_FOUND',
    );
    await assert.rejects(
      read(f.session, '/blocked/new'),
      (error) => error instanceof KernelError && error.code === 'NOT_FOUND',
    );
    await f.session.commit({
      opId: f.key(),
      changes: [{ op: 'patch', path: '/blocked', ops: { $set: { $acl: publicWrite } } }],
    }).outcome;
    const result = await invoke();
    assert.deepEqual(result.value, { deployed: ['/allowed/first', '/blocked/new'], skipped: [] });
    assert.equal((await read(f.session, '/allowed/first')).value, 1);
    assert.equal((await read(f.session, '/blocked/new')).value, 2);
  },
);
