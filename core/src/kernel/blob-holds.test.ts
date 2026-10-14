import assert from 'node:assert/strict';
import { it } from 'node:test';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { openPersistentWriter } from '#kernel/persistence';
import { createFsStore } from '#kernel/store/fs';
import { KernelError } from '#errors';
import { createBlobHolds } from '#kernel/blob-holds';
import { createMemoryStore } from '#kernel/store/memory';
import { blobReferences, journalBlobIds } from '#kernel/blob-references';
import type { Budget, JournalCommit, StoreCommit, StoredNode } from '#kernel/types';

const budget = (): Budget => ({
  nodes: 100,
  bytes: 100_000,
  exprWork: 10_000,
  deadline: Date.now() + 1000,
});
const ref = { $blob: 'first', size: 3, type: 'application/octet-stream' };
const other = { ...ref, $blob: 'second' };

/** Produces canonical accepted fixture images with one repeated binary identity. */
function node(seq: number): StoredNode {
  return {
    $path: '/file',
    $id: 'file',
    $type: 't.dir',
    $pos: { instance: 'holds', epoch: 1, seq },
    first: ref,
    duplicate: [ref],
  };
}

/** Uses actual journal transitions rather than a substitute history schema. */
function commit(
  seq: number,
  entries: JournalCommit['entries'],
  after: StoredNode | null,
): StoreCommit {
  const pos = { instance: 'holds', epoch: 1, seq };
  return {
    pos,
    acceptedAt: seq * 10,
    writerEpoch: 1,
    writes: [{ path: '/file', node: after }],
    record: { pos, kind: 'commit', caller: 'kernel', executor: 'kernel', entries },
  };
}

it('counts duplicate fields once and retains deletion history after live removal', () => {
  const holds = createBlobHolds();
  const image = node(1);
  const first = commit(
    1,
    [{ id: 'file', path: '/file', change: { t: 'create', after: image } }],
    image,
  );
  holds.stage(first, budget())();
  const second = commit(
    2,
    [{ id: 'file', path: '/file', change: { t: 'delete', before: image } }],
    null,
  );
  const publish = holds.stage(second, budget());
  assert.deepEqual(holds.get(['first']), [{ id: 'first', live: 1, history: 1, releasedAt: 0 }]);
  publish();
  assert.deepEqual(holds.get(['first']), [{ id: 'first', live: 0, history: 2, releasedAt: 0 }]);
  const reopened = createBlobHolds(holds.save());
  const maintenance = { ...commit(3, [], null), writes: [] };
  reopened.stage(maintenance, budget(), [])();
  assert.deepEqual(reopened.get(['first']), [{ id: 'first', live: 0, history: 0, releasedAt: 30 }]);
});

it('retains both delta sides and full checkpoint before references from canonical records', () => {
  const record = commit(
    1,
    [
      {
        id: 'file',
        path: '/file',
        change: {
          t: 'update',
          delta: { first: { from: ref, to: other } },
          after: { ...node(1), first: other },
        },
      },
    ],
    null,
  ).record;
  assert.deepEqual(new Set(journalBlobIds(record, budget())), new Set(['first', 'second']));
});

it('rejects conflicting reference metadata and preserves the previous accepted holds', () => {
  const holds = createBlobHolds();
  assert.throws(
    () => blobReferences([ref, { ...ref, size: 4 }], budget()),
    (error) => error instanceof KernelError && error.code === 'INVALID',
  );
  const malformed = { ...node(1), first: { ...ref, $blob: 3 } };
  assert.throws(
    () => holds.stage(commit(1, [], malformed), budget()),
    (error) => error instanceof KernelError && error.code === 'INVALID',
  );
  assert.deepEqual(holds.get(['first']), [{ id: 'first', live: 0, history: 0, releasedAt: 0 }]);
});

