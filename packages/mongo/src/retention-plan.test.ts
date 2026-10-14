import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { computeFieldDeltas, readJournalImages } from '@treenx/core/kernel/journal';
import type { JournalCommit, JournalEntry, Position, StoredNode } from '@treenx/core/kernel/types';
import { anchorSuccessor, decisionRetained, retentionAge } from '#retention-plan';

const pos = (seq: number): Position => ({ instance: 'retention', epoch: 1, seq });
const image = (seq: number, value: number): StoredNode => ({
  $path: '/node',
  $id: 'node',
  $type: 'item',
  $pos: pos(seq),
  value,
});
const record = (seq: number, entry: JournalEntry): JournalCommit => ({
  pos: pos(seq),
  kind: 'commit',
  executor: 'user',
  caller: 'user',
  entries: [entry],
});

describe('bounded journal anchor planning', () => {
  it('preserves both successor images after the previous full image retires', () => {
    const previous: JournalEntry = {
      id: 'node',
      path: '/node',
      change: { t: 'create', after: image(1, 1) },
    };
    const next: JournalEntry = {
      id: 'node',
      path: '/node',
      change: {
        t: 'update',
        delta: computeFieldDeltas(image(1, 1), image(2, 2)),
      },
    };
    const expected = readJournalImages([record(1, previous), record(2, next)], {
      id: 'node',
      pos: pos(2),
    });
    const promoted = anchorSuccessor(previous, next, pos(1), pos(2));

    assert.deepEqual(
      readJournalImages([record(2, promoted)], { id: 'node', pos: pos(2) }),
      expected,
    );
    assert.equal(next.change.t, 'update');
    assert.equal(next.change.after, undefined);
  });

  it('preserves a known reconciliation before when its predecessor retires', () => {
    const previous: JournalEntry = {
      id: 'node',
      path: '/node',
      change: { t: 'create', after: image(1, 1) },
    };
    const next: JournalEntry = {
      id: 'node',
      path: '/node',
      change: { t: 'reconcile', after: image(2, 9) },
    };
    const promoted = anchorSuccessor(previous, next, pos(1), pos(2));

    assert.deepEqual(readJournalImages([record(2, promoted)], { id: 'node', pos: pos(2) }), {
      before: image(1, 1),
      after: image(2, 9),
    });
  });

  it('protects direct and anchor decision aliases at and beyond the durable floor', () => {
    assert.equal(decisionRetained(true, undefined, 100), true);
    assert.equal(decisionRetained(true, 100, 100), true);
    assert.equal(decisionRetained(true, 101, 100), true);
    assert.equal(decisionRetained(true, 99, 100), false);
    assert.equal(decisionRetained(false, undefined, 100), false);
  });

  it('keeps the durable acceptance clock through wall clock rollback', () => {
    assert.deepEqual(retentionAge(10, 100, 50), { acceptedAt: 100, retainUntil: 150 });
    assert.deepEqual(retentionAge(undefined, 100, 50), { acceptedAt: 100, retainUntil: 150 });
  });
});
