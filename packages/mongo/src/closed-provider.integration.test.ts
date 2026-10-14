import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { it } from 'node:test';
import { KernelError } from '@treenx/core/errors';
import { openNativeRuntime } from '@treenx/core/kernel/runtime';
import { createMongoManifest } from '#native-mount';
import { createMongoClosedProvider } from '#closed-provider';

it('admits each closed Mongo sibling and retires the shared generation on rotation and secret denial', async (t) => {
  const uri = process.env.NATIVE_MONGO_TEST_URI;
  assert.ok(uri);
  const suffix = randomUUID().replaceAll('-', '');
  const id = `closed-mongo-${suffix}`;
  const parent = resolve('temp/closed-mongo-fixtures');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(`${parent}/run-`);
  const runtime = await openNativeRuntime({
    id,
    directory,
    credentialTtlMs: 60_000,
    firstAdmin: { path: '/admin', name: 'admin', password: 'closed-mongo-fixture' },
    modules: [
      createMongoManifest({
        cluster: {
          connection: '/connection',
          domain: suffix,
          instance: id,
          journalDb: `closed_${suffix}`,
          journalCollection: 'journal',
        },
      }),
    ],
  });
  assert.ok(runtime.instance.setupCredential);
  const admin = await runtime.instance.openSession(runtime.instance.setupCredential);
  const draining = (async () => {
    for await (const frame of admin.frames) void frame;
  })();
  t.after(async () => {
    await runtime.close();
    await draining;
  });
  const key = () => ({
    epoch: runtime.instance.writer.intake.epoch,
    time: Date.now(),
    nonce: randomUUID(),
  });
  const root = (await admin.read({ node: '/' })).copies[0];
  assert.ok('node' in root);
  await admin.commit({
    opId: key(),
    changes: [
      {
        op: 'patch',
        path: '/',
        ops: {
          $set: {
            $acl: [
              ...(root.node.$acl ?? []),
              { subject: { group: 'public' }, grant: 3 },
              { subject: { group: 'mongo' }, grant: 3 },
            ],
          },
        },
      },
    ],
  }).outcome;
  await admin.commit({
    opId: key(),
    changes: [
      {
        op: 'put',
        node: {
          $path: '/stranger',
          $type: 't.mount.mongo',
          pattern: '',
          cluster: 'cluster',
          db: `stranger_${suffix}`,
          collection: 'nodes',
          '#groups': { $type: 't.groups', list: ['mongo'] },
        },
      },
      { op: 'put', node: { $path: '/connection', $type: 't.mongo.connection', uri } },
      {
        op: 'put',
        node: {
          $path: '/dual',
          $type: 't.mount.mongo',
          pattern: 'left',
          cluster: 'cluster',
          db: `left_${suffix}`,
          collection: 'nodes',
          '#right': {
            $type: 't.mount.mongo',
            pattern: 'right',
            cluster: 'cluster',
            db: `right_${suffix}`,
            collection: 'nodes',
          },
          '#groups': { $type: 't.groups', list: ['mongo'] },
        },
      },
    ],
  }).outcome;
  const stranger = await runtime.instance.openNodeSession('/stranger');
  const strangerFrames = (async () => {
    for await (const frame of stranger.frames) void frame;
  })();
  t.after(async () => {
    stranger.close();
    await strangerFrames;
  });
  const denied = (error: unknown) => error instanceof KernelError && error.code === 'FORBIDDEN';
  await stranger.commit({
    opId: key(),
    changes: [{ op: 'put', node: { $path: '/ordinary-write', $type: 't.dir' } }],
  }).outcome;
  assert.equal((await stranger.read({ node: '/ordinary-write' })).copies.length, 1);
  await assert.rejects(
    stranger.read({ node: '/connection' }),
    (error: unknown) => error instanceof KernelError && error.code === 'NOT_FOUND',
  );
  await assert.rejects(
    stranger.commit({
      opId: key(),
      changes: [
        {
          op: 'put',
          node: {
            $path: '/other-connection',
            $type: 't.mongo.connection',
            uri,
          },
        },
      ],
    }).outcome,
    denied,
  );
  await assert.rejects(
    stranger.commit({
      opId: key(),
      changes: [{ op: 'patch', path: '/connection', ops: { $set: { uri } } }],
    }).outcome,
    denied,
  );
  await assert.rejects(
    stranger.commit({ opId: key(), changes: [{ op: 'remove', path: '/connection' }] }).outcome,
    denied,
  );
  const declaring = (await admin.read({ node: '/dual' })).copies[0];
  assert.ok('node' in declaring);
  await admin.commit({
    opId: key(),
    expect: { nodes: [{ path: '/dual', rev: declaring.node.$rev }] },
    changes: [
      {
        op: 'patch',
        path: '/connection',
        ops: {
          $set: {
            $acl: [{ subject: { group: `n:${declaring.node.$id}` }, grant: 1 }],
          },
        },
      },
    ],
  }).outcome;
  await admin.read({ children: '/dual/left' });
  await admin.read({ children: '/dual/right' });
  const declared = await runtime.instance.openNodeSession('/dual');
  const declaredFrames = (async () => {
    for await (const frame of declared.frames) void frame;
  })();
  const pool = createMongoClosedProvider();
  const binding = {
    connection: '/connection',
    domain: `invariant_${suffix}`,
    instance: id,
    journalDb: `invariant_${suffix}`,
    journalCollection: 'journal',
  };
  const target = await pool.open('invariant', binding, declared, {
    db: `invariant_${suffix}`,
    collection: 'nodes',
    logicalBase: '/invariant',
  });
  await assert.rejects(
    pool.open('invariant', { ...binding, domain: `other_${suffix}` }, declared, {
      db: `invariant_${suffix}`,
      collection: 'sibling',
      logicalBase: '/invariant',
    }),
    (error: unknown) => error instanceof KernelError && error.code === 'CONFLICT',
  );
  await target.close();
  declared.close();
  await declaredFrames;
  console.log('closed-provider: sibling write');
  await admin.commit({
    opId: key(),
    changes: [
      { op: 'put', node: { $path: '/dual/left/a', $type: 't.dir', value: 1 } },
      { op: 'put', node: { $path: '/dual/right/b', $type: 't.dir', value: 2 } },
    ],
  }).outcome;
  assert.equal((await admin.read({ node: '/dual/left/a' })).copies.length, 1);
  console.log('closed-provider: rotation');
  const rotated = new URL(uri);
  rotated.searchParams.set('appName', 'rotated-connection');
  await admin.commit({
    opId: key(),
    changes: [{ op: 'patch', path: '/connection', ops: { $set: { uri: rotated.href } } }],
  }).outcome;
  assert.equal((await admin.read({ node: '/dual/right/b' })).copies.length, 1);
  assert.equal((await admin.read({ node: '/dual/left/a' })).copies.length, 1);
  console.log('closed-provider: move');
  await admin.commit({
    opId: key(),
    changes: [{ op: 'move', from: '/dual/left/a', to: '/dual/right/a' }],
  }).outcome;
  assert.equal((await admin.read({ node: '/dual/right/a' })).copies.length, 1);
  const previousDeclaration = (await admin.read({ node: '/dual' })).copies[0];
  assert.ok('node' in previousDeclaration);
  await runtime.instance.transferSubtree({
    path: '/dual',
    component: '#right',
    declaration: {
      $type: 't.mount.mongo',
      pattern: 'right',
      cluster: 'cluster',
      db: `right_${suffix}`,
      collection: 'replacement',
    },
  });
  const replacementDeclaration = (await admin.read({ node: '/dual' })).copies[0];
  assert.ok('node' in replacementDeclaration);
  assert.equal(replacementDeclaration.node.$id, previousDeclaration.node.$id);
  assert.notEqual(replacementDeclaration.node.$rev, previousDeclaration.node.$rev);
  assert.equal((await admin.read({ node: '/dual/right/a' })).copies.length, 1);
  await runtime.instance.transferSubtree({
    path: '/dual',
    component: '#third',
    declaration: {
      $type: 't.mount.mongo',
      pattern: 'third',
      cluster: 'cluster',
      db: `third_${suffix}`,
      collection: 'nodes',
    },
  });
  await admin.commit({
    opId: key(),
    changes: [
      {
        op: 'put',
        node: {
          $path: '/dual/third/c',
          $type: 't.dir',
          value: 3,
        },
      },
    ],
  }).outcome;
  assert.equal((await admin.read({ node: '/dual/third/c' })).copies.length, 1);
  const copying = runtime.instance.writer.copyTarget;
  let entered!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const continueCopy = new Promise<void>((resolve) => {
    release = resolve;
  });
  runtime.instance.writer.copyTarget = async (...args: Parameters<typeof copying>) => {
    entered();
    await continueCopy;
    return copying(...args);
  };
  const refused = assert.rejects(
    runtime.instance.transferSubtree({
      path: '/dual',
      component: '#fourth',
      declaration: {
        $type: 't.mount.mongo',
        pattern: 'fourth',
        cluster: 'cluster',
        db: `fourth_${suffix}`,
        collection: 'nodes',
      },
    }),
    (error: unknown) =>
      error instanceof KernelError &&
      (error.code === 'UNAUTHENTICATED' || error.code === 'CONFLICT'),
  );
  try {
    await reached;
    rotated.searchParams.set('appName', 'changed-during-copy');
    await admin.commit({
      opId: key(),
      changes: [{ op: 'patch', path: '/connection', ops: { $set: { uri: rotated.href } } }],
    }).outcome;
  } finally {
    release();
    runtime.instance.writer.copyTarget = copying;
  }
  await refused;
  const unchangedDeclaration = (await admin.read({ node: '/dual' })).copies[0];
  assert.ok('node' in unchangedDeclaration);
  assert.equal('#fourth' in unchangedDeclaration.node, false);
  console.log('closed-provider: deny');
  await admin.commit({
    opId: key(),
    changes: [
      {
        op: 'patch',
        path: '/connection',
        ops: { $set: { $acl: [{ subject: { group: 'mongo' }, deny: 1 }] } },
      },
    ],
  }).outcome;
  await assert.rejects(
    admin.read({ children: '/dual/right' }),
    (error: unknown) =>
      error instanceof KernelError && (error.code === 'FORBIDDEN' || error.code === 'NOT_FOUND'),
  );
});
