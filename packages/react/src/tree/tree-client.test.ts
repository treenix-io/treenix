import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import type { NodeData } from '@treenx/core';
import { KernelError } from '@treenx/core/errors';

type StreamCallbacks = {
  onData(value: unknown): void;
  onError(error: unknown): void;
  onComplete(): void;
};

const get = mock.fn(async ({ path }: { path: string }): Promise<NodeData | undefined> => ({ $path: path, $type: 'doc' }));
const patch = mock.fn(async (_input: unknown) => {});
const put = mock.fn(async (_input: unknown) => {});
const remove = mock.fn(async (_input: unknown) => true);
const execute = mock.fn(async (_input: unknown): Promise<unknown> => 'result');
const unwatch = mock.fn(async (_input: unknown) => {});
const unsubscribe = mock.fn(() => {});
let streamCallbacks: StreamCallbacks;
const subscribe = mock.fn((_input: unknown, callbacks: StreamCallbacks) => {
  streamCallbacks = callbacks;
  return { unsubscribe };
});

mock.module('#tree/trpc', {
  namedExports: {
    trpc: {
      get: { query: get },
      getChildren: { query: async () => ({ items: [], total: 0 }) },
      getPerm: { query: async () => 7 },
      patch: { mutate: patch }, set: { mutate: put }, remove: { mutate: remove },
      execute: { mutate: execute }, streamAction: { subscribe },
      unwatch: { mutate: unwatch }, unwatchChildren: { mutate: async () => {} },
    },
    getToken: () => null, setToken: () => {}, clearToken: () => {},
    AUTH_EXPIRED_EVENT: 'trpc:auth-expired', tabTokenInput: { token: 'test-tab' },
  },
});

const { treeClient } = await import('#tree/tree-client');
const { clientIterator } = await import('#tree/client-stream');
const { patchNode, watch } = await import('#hooks');
const cache = await import('#tree/cache');
const { resetHolds } = await import('#tree/holds');
const { cancelReadReconverges } = await import('#tree/read-track');

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

beforeEach(() => {
  for (const fn of [get, patch, put, remove, execute, unwatch, unsubscribe, subscribe]) {
    fn.mock.restore();
    fn.mock.resetCalls();
  }
  cache.clear();
  resetHolds();
});
afterEach(() => cancelReadReconverges());

