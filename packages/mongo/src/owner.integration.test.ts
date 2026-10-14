import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { it } from 'node:test';
import { MongoClient, type CommandStartedEvent, type CommandSucceededEvent } from 'mongodb';
import { getSharedClient } from '#index';
import { KernelError } from '@treenx/core/errors';
import { scanBudget, storeCommit, storedNode } from '@treenx/core/kernel/testing';

it('shares one atomic journal across distinct collection handles in different databases', async () => {
  const uri = process.env.NATIVE_MONGO_TEST_URI;
  assert.ok(uri);
  const client = new MongoClient(uri);
  const suffix = randomUUID().replaceAll('-', '');
  try {
    await client.connect();
    assert.equal((await client.db('admin').command({ hello: 1 })).isWritablePrimary, true);
    const { openMongoTransactionOwner } = await import('./owner');
    const owner = await openMongoTransactionOwner({
      uri,
      domain: `owner:${suffix}`,
      instance: 'test',
      journalDb: `owner_${suffix}`,
      journalCollection: 'journal',
    });
    try {
      const left = await owner.openCollection({
        db: `left_${suffix}`,
        collection: 'nodes',
        logicalBase: '/left',
      });
      const right = await owner.openCollection({
        db: `right_${suffix}`,
        collection: 'nodes',
        logicalBase: '/right',
      });
      assert.notEqual(left, right);
      assert.equal(left.transactionOwner, owner);
      assert.equal(right.transactionOwner, owner);
      const commit = storeCommit(
        1,
        [storedNode('/left/a'), storedNode('/right/b')],
        [],
        owner.resources.writerEpoch,
      );
      await owner.commit(commit, [
        { store: left, writes: [commit.writes[0]] },
        { store: right, writes: [commit.writes[1]] },
      ]);
      assert.deepEqual(
        (await left.scan({ range: { subtree: '/left' }, budget: scanBudget() })).items,
        [commit.writes[0].node],
      );
      assert.deepEqual(
        (await right.scan({ range: { subtree: '/right' }, budget: scanBudget() })).items,
        [commit.writes[1].node],
      );
      for (const handle of [left, right])
        assert.deepEqual(
          (await handle.scan({ range: { journal: '/' }, budget: scanBudget() })).items,
          [commit.record],
        );
      assert.equal(
        await client.db(`left_${suffix}`).collection('nodes').countDocuments({ _path: '/a' }),
        1,
      );
      await left.close();
      await assert.rejects(
        left.scan({ range: { node: '/left/a' }, budget: scanBudget() }),
        (error: unknown) => error instanceof KernelError && error.code === 'UNAVAILABLE',
      );
      assert.deepEqual(
        (await right.scan({ range: { node: '/right/b' }, budget: scanBudget() })).items,
        [commit.writes[1].node],
      );
      await right.close();
    } finally {
      await owner.close();
    }
  } finally {
    await client.close();
  }
});

it('fences an older owner and preserves the real instance and continuity across acquisition', async () => {
  const uri = process.env.NATIVE_MONGO_TEST_URI;
  assert.ok(uri);
  const { openMongoTransactionOwner } = await import('./owner');
  const suffix = randomUUID().replaceAll('-', '');
  const options = {
    uri,
    domain: `owner:${suffix}`,
    instance: 'test',
    journalDb: `fence_${suffix}`,
    journalCollection: 'journal',
  };
  const first = await openMongoTransactionOwner(options);
  const handle = await first.openCollection({
    db: options.journalDb,
    collection: 'nodes',
    logicalBase: '/',
  });
  const seed = storeCommit(1, [storedNode('/a')], [], first.resources.writerEpoch);
  await handle.commit(seed);
  const second = await openMongoTransactionOwner(options);
  const reopened = await second.openCollection({
    db: options.journalDb,
    collection: 'nodes',
    logicalBase: '/',
  });
  try {
    assert.equal(second.resources.epoch, first.resources.epoch);
    assert.equal(second.resources.decisionHistory, 'retained');
    assert.ok(second.resources.writerEpoch > first.resources.writerEpoch);
    await assert.rejects(
      handle.commit(storeCommit(2, [storedNode('/b')], [], first.resources.writerEpoch)),
      (error: unknown) => error instanceof KernelError && error.code === 'CONFLICT',
    );
    await assert.rejects(
      openMongoTransactionOwner({ ...options, instance: 'another' }),
      (error: unknown) => error instanceof KernelError && error.code === 'INVALID',
    );
    assert.deepEqual(
      (await reopened.scan({ range: { subtree: '/' }, budget: scanBudget() })).items,
      seed.writes.map((write) => write.node),
    );
  } finally {
    await handle.close();
    await reopened.close();
    await first.close();
    await second.close();
  }
});

