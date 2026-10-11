import assert from 'node:assert/strict';
import { it } from 'node:test';
import { KernelError } from '#errors';
import { createBlobArchives } from '#kernel/blob-archives';
import type { Budget, Position } from '#kernel/types';

const generation: Position = { instance: 'archive', epoch: 1, seq: 1 };
const budget = (): Budget => ({ nodes: 100, bytes: 100_000, exprWork: 10_000, deadline: Date.now() + 1000 });
const unavailable = (error: unknown) => error instanceof KernelError && error.code === 'UNAVAILABLE';

it('retains retired live references while expiring only proven historical references', () => {
  const archive = createBlobArchives();
  const owner = 'physical-collection';
  archive.stage({ t: 'page', owner, generation, page: 0, clock: 50, boundary: 20, rows: [
    { t: 'live', key: 'node', ids: ['live'] },
    { t: 'history', address: { pos: generation, id: 'history' }, acceptedAt: 10, retainUntil: 110, ids: ['expired-floor'] },
    { t: 'history', address: { pos: generation, id: 'later' }, acceptedAt: 30, retainUntil: 130, ids: ['expired-clock'] },
    { t: 'history', address: { pos: generation, id: 'legacy' }, ids: ['unknown'] },
  ] }, budget())();
  assert.throws(() => archive.get(['live'], 200, budget()), unavailable);
  archive.stage({ t: 'seal', owner, generation, pages: 1 }, budget())();
  const reopened = createBlobArchives({ units: archive.census(), budget });
  assert.deepEqual(reopened.get(['expired-floor'], 50, budget()).items,
    [{ id: 'expired-floor', live: 0, history: 1, releasedAt: 0 }]);
  assert.deepEqual(reopened.get(['live', 'expired-floor', 'expired-clock', 'unknown'], 200, budget()).items, [
    { id: 'live', live: 1, history: 0, releasedAt: 0 },
    { id: 'expired-floor', live: 0, history: 0, releasedAt: 110 },
    { id: 'expired-clock', live: 0, history: 0, releasedAt: 130 },
    { id: 'unknown', live: 0, history: 1, releasedAt: 0 },
  ]);
});

it('preserves incomplete reactivation through restart without dropping the collection barrier', () => {
  const archive = createBlobArchives();
  const owner = 'physical-owner';
  archive.stage({ t: 'page', owner, generation, page: 0, clock: 50,
    rows: [{ t: 'live', key: 'node', ids: ['blob'] }] }, budget())();
  archive.stage({ t: 'seal', owner, generation, pages: 1 }, budget())();
  archive.stage({ t: 'removePage', owner, generation, page: 0 }, budget())();
  const reopened = createBlobArchives({ units: archive.census(), budget });
  assert.throws(() => reopened.get(['blob'], 200, budget()), unavailable);
  reopened.stage({ t: 'remove', owner, generation }, budget())();
  assert.deepEqual(reopened.get(['blob'], 200, budget()).items,
    [{ id: 'blob', live: 0, history: 0, releasedAt: 0 }]);
});

it('stages sequential archive mutations atomically and rejects the whole invalid batch', () => {
  const archive = createBlobArchives();
  const owner = 'batch-owner';
  const begin = { t: 'begin' as const, owner, generation };
  const page = { t: 'page' as const, owner, generation, page: 0, clock: 50,
    rows: [{ t: 'live' as const, key: 'node', ids: ['blob'] }] };
  assert.throws(() => archive.stageBatch([begin, page,
    { t: 'seal', owner, generation, pages: 2 }], budget()),
  error => error instanceof KernelError && error.code === 'CONFLICT');
  assert.deepEqual([...archive.census()], []);
  const publish = archive.stageBatch([begin, page,
    { t: 'seal', owner, generation, pages: 1 }], budget());
  assert.deepEqual([...archive.census()], []);
  publish();
  assert.deepEqual(archive.get(['blob'], 100, budget()).items,
    [{ id: 'blob', live: 1, history: 0, releasedAt: 0 }]);
  const refused = archive.stageBatch([
    { t: 'removePage', owner, generation, page: 0 },
    { t: 'remove', owner, generation },
  ], budget());
  assert.equal(archive.get(['blob'], 100, budget()).items[0]!.live, 1);
  refused();
  assert.deepEqual([...archive.census()], []);
});

it('bounds many identities in one archive row before publication and removal', () => {
  const archive = createBlobArchives();
  const page = { t: 'page' as const, owner: 'work-owner', generation, page: 0, clock: 50,
    rows: [{ t: 'live' as const, key: 'node', ids: Array.from({ length: 100 }, (_, index) => `blob-${index}`) }] };
  const limited = { ...budget(), exprWork: 2 };
  assert.throws(() => archive.stage(page, limited),
    error => error instanceof KernelError && error.code === 'BUDGET');
  assert.deepEqual([...archive.census()], []);
  const batch = createBlobArchives();
  assert.throws(() => batch.stageBatch([
    { t: 'begin', owner: page.owner, generation }, page,
    { t: 'seal', owner: page.owner, generation, pages: 1 },
  ], { ...budget(), exprWork: 250 }),
  error => error instanceof KernelError && error.code === 'BUDGET');
  assert.deepEqual([...batch.census()], []);
  archive.stage(page, { ...budget(), exprWork: 1000 })();
  assert.throws(() => archive.stage({ t: 'retirePage', owner: page.owner, generation, page: 0, at: 100 }, limited),
    error => error instanceof KernelError && error.code === 'BUDGET');
  archive.stage({ t: 'seal', owner: page.owner, generation, pages: 1 }, budget())();
  assert.throws(() => archive.stage({ t: 'removePage', owner: page.owner, generation, page: 0 }, limited),
    error => error instanceof KernelError && error.code === 'BUDGET');
  assert.equal(archive.get(['blob-0'], 100, budget()).items[0].live, 1);
});