it('publishes Memory Store data, canonical history and blob holds atomically', async () => {
  let refuse = false;
  const store = createMemoryStore({
    domain: 'blob-hold-atomic',
    beforeRecord() {
      if (refuse) throw new KernelError('CONFLICT', 'Fixture rejects publication');
    },
  });
  const image = node(1);
  const first = commit(
    1,
    [{ id: 'file', path: '/file', change: { t: 'create', after: image } }],
    image,
  );
  await store.commit(first);
  refuse = true;
  await assert.rejects(
    store.commit(
      commit(2, [{ id: 'file', path: '/file', change: { t: 'delete', before: image } }], null),
    ),
    (error) => error instanceof KernelError && error.code === 'CONFLICT',
  );
  assert.deepEqual((await store.blobHolds(['first'], budget())).items, [
    { id: 'first', live: 1, history: 1, releasedAt: 0 },
  ]);
  assert.equal((await store.scan({ range: { node: '/file' }, budget: budget() })).items.length, 1);
  assert.equal((await store.scan({ range: { journal: '/' }, budget: budget() })).items.length, 1);
  const reopened = createMemoryStore({
    domain: 'blob-hold-atomic',
    recovered: {
      nodes: [image],
      commits: [first],
      writerEpoch: 1,
      blobHolds: store.blobSnapshot(),
    },
  });
  assert.deepEqual((await reopened.blobHolds(['first'], budget())).items, [
    { id: 'first', live: 1, history: 1, releasedAt: 0 },
  ]);
});

it('persists Fs history holds and the accepted release timestamp through compaction and reopen', async () => {
  const parent = resolve('../../temp/blob-hold-fixtures');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'owned-'));

  /** Reopens only this test's preserved dataset, with external observation disabled. */
  async function open() {
    const lease = await openPersistentWriter({
      directory: join(directory, '.treenix'),
      instance: 'holds',
    });
    const store = await createFsStore({ directory, lease, external: 'none' });
    return {
      lease,
      store,
      async close() {
        await store.close();
        await lease.close();
      },
    };
  }

  const first = await open();
  const image = node(1);
  await first.store.commit({
    ...commit(1, [{ id: 'file', path: '/file', change: { t: 'create', after: image } }], image),
    writerEpoch: first.lease.writerEpoch,
  });
  await first.store.commit({
    ...commit(2, [{ id: 'file', path: '/file', change: { t: 'delete', before: image } }], null),
    writerEpoch: first.lease.writerEpoch,
  });
  await first.close();
  const second = await open();
  try {
    assert.deepEqual((await second.store.blobHolds(['first'], budget())).items, [
      { id: 'first', live: 0, history: 2, releasedAt: 0 },
    ]);
    const maintenance = commit(3, [], null);
    await second.store.commit({
      ...maintenance,
      writes: [],
      writerEpoch: second.lease.writerEpoch,
      record: {
        ...maintenance.record,
        kind: 'kernel',
        maintenance: { journalBefore: 100, decisionBefore: 0 },
      },
    });
    assert.deepEqual((await second.store.blobHolds(['first'], budget())).items, [
      { id: 'first', live: 0, history: 0, releasedAt: 30 },
    ]);
  } finally {
    await second.close();
  }
  const third = await open();
  try {
    assert.deepEqual((await third.store.blobHolds(['first'], budget())).items, [
      { id: 'first', live: 0, history: 0, releasedAt: 30 },
    ]);
  } finally {
    await third.close();
  }
});

it('holds externally detected identities without requiring resolvable or matching blob metadata', () => {
  const holds = createBlobHolds();
  const image = { ...node(1), first: { ...ref, size: 99 }, unknown: { ...other, size: 0 } };
  const accepted = commit(
    1,
    [{ id: 'file', path: '/file', change: { t: 'reconcile', after: image } }],
    image,
  );
  holds.stage({ ...accepted, record: { ...accepted.record, kind: 'reconcile' } }, budget())();
  assert.deepEqual(holds.get(['first', 'second']), [
    { id: 'first', live: 1, history: 1, releasedAt: 0 },
    { id: 'second', live: 1, history: 1, releasedAt: 0 },
  ]);
});

it('counts shared identities per node and per exact retained journal address', async () => {
  const store = createMemoryStore({ domain: 'shared-blob-holds' });
  const left = node(1),
    right = { ...node(1), $path: '/other', $id: 'other' };
  const first = commit(
    1,
    [
      { id: left.$id, path: left.$path, change: { t: 'create', after: left } },
      { id: right.$id, path: right.$path, change: { t: 'create', after: right } },
    ],
    left,
  );
  await store.commit({
    ...first,
    writes: [
      { path: left.$path, node: left },
      { path: right.$path, node: right },
    ],
  });
  assert.deepEqual((await store.blobHolds(['first'], budget())).items, [
    { id: 'first', live: 2, history: 2, releasedAt: 0 },
  ]);
  await store.commit(
    commit(2, [{ id: left.$id, path: left.$path, change: { t: 'delete', before: left } }], null),
  );
  assert.deepEqual((await store.blobHolds(['first'], budget())).items, [
    { id: 'first', live: 1, history: 3, releasedAt: 0 },
  ]);
});