it('rolls back every group and the shared journal when a later collection write fails', async () => {
  const uri = process.env.NATIVE_MONGO_TEST_URI;
  assert.ok(uri);
  const { openMongoTransactionOwner } = await import('./owner');
  const suffix = randomUUID().replaceAll('-', '');
  const owner = await openMongoTransactionOwner({
    uri,
    domain: `owner:${suffix}`,
    instance: 'test',
    journalDb: `rollback_${suffix}`,
    journalCollection: 'journal',
  });
  const left = await owner.openCollection({
    db: `rollback_${suffix}`,
    collection: 'left',
    logicalBase: '/left',
  });
  const right = await owner.openCollection({
    db: `rollback_${suffix}`,
    collection: 'right',
    logicalBase: '/right',
  });
  try {
    const seed = storeCommit(
      1,
      [{ ...storedNode('/right/existing'), $id: 'retained' }],
      [],
      owner.resources.writerEpoch,
    );
    await right.commit(seed);
    const rejected = storeCommit(
      2,
      [storedNode('/left/new'), { ...storedNode('/right/duplicate'), $id: 'retained' }],
      [],
      owner.resources.writerEpoch,
    );
    await assert.rejects(
      owner.commit(rejected, [
        { store: left, writes: [rejected.writes[0]] },
        { store: right, writes: [rejected.writes[1]] },
      ]),
      (error: unknown) => error instanceof KernelError && error.code === 'CONFLICT',
    );
    assert.deepEqual(
      (await left.scan({ range: { subtree: '/left' }, budget: scanBudget() })).items,
      [],
    );
    assert.deepEqual(
      (await right.scan({ range: { subtree: '/right' }, budget: scanBudget() })).items,
      seed.writes.map((write) => write.node),
    );
    for (const handle of [left, right])
      assert.deepEqual(
        (await handle.scan({ range: { journal: '/' }, budget: scanBudget() })).items,
        [seed.record],
      );
  } finally {
    await left.close();
    await right.close();
    await owner.close();
  }
});

it('rejects a different owner capability and an incomplete canonical partition before writing', async () => {
  const uri = process.env.NATIVE_MONGO_TEST_URI;
  assert.ok(uri);
  const { openMongoTransactionOwner } = await import('./owner');
  const suffix = randomUUID().replaceAll('-', '');
  const options = {
    uri,
    domain: 'same-domain',
    instance: 'test',
    journalDb: `capability_${suffix}`,
    journalCollection: 'journal',
  };
  const first = await openMongoTransactionOwner(options);
  const second = await openMongoTransactionOwner({
    ...options,
    journalCollection: 'different-journal',
  });
  const left = await first.openCollection({
    db: options.journalDb,
    collection: 'left',
    logicalBase: '/left',
  });
  const foreign = await second.openCollection({
    db: options.journalDb,
    collection: 'right',
    logicalBase: '/right',
  });
  try {
    const commit = storeCommit(
      1,
      [storedNode('/left/a'), storedNode('/right/b')],
      [],
      first.resources.writerEpoch,
    );
    const invalid = (error: unknown) => error instanceof KernelError && error.code === 'INVALID';
    await assert.rejects(
      first.commit(commit, [
        { store: left, writes: [commit.writes[0]] },
        { store: foreign, writes: [commit.writes[1]] },
      ]),
      invalid,
    );
    await assert.rejects(
      first.commit(commit, [{ store: left, writes: [commit.writes[0]] }]),
      invalid,
    );
    assert.deepEqual(
      (await left.scan({ range: { subtree: '/left' }, budget: scanBudget() })).items,
      [],
    );
    assert.deepEqual(
      (await foreign.scan({ range: { subtree: '/right' }, budget: scanBudget() })).items,
      [],
    );
  } finally {
    await left.close();
    await foreign.close();
    await first.close();
    await second.close();
  }
});

it('refuses a physical collection bound to another logical base', async () => {
  const uri = process.env.NATIVE_MONGO_TEST_URI;
  assert.ok(uri);
  const { openMongoTransactionOwner } = await import('./owner');
  const suffix = randomUUID().replaceAll('-', '');
  const db = `namespace_${suffix}`;
  const owner = await openMongoTransactionOwner({
    uri,
    domain: suffix,
    instance: 'test',
    journalDb: db,
    journalCollection: 'journal',
  });
  const handles = [await owner.openCollection({ db, collection: 'nodes', logicalBase: '/left' })];
  try {
    await assert.rejects(
      async () => {
        handles.push(
          await owner.openCollection({ db, collection: 'nodes', logicalBase: '/right' }),
        );
      },
      (error: unknown) => error instanceof KernelError && error.code === 'CONFLICT',
    );
    assert.deepEqual(
      (await handles[0].scan({ range: { subtree: '/left' }, budget: scanBudget() })).items,
      [],
    );
  } finally {
    for (const handle of handles) await handle.close();
    await owner.close();
  }
});

