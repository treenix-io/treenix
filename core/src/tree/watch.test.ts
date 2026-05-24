// Contract tests for subscriptionToAsyncIterable — the lifecycle helper
// underneath Tree.watch. Pins the non-obvious bits of the spec:
//   - lazy activation
//   - cleanup runs on return/throw/abort
//   - pre-aborted signal short-circuits without registering
//   - overflow emits exactly one reconnect then closes (no silent drops)

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { OpError } from '#errors';
import { subscriptionToAsyncIterable, type TreeEvent } from './watch';

function makeListenerRegistry() {
  const pushes = new Set<(e: TreeEvent) => void>();
  return {
    push(e: TreeEvent) { for (const p of pushes) p(e); },
    register: (push: (e: TreeEvent) => void) => {
      pushes.add(push);
      return () => { pushes.delete(push); };
    },
    listenerCount: () => pushes.size,
  };
}

const overflow: TreeEvent = { type: 'reconnect', preserved: false };

describe('subscriptionToAsyncIterable — lifecycle', () => {
  it('lazy activation: register NOT called until first .next()', async () => {
    const reg = makeListenerRegistry();
    let registered = 0;

    const iter = subscriptionToAsyncIterable<TreeEvent>(
      (push) => { registered++; return reg.register(push); },
      overflow,
    );

    assert.equal(registered, 0, 'no register call on creation');
    const it = iter[Symbol.asyncIterator]();

    // Need to schedule push BEFORE waiting on next() (next() blocks on waiter)
    const nextPromise = it.next();
    assert.equal(registered, 1, 'register fires on first .next()');

    reg.push({ type: 'remove', path: '/x' });
    const { value, done } = await nextPromise;
    assert.equal(done, false);
    assert.equal((value as TreeEvent & { type: 'remove' }).path, '/x');

    await it.return!();
  });

  it('signal.abort wakes a blocked .next() with done:true', async () => {
    const reg = makeListenerRegistry();
    const ctrl = new AbortController();

    const iter = subscriptionToAsyncIterable<TreeEvent>(reg.register, overflow, { signal: ctrl.signal });
    const it = iter[Symbol.asyncIterator]();

    const pending = it.next();
    // microtask delay so .next() registers the abort listener
    await new Promise(r => setImmediate(r));
    ctrl.abort();

    const result = await pending;
    assert.equal(result.done, true);
    assert.equal(reg.listenerCount(), 0, 'unregister ran on abort');
  });

  it('return() runs unregister and closes', async () => {
    const reg = makeListenerRegistry();
    const iter = subscriptionToAsyncIterable<TreeEvent>(reg.register, overflow);
    const it = iter[Symbol.asyncIterator]();

    // Activate register
    const pending = it.next();
    reg.push({ type: 'remove', path: '/x' });
    await pending;
    assert.equal(reg.listenerCount(), 1);

    await it.return!();
    assert.equal(reg.listenerCount(), 0, 'return runs unregister');

    const { done } = await it.next();
    assert.equal(done, true, 'subsequent .next() returns done');
  });

  it('throw() runs unregister and rethrows', async () => {
    const reg = makeListenerRegistry();
    const iter = subscriptionToAsyncIterable<TreeEvent>(reg.register, overflow);
    const it = iter[Symbol.asyncIterator]();

    // Activate register
    const pending = it.next();
    reg.push({ type: 'remove', path: '/x' });
    await pending;

    const err = new Error('boom');
    await assert.rejects(() => it.throw!(err), e => e === err);
    assert.equal(reg.listenerCount(), 0, 'throw runs unregister');
  });

  it('pre-aborted signal: first .next() returns done WITHOUT calling register', async () => {
    const reg = makeListenerRegistry();
    let registered = 0;
    const ctrl = new AbortController();
    ctrl.abort();

    const iter = subscriptionToAsyncIterable<TreeEvent>(
      (push) => { registered++; return reg.register(push); },
      overflow,
      { signal: ctrl.signal },
    );
    const it = iter[Symbol.asyncIterator]();

    const { done } = await it.next();
    assert.equal(done, true);
    assert.equal(registered, 0, 'pre-aborted signal short-circuits register');
    assert.equal(reg.listenerCount(), 0);
  });

  it('overflow: emits exactly one reconnect{preserved:false} then closes', async () => {
    const reg = makeListenerRegistry();
    const iter = subscriptionToAsyncIterable<TreeEvent>(reg.register, overflow, { buffer: 3 });
    const it = iter[Symbol.asyncIterator]();

    // Activate register
    const first = it.next();
    reg.push({ type: 'remove', path: '/p1' });
    const e1 = await first;
    assert.equal((e1.value as TreeEvent & { type: 'remove' }).path, '/p1');

    // Fill queue beyond buffer without consuming
    reg.push({ type: 'remove', path: '/p2' });
    reg.push({ type: 'remove', path: '/p3' });
    reg.push({ type: 'remove', path: '/p4' });
    reg.push({ type: 'remove', path: '/p5' }); // overflow trigger

    // Pending events were dropped — next yields reconnect
    const r1 = await it.next();
    assert.equal(r1.done, false);
    assert.equal((r1.value as TreeEvent & { type: 'reconnect' }).type, 'reconnect');
    assert.equal((r1.value as TreeEvent & { type: 'reconnect' }).preserved, false);

    const r2 = await it.next();
    assert.equal(r2.done, true, 'closed after overflow reconnect');
    assert.equal(reg.listenerCount(), 0, 'overflow runs unregister');
  });

  it('buffer <= 0 throws BAD_REQUEST at first .next()', () => {
    const reg = makeListenerRegistry();
    const iter = subscriptionToAsyncIterable<TreeEvent>(reg.register, overflow, { buffer: 0 });
    assert.throws(() => iter[Symbol.asyncIterator](), (e: unknown) => e instanceof OpError && e.code === 'BAD_REQUEST');
  });

  it('for-await syntax: terminates cleanly via return', async () => {
    const reg = makeListenerRegistry();
    const iter = subscriptionToAsyncIterable<TreeEvent>(reg.register, overflow);

    const seen: string[] = [];
    const consume = (async () => {
      for await (const e of iter) {
        if (e.type === 'remove') {
          seen.push(e.path);
          if (seen.length === 2) break; // for-await invokes return()
        }
      }
    })();

    // Wait a microtask so the iterator has had a chance to register before pushing
    await new Promise(r => setImmediate(r));
    reg.push({ type: 'remove', path: '/a' });
    reg.push({ type: 'remove', path: '/b' });
    await consume;

    assert.deepEqual(seen, ['/a', '/b']);
    assert.equal(reg.listenerCount(), 0, 'for-await break ran unregister');
  });
});
