import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { OpId, StoreCommit } from '#kernel/types';
import { scanBudget } from './contract';
import { createMemoryStore } from './memory';

const caller = 'u:retention';
const key = (nonce: string, time = 1): OpId => ({ epoch: 'retention', time, nonce });
const position = (seq: number) => ({ instance: 'retention', epoch: 1, seq });

/** Keep direct and continued decisions in the same actual journal commit. */
function decision(seq: number, opId: OpId, value?: unknown, anchor?: OpId): StoreCommit {
  const pos = position(seq);
  const execution =
    value === undefined || anchor !== undefined
      ? { stream: { executor: caller, target: 'form' } as const }
      : {};
  const outcome = value === undefined ? {} : { outcome: { pos, value } };
  return {
    pos,
    writerEpoch: 1,
    acceptedAt: seq,
    journalRetentionMs: 1,
    writes: [],
    record: {
      pos,
      kind: 'kernel',
      caller,
      executor: caller,
      entries: [],
      decision: { opId, requestHash: opId.nonce, ...execution, ...outcome },
      ...(anchor === undefined
        ? {}
        : {
            anchorDecision: { opId: anchor, requestHash: anchor.nonce, ...execution, ...outcome },
          }),
    },
  };
}

/** Bound each retirement batch independently of the number of historical decisions. */
function maintenance(seq: number, changeSet = 100): StoreCommit {
  const pos = position(seq);
  return {
    pos,
    writerEpoch: 1,
    acceptedAt: 1000,
    writes: [],
    maintenanceLimits: { budget: scanBudget(), changeSet },
    record: {
      pos,
      kind: 'kernel',
      caller: 'kernel',
      executor: 'kernel',
      entries: [],
      maintenance: { journalBefore: 100, decisionBefore: 50 },
    },
  };
}

it('retires expired direct and anchor outcomes atomically with their canonical journal', async (t) => {
  const store = createMemoryStore({ domain: 'retention' });
  t.after(() => store.close());
  const original = key('original'),
    continued = key('continued', 2);
  await store.commit(decision(1, continued, 'x'.repeat(128 * 1024), original));
  const publish = store.stageCommit(maintenance(2));
  for (const opId of [original, continued]) {
    const before = await store.scan({
      range: { decision: { caller, opId } },
      budget: scanBudget(),
    });
    assert.equal(before.items.length, 1);
  }
  publish();

  assert.equal(store.maintenancePending, false);
  const journal = await store.scan({ range: { journal: '/' }, budget: scanBudget() });
  assert.equal(
    journal.items.some((record) => record.pos.seq === 1),
    false,
  );
  for (const opId of [original, continued]) {
    assert.deepEqual(
      (await store.scan({ range: { decision: { caller, opId } }, budget: scanBudget() })).items,
      [],
    );
    assert.deepEqual(
      (await store.scan({ range: { decisionMetadata: { caller, opId } }, budget: scanBudget() }))
        .items,
      [],
    );
  }
});

it('keeps newer anchor outcomes and decisions at the expiry boundary or within journal retention', async (t) => {
  const store = createMemoryStore({ domain: 'retention' });
  t.after(() => store.close());
  const original = key('original'),
    continued = key('continued', 50),
    retained = key('retained');
  await store.commit(decision(1, original));
  await store.commit(decision(2, continued, 'completed', original));
  await store.commit({ ...decision(3, retained, 'retained'), journalRetentionMs: 2000 });
  await store.commit(maintenance(4));

  const journal = await store.scan({ range: { journal: '/' }, budget: scanBudget() });
  assert.equal(
    journal.items.some((record) => record.pos.seq === 1),
    false,
  );
  for (const opId of [original, continued]) {
    const result = await store.scan({
      range: { decision: { caller, opId } },
      budget: scanBudget(),
    });
    assert.equal(result.items.length, 1);
    assert.deepEqual(result.items[0].pos, position(2));
    assert.equal(result.items[0].decision?.outcome?.value, 'completed');
  }
  assert.equal(
    (await store.scan({ range: { decision: { caller, opId: retained } }, budget: scanBudget() }))
      .items[0].decision?.outcome?.value,
    'retained',
  );
});

it('retires decision indexes across bounded maintenance batches', async (t) => {
  const store = createMemoryStore({ domain: 'retention' });
  t.after(() => store.close());
  const keys = Array.from({ length: 4 }, (_, i) => key(String(i)));
  for (const [index, opId] of keys.entries()) await store.commit(decision(index + 1, opId, index));
  await store.commit(maintenance(5, 2));
  assert.equal(store.maintenancePending, true);

  let seq = 6;
  while (store.maintenancePending) {
    assert.ok(seq < 20);
    await store.commit(maintenance(seq++, 2));
  }
  for (const opId of keys)
    assert.deepEqual(
      (await store.scan({ range: { decision: { caller, opId } }, budget: scanBudget() })).items,
      [],
    );
});