it('keeps reference metadata empty for ordinary writes without binary identities', async () => {
  const store = createMemoryStore({ domain: 'sparse-blob-holds' });
  for (let seq = 1; seq <= 50; seq++) {
    const image = {
      $path: `/ordinary-${seq}`,
      $id: `ordinary-${seq}`,
      $type: 't.dir',
      $pos: { instance: 'holds', epoch: 1, seq },
      value: seq,
    };
    const accepted = commit(
      seq,
      [{ id: image.$id, path: image.$path, change: { t: 'create', after: image } }],
      image,
    );
    await store.commit({ ...accepted, writes: [{ path: image.$path, node: image }] });
  }
  const metadata = store.blobSnapshot();
  assert.deepEqual(metadata.nodes, []);
  assert.deepEqual(metadata.history, []);
  assert.deepEqual(metadata.released, []);
});

it('recovers a long valid no-blob journal without argument overflow or reference ledger growth', () => {
  const commits: StoreCommit[] = [];
  for (let seq = 1; seq <= 130_000; seq++) {
    const accepted = commit(seq, [], null);
    commits.push({ ...accepted, writes: [] });
  }
  const store = createMemoryStore({
    domain: 'long-no-blob-recovery',
    recovered: {
      nodes: [
        {
          $path: '/ordinary',
          $id: 'ordinary',
          $type: 't.dir',
          $pos: { instance: 'holds', epoch: 1, seq: 0 },
          value: 1,
        },
      ],
      commits,
      writerEpoch: 1,
    },
  });
  const metadata = store.blobSnapshot();
  assert.equal(metadata.acceptedAt, 1_300_000);
  assert.deepEqual(metadata.nodes, []);
  assert.deepEqual(metadata.history, []);
});

it('retains unchanged references in sparse deltas after cold recovery and anchor retirement', () => {
  const image = node(1);
  const first = commit(
    1,
    [{ id: 'file', path: '/file', change: { t: 'create', after: image } }],
    image,
  );
  const updated = { ...node(2), title: 'after' };
  const second = commit(
    2,
    [{ id: 'file', path: '/file', change: { t: 'update', delta: { title: { to: 'after' } } } }],
    updated,
  );
  const store = createMemoryStore({
    domain: 'unchanged-blob-recovery',
    recovered: {
      nodes: [updated],
      commits: [first, second],
      writerEpoch: 1,
    },
  });
  const holds = createBlobHolds(store.blobSnapshot());
  assert.deepEqual(holds.get(['first']), [{ id: 'first', live: 1, history: 2, releasedAt: 0 }]);

  const maintenance = { ...commit(3, [], null), writes: [] };
  holds.stage(maintenance, budget(), [second])();
  assert.deepEqual(holds.get(['first']), [{ id: 'first', live: 1, history: 1, releasedAt: 0 }]);
  assert.deepEqual(
    [...holds.census()].find((row) => row.t === 'history'),
    {
      t: 'history',
      address: { pos: second.pos, id: 'file' },
      acceptedAt: 20,
      ids: ['first'],
    },
  );
});

it('preserves declared history expiry when a retained entry is promoted', () => {
  const holds = createBlobHolds();
  const image = node(1);
  const accepted = {
    ...commit(1, [{ id: 'file', path: '/file', change: { t: 'create', after: image } }], image),
    journalRetentionMs: 100,
  };
  holds.stage(accepted, budget())();
  const promoted = {
    ...accepted,
    record: {
      ...accepted.record,
      entries: [
        { id: 'file', path: '/file', change: { t: 'update' as const, delta: {}, after: image } },
      ],
    },
  };
  holds.stage({ ...commit(2, [], null), writes: [] }, budget(), [promoted])();
  assert.deepEqual(
    [...holds.census()].find((row) => row.t === 'history'),
    {
      t: 'history',
      address: { pos: accepted.pos, id: 'file' },
      acceptedAt: 10,
      retainUntil: 110,
      ids: ['first'],
    },
  );
});