it('refuses data aliases of the shared journal and control collections', async () => {
  const uri = process.env.NATIVE_MONGO_TEST_URI;
  assert.ok(uri);
  const { openMongoTransactionOwner } = await import('./owner');
  const suffix = randomUUID().replaceAll('-', '');
  const db = `internal_namespace_${suffix}`;
  const owner = await openMongoTransactionOwner({
    uri,
    domain: suffix,
    instance: 'test',
    journalDb: db,
    journalCollection: 'journal',
  });
  const handles: Awaited<ReturnType<typeof owner.openCollection>>[] = [];
  try {
    for (const collection of ['journal', 'journal.__control'])
      await assert.rejects(
        async () => {
          handles.push(await owner.openCollection({ db, collection, logicalBase: '/' }));
        },
        (error: unknown) => error instanceof KernelError && error.code === 'CONFLICT',
      );
  } finally {
    for (const handle of handles) await handle.close();
    await owner.close();
  }
});

it('refuses another persisted owner binding the same physical data collection', async () => {
  const uri = process.env.NATIVE_MONGO_TEST_URI;
  assert.ok(uri);
  const { openMongoTransactionOwner } = await import('./owner');
  const suffix = randomUUID().replaceAll('-', '');
  const db = `different_namespace_${suffix}`;
  const options = {
    uri,
    domain: suffix,
    instance: 'test',
    journalDb: db,
    journalCollection: 'first',
  };
  const first = await openMongoTransactionOwner(options);
  const second = await openMongoTransactionOwner({ ...options, journalCollection: 'second' });
  const handles = [await first.openCollection({ db, collection: 'nodes', logicalBase: '/' })];
  try {
    await assert.rejects(
      async () => {
        handles.push(await second.openCollection({ db, collection: 'nodes', logicalBase: '/' }));
      },
      (error: unknown) => error instanceof KernelError && error.code === 'CONFLICT',
    );
  } finally {
    for (const handle of handles) await handle.close();
    await first.close();
    await second.close();
  }
});

it('reopens a retired physical collection at a new logical base while preserving canonical history', async () => {
  const uri = process.env.NATIVE_MONGO_TEST_URI;
  assert.ok(uri);
  const { openMongoTransactionOwner } = await import('./owner');
  const suffix = randomUUID().replaceAll('-', '');
  const db = `rebind_${suffix}`;
  const owner = await openMongoTransactionOwner({
    uri,
    domain: suffix,
    instance: 'test',
    journalDb: db,
    journalCollection: 'journal',
  });
  const first = await owner.openCollection({ db, collection: 'nodes', logicalBase: '/left' });
  let second: Awaited<ReturnType<typeof owner.openCollection>> | undefined;
  try {
    const seed = storeCommit(1, [storedNode('/left/a')], [], owner.resources.writerEpoch);
    await first.commit(seed);
    await first.close();
    second = await owner.openCollection({ db, collection: 'nodes', logicalBase: '/right' });
    const reopened = (await second.scan({ range: { node: '/right/a' }, budget: scanBudget() }))
      .items[0];
    assert.equal(reopened.$id, seed.writes[0].node.$id);
    assert.deepEqual(reopened.$pos, seed.pos);
    assert.deepEqual((await second.scan({ range: { journal: '/' }, budget: scanBudget() })).items, [
      seed.record,
    ]);
    const update = storeCommit(
      2,
      [{ ...reopened, value: 2 }],
      [seed.writes[0].node],
      owner.resources.writerEpoch,
    );
    await second.commit(update);
    assert.deepEqual((await second.scan({ range: { journal: '/' }, budget: scanBudget() })).items, [
      seed.record,
      update.record,
    ]);
  } finally {
    await first.close();
    await second?.close();
    await owner.close();
  }
});

