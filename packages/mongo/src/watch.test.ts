// Mongo watch — unit tests against the pure mapper + mongoWatch driven by a
// mocked Collection. Real-mongod integration tests live outside the package;
// here we pin:
//   - operationType → TreeEvent mapping
//   - missing pre-image / missing fullDocument behavior
//   - scope filtering through the mongoWatch loop
//   - change stream close on iterator return / abort

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ChangeStreamDocument, Collection } from 'mongodb';
import type { TreeEvent } from '@treenx/core/tree';
import { mongoChangeToTreeEvent, mongoWatch } from './index';

// ── Pure mapper: change-stream document → TreeEvent ──

describe('mongoChangeToTreeEvent', () => {
  it('insert with _path → set event', () => {
    const change = {
      operationType: 'insert',
      fullDocument: { _path: '/a', _type: 'page', n: 1 },
    } as unknown as ChangeStreamDocument;
    const evt = mongoChangeToTreeEvent(change);
    assert.ok(evt && typeof evt !== 'string' && evt.type === 'set');
    if (typeof evt !== 'string' && evt && evt.type === 'set') {
      assert.equal(evt.path, '/a');
      assert.equal((evt.node as { $type: string }).$type, 'page');
      assert.equal((evt.node as { n: number }).n, 1);
      assert.equal('$path' in evt.node, false, 'node body has no $path');
    }
  });

  it('replace with _path → set event (full doc)', () => {
    const change = {
      operationType: 'replace',
      fullDocument: { _path: '/x', _type: 't', updated: true },
    } as unknown as ChangeStreamDocument;
    const evt = mongoChangeToTreeEvent(change);
    assert.ok(evt && typeof evt !== 'string' && evt.type === 'set');
    if (typeof evt !== 'string' && evt && evt.type === 'set') assert.equal(evt.path, '/x');
  });

  it('update with updateLookup-supplied fullDocument → set event', () => {
    const change = {
      operationType: 'update',
      fullDocument: { _path: '/x', _type: 't', count: 7 },
      updateDescription: { updatedFields: { count: 7 }, removedFields: [], truncatedArrays: [] },
    } as unknown as ChangeStreamDocument;
    const evt = mongoChangeToTreeEvent(change);
    assert.ok(evt && typeof evt !== 'string' && evt.type === 'set');
  });

  it('update without fullDocument (race: doc deleted before lookup) → skip', () => {
    const change = {
      operationType: 'update',
      fullDocument: null,
      updateDescription: { updatedFields: {}, removedFields: [], truncatedArrays: [] },
    } as unknown as ChangeStreamDocument;
    assert.equal(mongoChangeToTreeEvent(change), null);
  });

  it('insert without _path (foreign doc) → skip', () => {
    const change = {
      operationType: 'insert',
      fullDocument: { someField: 'no-path-key' },
    } as unknown as ChangeStreamDocument;
    assert.equal(mongoChangeToTreeEvent(change), null);
  });

  it('delete with fullDocumentBeforeChange → remove event', () => {
    const change = {
      operationType: 'delete',
      fullDocumentBeforeChange: { _path: '/gone', _type: 't' },
    } as unknown as ChangeStreamDocument;
    const evt = mongoChangeToTreeEvent(change);
    assert.ok(evt && typeof evt !== 'string' && evt.type === 'remove');
    if (typeof evt !== 'string' && evt && evt.type === 'remove') assert.equal(evt.path, '/gone');
  });

  it('delete without pre-image → invalidate (caller must refetch)', () => {
    const change = {
      operationType: 'delete',
    } as unknown as ChangeStreamDocument;
    assert.equal(mongoChangeToTreeEvent(change), 'invalidate');
  });

  it('invalidate operationType → invalidate', () => {
    const change = { operationType: 'invalidate' } as unknown as ChangeStreamDocument;
    assert.equal(mongoChangeToTreeEvent(change), 'invalidate');
  });

  it('drop / dropDatabase / rename → invalidate', () => {
    for (const op of ['drop', 'dropDatabase', 'rename'] as const) {
      const change = { operationType: op } as unknown as ChangeStreamDocument;
      assert.equal(mongoChangeToTreeEvent(change), 'invalidate', `${op} should invalidate`);
    }
  });

  it('unknown operationType → skip (null)', () => {
    const change = { operationType: 'unknownOp' as unknown } as unknown as ChangeStreamDocument;
    assert.equal(mongoChangeToTreeEvent(change), null);
  });
});

