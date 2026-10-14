import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { it } from 'node:test';
import { createMemoryBlobStore } from '#kernel/blob-store-memory';
import { createInstance } from '#kernel/instance';
import { positionToRev } from '#kernel/position';
import { drainSession } from '#kernel/session-delivery';
import { createStoreBindingOwner } from '#kernel/store-binding';
import { createMemoryStore } from '#kernel/store/memory';
import {
  R,
  type ModuleManifest,
  type Position,
  type PositionCounter,
  type StoreBinding,
} from '#kernel/types';

it('keeps a shadow identity stable while its canonical revision and protected metadata belong to the upper', async (t) => {
  const id = randomUUID(),
    root = createMemoryStore({ domain: id });
  let saved: Position | undefined,
    epoch = 0;
  const counter: PositionCounter = {
    async load() {
      return saved;
    },
    async save(value) {
      saved = value;
    },
    async freshEpoch(floor) {
      epoch = Math.max(epoch, floor) + 1;
      return epoch;
    },
  };
  const manifest: ModuleManifest = {
    id: 'binding-example',
    open: [],
    security: [],
    types: [
      {
        name: 'binding.value',
        module: 'binding-example',
        security: 'ordinary',
        version: 0,
        schema: {},
        actions: {},
      },
    ],
  };
  const instance = await createInstance({
    id,
    root: { kind: 'store', store: root },
    modules: [manifest],
    blobs: createMemoryBlobStore(),
    provisioning: {
      counter,
      writerEpoch: 1,
      domains: [{ store: root, epoch: randomUUID(), persistent: false }],
      credentialTtlMs: 60_000,
      bootstrap: {
        kind: 'fresh',
        admin: { path: '/admin', name: 'admin', password: randomUUID() },
      },
    },
  });
  const pumps: Promise<void>[] = [];
  t.after(async () => {
    await instance.close();
    await Promise.all(pumps);
    root.close();
  });
  assert.ok(instance.setupCredential);
  const admin = await instance.openSession(instance.setupCredential);
  pumps.push(drainSession(admin));
  const key = () => ({
    epoch: instance.writer.intake.epoch,
    time: Date.now(),
    nonce: randomUUID(),
  });
  const publicRead = [{ subject: { group: 'public' }, grant: R }];
  await admin.commit({
    opId: key(),
    changes: [
      { op: 'put', node: { $path: '/lower', $type: 't.dir', $acl: publicRead } },
      {
        op: 'put',
        node: {
          $path: '/lower/value',
          $type: 'binding.value',
          value: 1,
          $acl: publicRead,
          $owner: 'n:lower-owner',
        },
      },
      { op: 'put', node: { $path: '/upper', $type: 't.dir', $acl: publicRead } },
      { op: 'put', node: { $path: '/branch', $type: 't.dir' } },
    ],
  }).outcome;
  const declaration = (await admin.read({ node: '/branch' })).copies[0];
  assert.ok('node' in declaration);
  const allowance = () => ({
    nodes: 20,
    bytes: 100_000,
    exprWork: 10_000,
    deadline: Date.now() + 1_000,
  });
  const lower = (await root.scan({ range: { node: '/lower/value' }, budget: allowance() }))
    .items[0];
  const binding: StoreBinding = {
    path: '/branch',
    lower: '/lower',
    upper: '/upper',
    describe(upper) {
      return {
        source: 'lower',
        baseId: lower.$id,
        node:
          upper.whiteout === true
            ? null
            : { $path: '/branch/value', $type: 'binding.value', value: upper.value },
      };
    },
    select(source, upper) {
      assert.ok(source);
      assert.equal(Object.hasOwn(source, '$acl'), false);
      assert.equal(Object.hasOwn(source, '$owner'), false);
      return {
        source: 'lower',
        baseId: source.$id,
        node: {
          $path: '/branch/value',
          $type: 'binding.value',
          value: upper?.value ?? source.value,
        },
      };
    },
    async changes() {
      return [];
    },
  };
  const owner = createStoreBindingOwner(id, declaration.node, '', binding);
  const original = owner.project('/branch/value', { lower, upper: null });
  assert.ok(original);
  assert.notEqual(original.$id, lower.$id);
  assert.equal(Object.hasOwn(original, '$owner'), false);
  await admin.commit({
    opId: key(),
    changes: [
      { op: 'put', node: { $path: '/upper/value', $type: 't.dir', value: 2, $acl: publicRead } },
    ],
  }).outcome;
  const upper = (await root.scan({ range: { node: '/upper/value' }, budget: allowance() }))
    .items[0];
  const future = owner.project('/branch/value', { lower, upper });
  assert.ok(future);
  assert.equal(future.$id, original.$id);
  assert.equal(future.value, 2);
  assert.equal(positionToRev(future.$pos), positionToRev(upper.$pos));
  assert.notEqual(positionToRev(future.$pos), positionToRev(lower.$pos));
  await admin.commit({
    opId: key(),
    changes: [
      { op: 'put', node: { $path: '/upper/value', $type: 't.dir', whiteout: true } },
      { op: 'put', node: { $path: '/upper/moved', $type: 't.dir', value: 3 } },
    ],
  }).outcome;
  const accepted = (await root.scan({ range: { children: '/upper' }, budget: allowance() })).items;
  owner.acceptBatch(accepted.map((node) => ({ node, path: node.$path })));
  assert.equal(owner.address(original.$id, lower.$path), '/branch/moved');
  assert.equal(owner.project('/branch/value', { lower, upper: null }), null);
  const moved = accepted.find((node) => node.$path === '/upper/moved');
  assert.ok(moved);
  assert.equal(owner.project('/branch/moved', { lower, upper: moved })?.$id, original.$id);
  const publicSession = await instance.openSession();
  pumps.push(drainSession(publicSession));
  for (const path of ['/lower/value', '/upper/value']) {
    const copy = (await publicSession.read({ node: path })).copies[0];
    assert.ok('node' in copy);
    assert.equal(Object.hasOwn(copy.node, '$acl'), false);
    assert.equal(Object.hasOwn(copy.node, '$owner'), false);
  }
});