it('persists bounded root archive pages through Fs recovery and journal compaction', async () => {
  const parent = resolve('../../temp/blob-archive-fixtures');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'owned-'));
  const generation = { instance: 'archive', epoch: 1, seq: 1 };

  /** Acquires only this fixture's durable physical owner. */
  async function open() {
    const lease = await openPersistentWriter({
      directory: join(directory, '.treenix'),
      instance: 'holds',
    });
    const store = await createFsStore({ directory, lease, external: 'none' });
    return {
      lease,
      store,
      async close() {
        await store.close();
        await lease.close();
      },
    };
  }

  const first = await open();
  try {
    const base = { ...commit(1, [], null), writes: [], writerEpoch: first.lease.writerEpoch };
    const record = { ...base.record, kind: 'kernel' as const };
    await first.store.commit({
      ...base,
      record,
      maintenanceLimits: { budget: budget(), changeSet: 100 },
      blobArchive: [
        {
          t: 'page',
          owner: 'retired-physical-collection',
          generation,
          page: 0,
          clock: 10,
          rows: [{ t: 'live', key: 'physical-node', ids: ['first'] }],
        },
      ],
    });
    const seal = { ...commit(2, [], null), writes: [], writerEpoch: first.lease.writerEpoch };
    await first.store.commit({
      ...seal,
      record: { ...seal.record, kind: 'kernel' },
      maintenanceLimits: { budget: budget(), changeSet: 100 },
      blobArchive: [{ t: 'seal', owner: 'retired-physical-collection', generation, pages: 1 }],
    });
  } finally {
    await first.close();
  }

  const second = await open();
  try {
    assert.deepEqual((await second.store.archivedBlobHolds(['first'], 1000, budget())).items, [
      { id: 'first', live: 1, history: 0, releasedAt: 0 },
    ]);
    const maintenance = {
      ...commit(3, [], null),
      writes: [],
      writerEpoch: second.lease.writerEpoch,
    };
    await second.store.commit({
      ...maintenance,
      record: {
        ...maintenance.record,
        kind: 'kernel',
        maintenance: { journalBefore: 1000, decisionBefore: 0 },
      },
    });
  } finally {
    await second.close();
  }

  const third = await open();
  try {
    assert.deepEqual((await third.store.archivedBlobHolds(['first'], 2000, budget())).items, [
      { id: 'first', live: 1, history: 0, releasedAt: 0 },
    ]);
  } finally {
    await third.close();
  }
});

it('preserves an Fs history horizon when the current retention policy shortens', async () => {
  const parent = resolve('../../temp/blob-hold-fixtures');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'horizon-'));

  /** Gives every cold handle the exact persisted physical owner. */
  async function open() {
    const lease = await openPersistentWriter({
      directory: join(directory, '.treenix'),
      instance: 'holds',
    });
    const store = await createFsStore({ directory, lease, external: 'none' });
    return {
      store,
      lease,
      async close() {
        await store.close();
        await lease.close();
      },
    };
  }

  let owned = await open();
  const image = node(1);
  try {
    await owned.store.commit({
      ...commit(1, [{ id: 'file', path: '/file', change: { t: 'create', after: image } }], image),
      journalRetentionMs: 1000,
      writerEpoch: owned.lease.writerEpoch,
    });
    await owned.store.commit({
      ...commit(2, [{ id: 'file', path: '/file', change: { t: 'delete', before: image } }], null),
      journalRetentionMs: 1000,
      writerEpoch: owned.lease.writerEpoch,
    });
    const shortened = commit(3, [], null);
    await owned.store.commit({
      ...shortened,
      acceptedAt: 50,
      journalRetentionMs: 0,
      writes: [],
      writerEpoch: owned.lease.writerEpoch,
      record: {
        ...shortened.record,
        kind: 'kernel',
        maintenance: { journalBefore: 50, decisionBefore: 0 },
      },
    });
    assert.equal((await owned.store.blobHolds(['first'], budget())).items[0]!.history, 2);
    await owned.close();
    owned = await open();
    assert.equal((await owned.store.blobHolds(['first'], budget())).items[0]!.history, 2);
    const expired = commit(4, [], null);
    await owned.store.commit({
      ...expired,
      acceptedAt: 1100,
      journalRetentionMs: 0,
      writes: [],
      writerEpoch: owned.lease.writerEpoch,
      record: {
        ...expired.record,
        kind: 'kernel',
        maintenance: { journalBefore: 1100, decisionBefore: 0 },
      },
    });
    assert.deepEqual((await owned.store.blobHolds(['first'], budget())).items, [
      { id: 'first', live: 0, history: 0, releasedAt: 1100 },
    ]);
  } finally {
    await owned.close();
  }
});