// ── mongoWatch — wiring with a mocked Collection.watch() ──

interface MockStream {
  push(c: ChangeStreamDocument): void;
  fail(err: Error): void;
  closed: () => boolean;
  iterable: AsyncIterable<ChangeStreamDocument>;
  close(): Promise<void>;
}

function makeMockStream(): MockStream {
  let waiter: ((v: IteratorResult<ChangeStreamDocument>) => void) | null = null;
  let rejecter: ((err: Error) => void) | null = null;
  const queue: ChangeStreamDocument[] = [];
  let closed = false;

  function settle(result: IteratorResult<ChangeStreamDocument>) {
    if (!waiter) return;
    const w = waiter; waiter = null; rejecter = null;
    w(result);
  }

  return {
    closed: () => closed,
    push(c) {
      if (closed) return;
      if (waiter) settle({ value: c, done: false });
      else queue.push(c);
    },
    fail(err) {
      if (closed) return;
      const r = rejecter; waiter = null; rejecter = null;
      if (r) r(err);
    },
    iterable: {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            if (queue.length) return { value: queue.shift()!, done: false };
            if (closed) return { value: undefined, done: true };
            return new Promise<IteratorResult<ChangeStreamDocument>>((res, rej) => {
              waiter = res;
              rejecter = rej;
            });
          },
          async return() {
            closed = true;
            settle({ value: undefined, done: true });
            return { value: undefined, done: true };
          },
        };
      },
    },
    async close() {
      closed = true;
      settle({ value: undefined, done: true });
    },
  };
}

function mockCollection(stream: MockStream): Collection {
  const watch = () => ({
    [Symbol.asyncIterator]: stream.iterable[Symbol.asyncIterator].bind(stream.iterable),
    close: stream.close,
  });
  return { watch } as unknown as Collection;
}