describe('TreeClient transport contract', () => {
  it('reads a fresh remote image and forwards action identity and component', async () => {
    cache.put({ $path: '/doc', $type: 'doc', title: 'old' });
    get.mock.mockImplementationOnce(async () => ({ $path: '/doc', $type: 'doc', title: 'new' }));
    assert.equal((await treeClient.read({ kind: 'node', path: '/doc' }))?.title, 'new');
    assert.equal(await treeClient.read({ kind: 'permission', path: '/doc' }), 7);
    assert.equal(await treeClient.act({ path: '/doc', component: 'editor', action: 'save', args: { title: 'x' }, opId: 'operation' }), 'result');
    assert.deepEqual(execute.mock.calls[0].arguments[0], {
      path: '/doc', key: 'editor', action: 'save', data: { title: 'x' }, opId: 'operation',
    });
  });

  it('rejects a mixed batch before any member can take effect', async () => {
    await assert.rejects(() => treeClient.commit([
      { kind: 'put', node: { $path: '/doc', $type: 'doc' } },
      { kind: 'remove', path: '/old' },
    ]), error => error instanceof KernelError && error.code === 'INVALID');
    assert.equal(put.mock.callCount() + patch.mock.callCount() + remove.mock.callCount(), 0);
  });

  it('propagates the original rejected write', async () => {
    const failure = new KernelError('FORBIDDEN', 'Write denied');
    patch.mock.mockImplementationOnce(async () => { throw failure; });
    await assert.rejects(() => treeClient.commit([{ kind: 'patch', path: '/doc', ops: [['r', 'title', 'x']] }]), error => error === failure);
  });

  it('a partial edit refreshes its accepted image without requiring a subscription', async () => {
    cache.put({ $path: '/doc', $type: 'doc', title: 'old', neighbor: 7 });
    get.mock.mockImplementationOnce(async () => ({ $path: '/doc', $type: 'doc', title: 'new', neighbor: 9 }));
    await patchNode('/doc', { title: 'new' });
    assert.deepEqual(cache.get('/doc'), { $path: '/doc', $type: 'doc', title: 'new', neighbor: 9 });
    assert.deepEqual(patch.mock.calls[0].arguments[0], { path: '/doc', ops: [['r', 'title', 'new']] });
  });

  it('a rejected partial edit preserves a newer server image and never resurrects a removed node', async () => {
    const failure = new KernelError('FORBIDDEN', 'Write denied');
    cache.put({ $path: '/doc', $type: 'doc', title: 'old' });
    const newer = { $path: '/doc', $type: 'doc', title: 'foreign', $rev: 3 };
    patch.mock.mockImplementationOnce(async () => { cache.put(newer); throw failure; });
    await assert.rejects(() => patchNode('/doc', { title: 'edit' }), error => error === failure);
    assert.deepEqual(cache.get('/doc'), newer);
    patch.mock.mockImplementationOnce(async () => { cache.remove('/doc'); throw failure; });
    await assert.rejects(() => patchNode('/doc', { title: 'edit' }), error => error === failure);
    assert.equal(cache.get('/doc'), undefined);
    assert.equal(get.mock.callCount(), 0);
  });

  it('cancels a stream once and discards late chunks', () => {
    const chunks: number[] = [];
    const complete = mock.fn(() => {});
    const id = treeClient.sub<number>({ kind: 'action', action: { path: '/sensor', action: 'scan' }, observer: {
      next: value => chunks.push(value), error: assert.fail, complete,
    } });
    streamCallbacks.onData(1);
    treeClient.cancel(id);
    treeClient.cancel(id);
    streamCallbacks.onData(2);
    streamCallbacks.onComplete();
    assert.deepEqual(chunks, [1]);
    assert.equal(unsubscribe.mock.callCount(), 1);
    assert.equal(complete.mock.callCount(), 1);
  });

  it('a synchronous stream completion leaves no cancellable subscription', () => {
    const complete = mock.fn(() => {});
    subscribe.mock.mockImplementationOnce((_input, callbacks) => {
      callbacks.onComplete();
      return { unsubscribe };
    });
    const id = treeClient.sub({ kind: 'action', action: { path: '/sensor', action: 'scan' }, observer: {
      next: assert.fail, error: assert.fail, complete,
    } });
    treeClient.cancel(id);
    assert.equal(complete.mock.callCount(), 1);
    assert.equal(unsubscribe.mock.callCount(), 0);
  });

  it('cancellation during registration releases the hold after the response and publishes no image', async () => {
    const started = deferred<void>();
    const reply = deferred<NodeData>();
    const released = deferred<void>();
    get.mock.mockImplementationOnce(() => { started.resolve(); return reply.promise; });
    unwatch.mock.mockImplementationOnce(async () => { released.resolve(); });
    const next = mock.fn((_node: NodeData | undefined) => {});
    const id = treeClient.sub({ kind: 'path', path: '/pending', observer: { next, error: assert.fail } });
    await started.promise;
    treeClient.cancel(id);
    assert.equal(unwatch.mock.callCount(), 0);
    reply.resolve({ $path: '/pending', $type: 'doc' });
    await released.promise;
    assert.equal(next.mock.callCount(), 0);
    assert.equal(cache.get('/pending'), undefined);
    assert.deepEqual(unwatch.mock.calls[0].arguments[0], { paths: ['/pending'], token: 'test-tab' });
  });

  it('watch retains updates received between iterator requests', async () => {
    const iterator = watch<number>('/doc#value');
    get.mock.mockImplementationOnce(async () => ({ $path: '/doc', $type: 'doc', value: 1 }));
    assert.deepEqual(await iterator.next(), { value: 1, done: false });
    cache.put({ $path: '/doc', $type: 'doc', value: 2 });
    assert.deepEqual(await iterator.next(), { value: 2, done: false });
    await iterator.return();
  });

  it('return resolves a waiting watch request and releases its hold', async () => {
    const iterator = watch('/doc');
    await iterator.next();
    const waiting = iterator.next();
    await iterator.return();
    assert.deepEqual(await waiting, { value: undefined, done: true });
    assert.equal(unwatch.mock.callCount(), 1);
  });

  it('cancellation resolves every concurrent iterator request', { timeout: 1500 }, async () => {
    const iterator = watch('/doc');
    await iterator.next();
    const first = iterator.next();
    const second = iterator.next();
    await iterator.return();
    assert.deepEqual(await Promise.all([first, second]), [
      { value: undefined, done: true }, { value: undefined, done: true },
    ]);
    assert.equal(unwatch.mock.callCount(), 1);
  });

  it('a synchronous registration failure closes the iterator', { timeout: 1500 }, async () => {
    const failure = new KernelError('INVALID', 'Invalid subscription');
    const iterator = clientIterator<number>(() => { throw failure; });
    await assert.rejects(() => iterator.next(), error => error === failure);
    assert.deepEqual(await iterator.next(), { value: undefined, done: true });
  });

  it('a stream failure propagates its original reason and settles later requests', { timeout: 1500 }, async () => {
    const iterator = clientIterator<number>(observer => treeClient.sub({
      kind: 'action', action: { path: '/sensor', action: 'scan' }, observer,
    }));
    const waiting = iterator.next();
    streamCallbacks.onError(0);
    await assert.rejects(waiting, error => error === 0);
    assert.deepEqual(await iterator.next(), { value: undefined, done: true });
  });
});