it('holds the owner pool until a scan on a retired handle settles', async () => {
  const uri = process.env.NATIVE_MONGO_TEST_URI;
  assert.ok(uri);
  const monitoredUri = `${uri}&monitorCommands=true`;
  const { openMongoTransactionOwner } = await import('./owner');
  const suffix = randomUUID().replaceAll('-', '');
  const owner = await openMongoTransactionOwner({
    uri: monitoredUri,
    domain: suffix,
    instance: 'test',
    journalDb: `lifetime_${suffix}`,
    journalCollection: 'journal',
  });
  const store = await owner.openCollection({
    db: `lifetime_${suffix}`,
    collection: 'nodes',
    logicalBase: '/',
  });
  const admin = new MongoClient(uri);
  const pool = getSharedClient(monitoredUri);
  const monitored = await pool.ready;
  await pool.release();
  let completed = false;
  const succeeded = (event: CommandSucceededEvent) => {
    if (event.commandName === 'find') completed = true;
  };
  try {
    await admin.connect();
    await store.commit(storeCommit(1, [storedNode('/a')], [], owner.resources.writerEpoch));
    await admin.db('admin').command({
      configureFailPoint: 'failCommand',
      mode: { times: 1 },
      data: { failCommands: ['find'], blockConnection: true, blockTimeMS: 200 },
    });
    const observed = new Promise<void>((resolve) => {
      const started = (event: CommandStartedEvent) => {
        if (event.commandName === 'find' && event.command.find === 'nodes') {
          monitored.off('commandStarted', started);
          resolve();
        }
      };
      monitored.on('commandStarted', started);
    });
    monitored.on('commandSucceeded', succeeded);
    const pending = Promise.allSettled([
      store.scan({ range: { node: '/a' }, budget: scanBudget() }),
    ]);
    await observed;
    await owner.close();
    await store.close();
    const [outcome] = await pending;
    assert.equal(outcome.status, 'rejected');
    if (outcome.status !== 'rejected') throw new Error('Retired scan unexpectedly succeeded');
    assert.ok(outcome.reason instanceof KernelError && outcome.reason.code === 'UNAVAILABLE');
    assert.equal(completed, true);
  } finally {
    monitored.off('commandSucceeded', succeeded);
    await admin.db('admin').command({ configureFailPoint: 'failCommand', mode: 'off' });
    await store.close();
    await owner.close();
    await admin.close();
  }
});

it('reads actual position, intake and full decision metadata without unrelated large entry images', async () => {
  const uri = process.env.NATIVE_MONGO_TEST_URI;
  assert.ok(uri);
  const { openMongoTransactionOwner } = await import('./owner');
  const suffix = randomUUID().replaceAll('-', '');
  const db = `metadata_${suffix}`;
  const options = {
    uri,
    domain: suffix,
    instance: 'test',
    journalDb: db,
    journalCollection: 'journal',
  };
  const owner = await openMongoTransactionOwner(options);
  const handle = await owner.openCollection({ db, collection: 'nodes', logicalBase: '/' });
  try {
    const opId = { nonce: 'original', time: 1, epoch: 'epoch' };
    const first = storeCommit(
      1,
      [storedNode('/large', { payload: 'x'.repeat(9 * 1024 * 1024) })],
      [],
      owner.resources.writerEpoch,
    );
    const intake = { epoch: 'intake', boundary: 1, domains: { [suffix]: owner.resources.epoch } };
    await handle.commit({ ...first, record: { ...first.record, intake } });
    const next = storeCommit(2, [], [], owner.resources.writerEpoch);
    const decision = {
      opId,
      requestHash: 'request',
      stream: { executor: 'u:actor' as const, target: 'target' },
      outcome: { pos: next.pos, value: { complete: true } },
    };
    const accepted = {
      ...next,
      record: {
        ...next.record,
        caller: 'u:actor' as const,
        decision: { ...decision, opId: { epoch: 'epoch', time: 2, nonce: 'continuation' } },
        anchorDecision: decision,
      },
    };
    await handle.commit(accepted);
    const budget = () => ({ ...scanBudget(), bytes: 1024 });
    const head = await handle.scan({ range: { journalHead: 'position' }, budget: budget() });
    assert.deepEqual(head.items, [{ pos: next.pos }]);
    assert.equal(head.cost?.bytes, Buffer.byteLength(JSON.stringify(head.items[0])));
    assert.deepEqual(
      (await handle.scan({ range: { journalHead: 'intake' }, budget: budget() })).items,
      [{ pos: first.pos, intake }],
    );
    assert.deepEqual(
      (
        await handle.scan({
          range: { decisionMetadata: { caller: 'u:actor', opId } },
          budget: budget(),
        })
      ).items,
      [
        {
          pos: next.pos,
          caller: 'u:actor',
          decision: accepted.record.decision,
          anchorDecision: decision,
        },
      ],
    );
    await assert.rejects(
      handle.scan({ range: { journal: '/' }, budget: budget() }),
      (error: unknown) => error instanceof KernelError && error.code === 'BUDGET',
    );
    const largeOutcome = storeCommit(3, [], [], owner.resources.writerEpoch);
    await handle.commit({
      ...largeOutcome,
      record: {
        ...largeOutcome.record,
        caller: 'u:actor',
        decision: { ...decision, outcome: { value: 'y'.repeat(2048) } },
      },
    });
    await assert.rejects(
      handle.scan({ range: { decisionMetadata: { caller: 'u:actor', opId } }, budget: budget() }),
      (error: unknown) => error instanceof KernelError && error.code === 'BUDGET',
    );
  } finally {
    await handle.close();
    await owner.close();
  }
  const reopened = await openMongoTransactionOwner(options);
  try {
    assert.equal(reopened.resources.decisionHistory, 'retained');
  } finally {
    await reopened.close();
  }
});