describe('mongoWatch — event flow', () => {
  it('insert change → set event yielded', async () => {
    const stream = makeMockStream();
    const col = mockCollection(stream);
    const iter = mongoWatch(col, { kind: 'all' });
    const it = iter[Symbol.asyncIterator]();
    const pump = it.next();
    await new Promise(r => setImmediate(r));

    stream.push({
      operationType: 'insert',
      fullDocument: { _path: '/foo', _type: 't', v: 1 },
    } as unknown as ChangeStreamDocument);

    const { value } = await pump;
    await it.return!();

    assert.ok(value && value.type === 'set');
    if (value.type === 'set') {
      assert.equal(value.path, '/foo');
      assert.equal((value.node as { v: number }).v, 1);
    }
  });

  it('delete without preimage → reconnect{preserved:false}, stream closes', async () => {
    const stream = makeMockStream();
    const col = mockCollection(stream);
    const iter = mongoWatch(col, { kind: 'all' });
    const it = iter[Symbol.asyncIterator]();
    const pump = it.next();
    await new Promise(r => setImmediate(r));

    // No fullDocumentBeforeChange → mapper returns 'invalidate' → reconnect emitted
    stream.push({ operationType: 'delete' } as unknown as ChangeStreamDocument);

    const { value } = await pump;
    assert.ok(value && value.type === 'reconnect');
    if (value.type === 'reconnect') assert.equal(value.preserved, false);

    // After invalidate the watch loop returns — no more events delivered
    const closed = await it.next();
    assert.equal(closed.done, true);
  });

  it('invalidate operationType → reconnect + close', async () => {
    const stream = makeMockStream();
    const col = mockCollection(stream);
    const iter = mongoWatch(col, { kind: 'all' });
    const it = iter[Symbol.asyncIterator]();
    const pump = it.next();
    await new Promise(r => setImmediate(r));

    stream.push({ operationType: 'invalidate' } as unknown as ChangeStreamDocument);

    const { value } = await pump;
    assert.ok(value && value.type === 'reconnect');
  });

  it('scope filter: path matches only exact path', async () => {
    const stream = makeMockStream();
    const col = mockCollection(stream);
    const iter = mongoWatch(col, { kind: 'path', path: '/want' });
    const it = iter[Symbol.asyncIterator]();
    const pump = it.next();
    await new Promise(r => setImmediate(r));

    // Skipped — wrong path
    stream.push({
      operationType: 'insert',
      fullDocument: { _path: '/other', _type: 't' },
    } as unknown as ChangeStreamDocument);
    // Yields — exact match
    stream.push({
      operationType: 'insert',
      fullDocument: { _path: '/want', _type: 't' },
    } as unknown as ChangeStreamDocument);

    const { value } = await pump;
    await it.return!();

    assert.ok(value && value.type === 'set');
    if (value.type === 'set') assert.equal(value.path, '/want');
  });

  it('scope filter: children yields direct children only', async () => {
    const stream = makeMockStream();
    const col = mockCollection(stream);
    const iter = mongoWatch(col, { kind: 'children', path: '/parent' });
    const it = iter[Symbol.asyncIterator]();
    const pump = it.next();
    await new Promise(r => setImmediate(r));

    // parent itself — skipped
    stream.push({
      operationType: 'insert',
      fullDocument: { _path: '/parent', _type: 't' },
    } as unknown as ChangeStreamDocument);
    // grandchild — skipped
    stream.push({
      operationType: 'insert',
      fullDocument: { _path: '/parent/a/inner', _type: 't' },
    } as unknown as ChangeStreamDocument);
    // direct child — yields
    stream.push({
      operationType: 'insert',
      fullDocument: { _path: '/parent/direct', _type: 't' },
    } as unknown as ChangeStreamDocument);

    const { value } = await pump;
    await it.return!();

    assert.ok(value && value.type === 'set');
    if (value.type === 'set') assert.equal(value.path, '/parent/direct');
  });

  it('iterator return() closes the change stream', async () => {
    const stream = makeMockStream();
    const col = mockCollection(stream);
    const iter = mongoWatch(col, { kind: 'all' });
    const it = iter[Symbol.asyncIterator]();
    const pump = it.next();
    await new Promise(r => setImmediate(r));

    await it.return!();
    // Give the close .catch a microtask
    await new Promise(r => setImmediate(r));

    assert.equal(stream.closed(), true, 'mongoWatch closes the underlying change stream');

    // Pending pump resolves done
    const result = await pump;
    assert.equal(result.done, true);
  });

  it('foreign (non-Treenix) docs are skipped without breaking the stream', async () => {
    const stream = makeMockStream();
    const col = mockCollection(stream);
    const iter = mongoWatch(col, { kind: 'all' });
    const it = iter[Symbol.asyncIterator]();
    const pump = it.next();
    await new Promise(r => setImmediate(r));

    // Non-Treenix doc (no _path) — must be skipped silently
    stream.push({
      operationType: 'insert',
      fullDocument: { foreign: true },
    } as unknown as ChangeStreamDocument);
    // Treenix doc — must yield
    stream.push({
      operationType: 'insert',
      fullDocument: { _path: '/treenix', _type: 't' },
    } as unknown as ChangeStreamDocument);

    const { value } = await pump;
    await it.return!();

    assert.ok(value && value.type === 'set');
    if (value.type === 'set') assert.equal(value.path, '/treenix');
  });
});

