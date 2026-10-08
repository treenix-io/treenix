import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it, type TestContext } from 'node:test';
import { KernelError } from '#errors';
import { createMemoryBlobStore } from '#kernel/blob-store-memory';
import { createInstance } from '#kernel/instance';
import { drainSession } from '#kernel/session-delivery';
import { createMemoryStore } from '#kernel/store/memory';
import {
  R,
  W,
  type ModuleManifest,
  type OpId,
  type Position,
  type PositionCounter,
} from '#kernel/types';

const code = (expected: KernelError['code']) => (error: unknown) =>
  error instanceof KernelError && error.code === expected;

const manifest: ModuleManifest = {
  id: 'self-grant-form',
  types: [
    {
      name: 'self-grant.form',
      module: 'self-grant-form',
      security: 'user-capability',
      version: 0,
      schema: {},
      actions: { submit: { kind: 'setuid', args: {}, handler: async () => undefined } },
    },
  ],
  security: [],
  open: [],
};

/** Uses the canonical creator and its actual admin lane to authorize the form's configuration. */
async function fixture(t: TestContext) {
  const id = `self-grant:${randomUUID()}`;
  const root = createMemoryStore({ domain: id });
  let saved: Position | undefined;
  let issuedEpoch = 0;
  const counter: PositionCounter = {
    /** Restore the latest position saved by this test instance. */
    async load() {
      return saved;
    },
    /** Retain the accepted position for the next writer operation. */
    async save(position) {
      saved = position;
    },
    /** Allocate a fresh test epoch above the durable floor. */
    async freshEpoch(floor) {
      issuedEpoch = Math.max(issuedEpoch, floor) + 1;
      return issuedEpoch;
    },
  };
  const instance = await createInstance({
    id,
    root: { kind: 'store', store: root },
    blobs: createMemoryBlobStore(),
    modules: [manifest],
    provisioning: {
      counter,
      writerEpoch: 1,
      domains: [{ store: root, epoch: randomUUID(), persistent: false }],
      credentialTtlMs: 60_000,
      bootstrap: {
        kind: 'fresh',
        admin: { path: '/auth/users/admin', name: 'admin', password: randomUUID() },
      },
    },
  });
  const deliveries: Promise<void>[] = [];
  t.after(async () => {
    await instance.close();
    await Promise.all(deliveries);
  });
  assert.ok(instance.setupCredential);
  const admin = await instance.openSession(instance.setupCredential);
  deliveries.push(drainSession(admin));

  /** Identifies each real Pending mutation in the current intake epoch. */
  function key(): OpId {
    return { epoch: instance.writer.intake.epoch, time: Date.now(), nonce: randomUUID() };
  }

  await admin.commit({
    opId: key(),
    changes: [
      {
        op: 'put',
        node: {
          $path: '/form',
          $type: 'self-grant.form',
          destination: '/form',
          $acl: [{ subject: { group: 'public' }, grant: R }],
        },
      },
      { op: 'put', node: { $path: '/destination', $type: 't.dir' } },
    ],
  }).outcome;
  const copy = (await admin.read({ node: '/form' })).copies[0];
  assert.ok('node' in copy);
  return { instance, admin, form: copy.node, key, deliveries };
}

describe('native pinned executor self grants', { timeout: 10_000 }, () => {
  it('authorizes another destination with the declared form version', async (t) => {
    const f = await fixture(t);
    const acl = [{ subject: { group: `n:${f.form.$id}` }, grant: R | W }];
    const outcome = await f.admin.commit({
      opId: f.key(),
      expect: { nodes: [{ path: f.form.$path, rev: f.form.$rev }] },
      changes: [{ op: 'patch', path: '/destination', ops: { $set: { $acl: acl } } }],
    }).outcome;
    assert.ok(outcome.pos);
    const copy = (await f.admin.read({ node: '/destination' })).copies[0];
    assert.ok('node' in copy);
    assert.deepEqual(copy.node.$acl, acl);
  });

  it('grants the exact form configuration rights on its own children without granting its caller W', async (t) => {
    const f = await fixture(t);
    const acl = [
      { subject: { group: 'public' }, grant: R },
      { subject: { group: `n:${f.form.$id}` }, grant: R | W },
    ];
    const outcome = await f.admin.commit({
      opId: f.key(),
      expect: { nodes: [{ path: f.form.$path, rev: f.form.$rev }] },
      changes: [{ op: 'patch', path: f.form.$path, ops: { $set: { $acl: acl } } }],
    }).outcome;
    assert.ok(outcome.pos);
    const copy = (await f.admin.read({ node: '/form' })).copies[0];
    assert.ok('node' in copy);
    assert.equal(copy.node.destination, f.form.destination);
    assert.deepEqual(copy.node.$acl, acl);

    const executor = await f.instance.openNodeSession('/form');
    f.deliveries.push(drainSession(executor));
    assert.equal(executor.actor.principal, `n:${f.form.$id}`);
    assert.deepEqual(executor.actor.claims, [`n:${f.form.$id}`]);
    assert.ok('node' in (await executor.read({ node: '/form' })).copies[0]);
    await executor.commit({
      opId: f.key(),
      changes: [
        {
          op: 'put',
          node: { $path: '/form/submission', $type: 't.dir', email: 'user@example.test' },
        },
      ],
    }).outcome;
    const child = (await executor.read({ node: '/form/submission' })).copies[0];
    assert.ok('node' in child);
    assert.equal(child.node.email, 'user@example.test');
    await assert.rejects(executor.read({ node: '/destination' }), code('NOT_FOUND'));
    await assert.rejects(
      executor.commit({
        opId: f.key(),
        changes: [{ op: 'patch', path: '/form', ops: { $set: { destination: '/destination' } } }],
      }).outcome,
      code('FORBIDDEN'),
    );

    const caller = await f.instance.openSession();
    f.deliveries.push(drainSession(caller));
    assert.ok('node' in (await caller.read({ node: '/form' })).copies[0]);
    await assert.rejects(
      caller.commit({
        opId: f.key(),
        changes: [{ op: 'put', node: { $path: '/form/direct', $type: 't.dir' } }],
      }).outcome,
      code('FORBIDDEN'),
    );
    const children = await f.admin.read({ children: '/form' });
    assert.equal(children.copies.length, 1);
    assert.ok('node' in children.copies[0]);
    assert.equal(children.copies[0].node.$path, '/form/submission');
  });
});
