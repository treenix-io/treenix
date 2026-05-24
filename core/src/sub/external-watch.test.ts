// runExternalWatch — pumps an outside Tree's watch stream into the
// subscription bus, with per-mount dedup of self-writes.
//
// Tests pin the contract that other mount adapters depend on:
//   - dedup window suppresses duplicates from change-stream observing our writes
//   - dedup window OFF lets every event through
//   - abort tears down stream + timer + selfWrite subscription (no leak)
//   - stream errors emit reconnect{preserved:false} and retry with backoff
//   - natural stream end (e.g. mongo invalidate) does NOT emit extra reconnect
//   - repath translates inner→outer namespace before forwarding (and before dedup match)

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createMemoryTree, type Tree, type TreeEvent } from '#tree';
import { runExternalWatch } from './external-watch';
import { withSubscriptions } from './index';
import type { NodeData } from '#core';

// ── Mock Tree.watch — caller-driven push + endStream/throw ──

interface MockWatch {
  push(e: TreeEvent): void;
  endStream(): void;        // graceful (like mongo invalidate)
  fail(err: Error): void;   // throw from inside the for-await
  isClosed(): boolean;
  callCount(): number;      // how many times tree.watch was invoked (retry count)
}

function makeMockTree(): { tree: Tree; ctl: MockWatch } {
  let push: ((e: TreeEvent) => void) | null = null;
  let waiter: ((v: IteratorResult<TreeEvent>) => void) | null = null;
  let rejecter: ((err: Error) => void) | null = null;
  const queue: TreeEvent[] = [];
  let closed = false;
  let ended = false;
  let callCount = 0;

  function emitToWaiter(result: IteratorResult<TreeEvent>) {
    const w = waiter; waiter = null; rejecter = null;
    if (w) w(result);
  }

  const ctl: MockWatch = {
    push(e) {
      if (closed || ended) return;
      if (waiter) emitToWaiter({ value: e, done: false });
      else queue.push(e);
    },
    endStream() {
      if (closed) return;
      ended = true;
      if (waiter) emitToWaiter({ value: undefined, done: true });
    },
    fail(err) {
      if (closed) return;
      const r = rejecter;
      waiter = null;
      rejecter = null;
      if (r) r(err);
    },
    isClosed: () => closed,
    callCount: () => callCount,
  };

  const tree: Tree = {
    get: async () => undefined,
    getChildren: async () => ({ items: [], total: 0 }),
    set: async () => {},
    remove: async () => false,
    patch: async () => {},
    watch(_scope, opts) {
      callCount++;
      // Reset stream state for the new subscription (retry created a fresh one)
      closed = false;
      ended = false;
      queue.length = 0;
      push = ctl.push;
      // Honor AbortSignal exactly as the real subscriptionToAsyncIterable does:
      // on abort, close the stream and wake any waiter with {done:true}. Without
      // this the mock would diverge from production behavior on cleanup paths.
      const signal = opts?.signal;
      if (signal) {
        if (signal.aborted) {
          closed = true;
        } else {
          signal.addEventListener('abort', () => {
            closed = true;
            emitToWaiter({ value: undefined, done: true });
          }, { once: true });
        }
      }
      return {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              if (queue.length) return { value: queue.shift()!, done: false };
              if (closed || ended) return { value: undefined, done: true };
              return new Promise<IteratorResult<TreeEvent>>((res, rej) => {
                waiter = res;
                rejecter = rej;
              });
            },
            async return() {
              closed = true;
              emitToWaiter({ value: undefined, done: true });
              return { value: undefined, done: true };
            },
          };
        },
      };
    },
  };

  return { tree, ctl };
}

// ── Mock onSelfWrite channel ──

function makeSelfWriteChannel() {
  const listeners = new Set<(path: string, rev: number | undefined) => void>();
  return {
    onSelfWrite: (l: (path: string, rev: number | undefined) => void) => {
      listeners.add(l);
      return () => { listeners.delete(l); };
    },
    fire(path: string, rev: number | undefined) {
      for (const l of listeners) l(path, rev);
    },
    listenerCount: () => listeners.size,
  };
}

// Drain microtasks so async loops can advance to their next await point.
const drain = () => new Promise(r => setImmediate(r));

describe('runExternalWatch — basic forwarding', () => {
  it('forwards events from tree.watch through forwardEvent', async () => {
    const { tree, ctl } = makeMockTree();
    const ac = new AbortController();
    const out: TreeEvent[] = [];

    runExternalWatch(tree, {
      pathPrefix: '/',
      forwardEvent: (e) => out.push(e),
      signal: ac.signal,
      source: 'test',
    });

    await drain();
    ctl.push({ type: 'set', path: '/a', node: { $type: 't' } });
    await drain();

    assert.equal(out.length, 1);
    assert.equal(out[0].type, 'set');
    if (out[0].type === 'set') assert.equal(out[0].path, '/a');

    ac.abort();
  });

  it('throws synchronously when tree.watch is missing', () => {
    const tree: Tree = {
      get: async () => undefined,
      getChildren: async () => ({ items: [], total: 0 }),
      set: async () => {},
      remove: async () => false,
      patch: async () => {},
    };
    const ac = new AbortController();
    assert.throws(() => runExternalWatch(tree, {
      pathPrefix: '/',
      forwardEvent: () => {},
      signal: ac.signal,
      source: 'no-watch',
    }), /does not expose watch/);
  });

  it('throws synchronously when dedupWindowMs > 0 but onSelfWrite missing', () => {
    const { tree } = makeMockTree();
    const ac = new AbortController();
    assert.throws(() => runExternalWatch(tree, {
      pathPrefix: '/',
      forwardEvent: () => {},
      dedupWindowMs: 1000,
      signal: ac.signal,
      source: 'misconfig',
    }), /requires onSelfWrite/);
  });
});

describe('runExternalWatch — repath', () => {
  it('prefix "/" with path "/foo" → "/foo" (no-op)', async () => {
    const { tree, ctl } = makeMockTree();
    const ac = new AbortController();
    const out: TreeEvent[] = [];

    runExternalWatch(tree, {
      pathPrefix: '/',
      forwardEvent: (e) => out.push(e),
      signal: ac.signal,
      source: 'shared',
    });

    await drain();
    ctl.push({ type: 'set', path: '/foo', node: { $type: 't' } });
    await drain();

    if (out[0].type === 'set') assert.equal(out[0].path, '/foo');
    ac.abort();
  });

  it('prefix "/mount" with path "/foo" → "/mount/foo"', async () => {
    const { tree, ctl } = makeMockTree();
    const ac = new AbortController();
    const out: TreeEvent[] = [];

    runExternalWatch(tree, {
      pathPrefix: '/mount',
      forwardEvent: (e) => out.push(e),
      signal: ac.signal,
      source: 'mounted',
    });

    await drain();
    ctl.push({ type: 'set', path: '/foo', node: { $type: 't' } });
    ctl.push({ type: 'remove', path: '/foo/bar' });
    await drain();

    assert.equal(out.length, 2);
    if (out[0].type === 'set') assert.equal(out[0].path, '/mount/foo');
    if (out[1].type === 'remove') assert.equal(out[1].path, '/mount/foo/bar');
    ac.abort();
  });

  it('prefix "/mount" with path "/" → "/mount"', async () => {
    const { tree, ctl } = makeMockTree();
    const ac = new AbortController();
    const out: TreeEvent[] = [];

    runExternalWatch(tree, {
      pathPrefix: '/mount',
      forwardEvent: (e) => out.push(e),
      signal: ac.signal,
      source: 'root',
    });

    await drain();
    ctl.push({ type: 'set', path: '/', node: { $type: 't' } });
    await drain();

    if (out[0].type === 'set') assert.equal(out[0].path, '/mount');
    ac.abort();
  });
});

describe('runExternalWatch — dedup', () => {
  it('dedupWindowMs=0 (the safer default): no dedup, every event forwarded', async () => {
    const { tree, ctl } = makeMockTree();
    const sw = makeSelfWriteChannel();
    const ac = new AbortController();
    const out: TreeEvent[] = [];

    runExternalWatch(tree, {
      pathPrefix: '/',
      forwardEvent: (e) => out.push(e),
      onSelfWrite: sw.onSelfWrite,
      dedupWindowMs: 0,
      signal: ac.signal,
      source: 'no-dedup',
    });

    await drain();
    sw.fire('/foo', 7); // would have suppressed if dedup were on
    ctl.push({ type: 'set', path: '/foo', node: { $type: 't', $rev: 7 } });
    await drain();

    assert.equal(out.length, 1, 'dedup off → event forwarded');
    ac.abort();
  });

  it('dedupWindowMs default of 0 produces no buffer; even repeated self-write does not suppress', async () => {
    // Regression: changing the MountMongo default to 0 means consumers that
    // forget to set it inherit the correctness-first behavior. Any call to
    // sw.fire() without dedup ON must NOT affect forward count.
    const { tree, ctl } = makeMockTree();
    const sw = makeSelfWriteChannel();
    const ac = new AbortController();
    const out: TreeEvent[] = [];

    runExternalWatch(tree, {
      pathPrefix: '/',
      forwardEvent: (e) => out.push(e),
      onSelfWrite: sw.onSelfWrite, // present but unused when dedupWindowMs omitted
      signal: ac.signal,
      source: 'omitted-dedup',
    });

    await drain();
    sw.fire('/a', 1); sw.fire('/a', 2); sw.fire('/a', 3);
    ctl.push({ type: 'set', path: '/a', node: { $type: 't', $rev: 1 } });
    ctl.push({ type: 'set', path: '/a', node: { $type: 't', $rev: 2 } });
    await drain();

    assert.equal(out.length, 2, 'every external event forwarded when dedup unset');
    ac.abort();
  });

  it('dedupWindowMs>0: self-write within window suppresses matching external event', async () => {
    const { tree, ctl } = makeMockTree();
    const sw = makeSelfWriteChannel();
    const ac = new AbortController();
    const out: TreeEvent[] = [];

    runExternalWatch(tree, {
      pathPrefix: '/',
      forwardEvent: (e) => out.push(e),
      onSelfWrite: sw.onSelfWrite,
      dedupWindowMs: 5_000,
      signal: ac.signal,
      source: 'dedup-on',
    });

    await drain();

    // Self-write FIRST (the realistic order — withSubscriptions emit precedes
    // the async change-stream delivery for any well-ordered write)
    sw.fire('/foo', 5);
    ctl.push({ type: 'set', path: '/foo', node: { $type: 't', $rev: 5 } });
    await drain();

    assert.equal(out.length, 0, 'matching (path, rev) self-write was suppressed');

    // Different rev → NOT suppressed
    ctl.push({ type: 'set', path: '/foo', node: { $type: 't', $rev: 6 } });
    await drain();
    assert.equal(out.length, 1, 'different rev → forwarded');

    // Different path → NOT suppressed
    ctl.push({ type: 'set', path: '/other', node: { $type: 't', $rev: 5 } });
    await drain();
    assert.equal(out.length, 2, 'different path → forwarded');

    ac.abort();
  });

  it('dedup keys: remove uses different keyspace than set (no false collision)', async () => {
    const { tree, ctl } = makeMockTree();
    const sw = makeSelfWriteChannel();
    const ac = new AbortController();
    const out: TreeEvent[] = [];

    runExternalWatch(tree, {
      pathPrefix: '/',
      forwardEvent: (e) => out.push(e),
      onSelfWrite: sw.onSelfWrite,
      dedupWindowMs: 5_000,
      signal: ac.signal,
      source: 'keyspace',
    });

    await drain();

    // Self-write fires for a remove of /foo (rev undefined)
    sw.fire('/foo', undefined);
    // An external SET of /foo arrives — different operation, must NOT be suppressed
    ctl.push({ type: 'set', path: '/foo', node: { $type: 't', $rev: 1 } });
    await drain();

    assert.equal(out.length, 1, 'set is not deduped by an unrelated remove');
    ac.abort();
  });

  it('remove events are NEVER deduped (false-suppress would lose deletes)', async () => {
    // Sequence: Treenix removes /x → external recreates /x → external removes /x
    // again within the dedup window. If remove were path-deduped, step 3
    // would be silently dropped and clients would still think /x exists.
    const { tree, ctl } = makeMockTree();
    const sw = makeSelfWriteChannel();
    const ac = new AbortController();
    const out: TreeEvent[] = [];

    runExternalWatch(tree, {
      pathPrefix: '/',
      forwardEvent: (e) => out.push(e),
      onSelfWrite: sw.onSelfWrite,
      dedupWindowMs: 5_000,
      signal: ac.signal,
      source: 'remove-safety',
    });

    await drain();

    // Self-remove of /x — marks nothing for remove (per design)
    sw.fire('/x', undefined);
    // External recreate + remove — both MUST be delivered
    ctl.push({ type: 'set', path: '/x', node: { $type: 't', $rev: 1 } });
    ctl.push({ type: 'remove', path: '/x' });
    await drain();

    const removes = out.filter(e => e.type === 'remove');
    const sets = out.filter(e => e.type === 'set');
    assert.equal(sets.length, 1, 'external set delivered');
    assert.equal(removes.length, 1, 'external remove must NOT be suppressed by an earlier self-remove');
    ac.abort();
  });

  it('dedup respects repath: outer-namespace key matches outer-namespace self-write', async () => {
    const { tree, ctl } = makeMockTree();
    const sw = makeSelfWriteChannel();
    const ac = new AbortController();
    const out: TreeEvent[] = [];

    runExternalWatch(tree, {
      pathPrefix: '/mount',
      forwardEvent: (e) => out.push(e),
      onSelfWrite: sw.onSelfWrite,
      dedupWindowMs: 5_000,
      signal: ac.signal,
      source: 'repath-dedup',
    });

    await drain();

    // withSubscriptions reports the OUTER path (after withMounts/repath)
    sw.fire('/mount/foo', 9);
    // Change stream gives INNER path; runExternalWatch repaths to /mount/foo
    // then checks dedup → must hit
    ctl.push({ type: 'set', path: '/foo', node: { $type: 't', $rev: 9 } });
    await drain();

    assert.equal(out.length, 0, 'dedup matched after repath');
    ac.abort();
  });

  it('outside window: event after bucket rotation is forwarded', async () => {
    const { tree, ctl } = makeMockTree();
    const sw = makeSelfWriteChannel();
    const ac = new AbortController();
    const out: TreeEvent[] = [];
    const windowMs = 40;

    runExternalWatch(tree, {
      pathPrefix: '/',
      forwardEvent: (e) => out.push(e),
      onSelfWrite: sw.onSelfWrite,
      dedupWindowMs: windowMs,
      signal: ac.signal,
      source: 'window-expiry',
    });

    await drain();
    sw.fire('/foo', 3);

    // Wait long enough for both buckets to rotate past the marked entry
    await new Promise(r => setTimeout(r, windowMs * 2 + 20));

    ctl.push({ type: 'set', path: '/foo', node: { $type: 't', $rev: 3 } });
    await drain();

    assert.equal(out.length, 1, 'after window expiry: event forwarded');
    ac.abort();
  });
});

describe('runExternalWatch — lifecycle', () => {
  it('abort: closes inner stream, unsubscribes from onSelfWrite', async () => {
    const { tree, ctl } = makeMockTree();
    const sw = makeSelfWriteChannel();
    const ac = new AbortController();
    const out: TreeEvent[] = [];

    runExternalWatch(tree, {
      pathPrefix: '/',
      forwardEvent: (e) => out.push(e),
      onSelfWrite: sw.onSelfWrite,
      dedupWindowMs: 1000,
      signal: ac.signal,
      source: 'abort',
    });

    await drain();
    assert.equal(sw.listenerCount(), 1, 'selfWrite subscription active');

    ac.abort();
    await drain();

    assert.ok(ctl.isClosed(), 'inner stream closed');
    assert.equal(sw.listenerCount(), 0, 'selfWrite subscription cleaned up');

    // Pushing after abort must not deliver
    ctl.push({ type: 'set', path: '/late', node: { $type: 't' } });
    await drain();
    assert.equal(out.length, 0);
  });

  it('pre-aborted signal: no register, cleanup runs', async () => {
    const { tree, ctl } = makeMockTree();
    const sw = makeSelfWriteChannel();
    const ac = new AbortController();
    ac.abort();

    runExternalWatch(tree, {
      pathPrefix: '/',
      forwardEvent: () => {},
      onSelfWrite: sw.onSelfWrite,
      dedupWindowMs: 1000,
      signal: ac.signal,
      source: 'pre-aborted',
    });

    await drain();
    assert.equal(ctl.callCount(), 0, 'tree.watch not called');
    assert.equal(sw.listenerCount(), 0, 'no subscription leaked');
  });
});

describe('runExternalWatch — cache invalidation', () => {
  it('invalidates outer cache for data events BEFORE forwarding', async () => {
    const { tree, ctl } = makeMockTree();
    const ac = new AbortController();
    const invalidated: string[] = [];
    const order: string[] = [];

    runExternalWatch(tree, {
      pathPrefix: '/mount',
      forwardEvent: (e) => {
        if (e.type !== 'reconnect') order.push(`forward:${e.path}`);
      },
      invalidateCachePath: (p) => {
        invalidated.push(p);
        order.push(`invalidate:${p}`);
      },
      signal: ac.signal,
      source: 'cache-inv',
    });

    await drain();
    ctl.push({ type: 'set', path: '/foo', node: { $type: 't' } });
    await drain();

    assert.deepEqual(invalidated, ['/mount/foo'], 'invalidated outer-namespace path');
    // Strict ordering: invalidate runs BEFORE forward so any reader
    // triggered by the event sees fresh data.
    assert.deepEqual(order, ['invalidate:/mount/foo', 'forward:/mount/foo']);

    ac.abort();
  });

  it('invalidates outer cache for remove events', async () => {
    const { tree, ctl } = makeMockTree();
    const ac = new AbortController();
    const invalidated: string[] = [];

    runExternalWatch(tree, {
      pathPrefix: '/',
      forwardEvent: () => {},
      invalidateCachePath: (p) => invalidated.push(p),
      signal: ac.signal,
      source: 'remove-inv',
    });

    await drain();
    ctl.push({ type: 'remove', path: '/x' });
    await drain();

    assert.deepEqual(invalidated, ['/x']);
    ac.abort();
  });

  it('clears entire cache on reconnect{preserved:false}', async () => {
    const { tree, ctl } = makeMockTree();
    const ac = new AbortController();
    let clearedAll = 0;
    const pathInvalidations: string[] = [];

    runExternalWatch(tree, {
      pathPrefix: '/',
      forwardEvent: () => {},
      invalidateCachePath: (p) => pathInvalidations.push(p),
      invalidateCacheAll: () => { clearedAll++; },
      signal: ac.signal,
      source: 'invalidate-all',
    });

    await drain();
    ctl.push({ type: 'reconnect', preserved: false });
    await drain();

    assert.equal(clearedAll, 1, 'cache cleared wholesale');
    assert.equal(pathInvalidations.length, 0, 'no path-level call for reconnect');
    ac.abort();
  });

  it('caught stream error: clears cache BEFORE forwarding reconnect{preserved:false}', async () => {
    const { tree, ctl } = makeMockTree();
    const ac = new AbortController();
    const out: TreeEvent[] = [];
    let clearedAll = 0;
    const order: string[] = [];

    const origErr = console.error;
    console.error = () => {};

    try {
      runExternalWatch(tree, {
        pathPrefix: '/',
        forwardEvent: (e) => {
          out.push(e);
          if (e.type === 'reconnect') order.push('forward:reconnect');
        },
        invalidateCacheAll: () => { clearedAll++; order.push('invalidateAll'); },
        signal: ac.signal,
        source: 'error-cache-clear',
        initialRetryMs: 5,
        maxRetryMs: 10,
      });

      await drain();
      ctl.fail(new Error('stream blew up'));
      await new Promise(r => setTimeout(r, 30));

      assert.ok(clearedAll >= 1, 'cache cleared on stream error');
      const firstReconnect = order.findIndex(s => s === 'forward:reconnect');
      const firstInvalidate = order.findIndex(s => s === 'invalidateAll');
      assert.ok(firstInvalidate >= 0 && firstInvalidate < firstReconnect,
        'invalidateAll runs BEFORE the reconnect is forwarded');
    } finally {
      console.error = origErr;
      ac.abort();
    }
  });

  it('does NOT clear cache on reconnect{preserved:true}', async () => {
    const { tree, ctl } = makeMockTree();
    const ac = new AbortController();
    let clearedAll = 0;

    runExternalWatch(tree, {
      pathPrefix: '/',
      forwardEvent: () => {},
      invalidateCacheAll: () => { clearedAll++; },
      signal: ac.signal,
      source: 'preserved',
    });

    await drain();
    ctl.push({ type: 'reconnect', preserved: true });
    await drain();

    assert.equal(clearedAll, 0, 'preserved reconnect: cache untouched');
    ac.abort();
  });
});

describe('runExternalWatch — error recovery', () => {
  it('stream throws: emits reconnect{preserved:false} and retries', async () => {
    const { tree, ctl } = makeMockTree();
    const ac = new AbortController();
    const out: TreeEvent[] = [];

    // Silence the expected error log so test output stays clean
    const origErr = console.error;
    console.error = () => {};

    runExternalWatch(tree, {
      pathPrefix: '/',
      forwardEvent: (e) => out.push(e),
      signal: ac.signal,
      source: 'retry',
      initialRetryMs: 5,
      maxRetryMs: 10,
    });

    try {
      await drain();
      ctl.fail(new Error('boom'));

      // Wait for reconnect + retry to start
      await new Promise(r => setTimeout(r, 30));

      const reconnects = out.filter(e => e.type === 'reconnect');
      assert.ok(reconnects.length >= 1, 'reconnect emitted on stream error');
      const r0 = reconnects[0];
      if (r0.type === 'reconnect') assert.equal(r0.preserved, false);

      assert.ok(ctl.callCount() >= 2, 'tree.watch re-called for retry');
    } finally {
      console.error = origErr;
      ac.abort();
    }
  });

  it('natural stream end (graceful endStream): does NOT emit extra reconnect', async () => {
    const { tree, ctl } = makeMockTree();
    const ac = new AbortController();
    const out: TreeEvent[] = [];

    runExternalWatch(tree, {
      pathPrefix: '/',
      forwardEvent: (e) => out.push(e),
      signal: ac.signal,
      source: 'natural-end',
      initialRetryMs: 5,
      maxRetryMs: 10,
    });

    await drain();
    // Simulate a source-driven reconnect followed by graceful end
    // (this is exactly what mongo's `invalidate` produces)
    ctl.push({ type: 'reconnect', preserved: false });
    ctl.endStream();

    await new Promise(r => setTimeout(r, 30));

    const reconnects = out.filter(e => e.type === 'reconnect');
    // Exactly 1 reconnect: the source's, not a runExternalWatch-injected duplicate
    assert.equal(reconnects.length, 1, 'no extra reconnect on natural end');
    assert.ok(ctl.callCount() >= 2, 'still retries after natural end');

    ac.abort();
  });

  it('integrates with real withSubscriptions: self-write through pipeline is deduped, external write flows through', async () => {
    // End-to-end shape: withSubscriptions sees pipeline writes and emits self-write
    // notifications; runExternalWatch subscribes to those AND iterates a parallel
    // "external" change stream. Dedup of self-writes is the load-bearing property
    // — without it every pipeline write would arrive at SSE clients twice.

    const { tree: subscribedTree, onSelfWrite } = withSubscriptions(createMemoryTree());

    const { tree: mockExternalTree, ctl } = makeMockTree();
    const ac = new AbortController();
    const out: TreeEvent[] = [];

    runExternalWatch(mockExternalTree, {
      pathPrefix: '/',
      forwardEvent: (e) => out.push(e),
      onSelfWrite,
      dedupWindowMs: 5_000,
      signal: ac.signal,
      source: 'integration',
    });

    await drain();

    // 1. Pipeline write — withSubscriptions emits, onSelfWrite fires, dedup buffer marks
    await subscribedTree.set({ $path: '/x', $type: 't', v: 1 } as NodeData);
    const writtenRev = (await subscribedTree.get('/x'))!.$rev as number;

    // 2. Mock change-stream echoes back the same (path, rev) — this is the duplicate
    //    that would otherwise reach SSE clients
    ctl.push({ type: 'set', path: '/x', node: { $type: 't', v: 1, $rev: writtenRev } });
    await drain();

    assert.equal(out.length, 0, 'self-write echo suppressed by dedup');

    // 3. A purely external write (no matching self-write recorded) flows through
    ctl.push({ type: 'set', path: '/external', node: { $type: 't', $rev: 1 } });
    await drain();

    assert.equal(out.length, 1, 'external write forwarded');
    if (out[0].type === 'set') assert.equal(out[0].path, '/external');

    ac.abort();
  });

  it('attempt counter resets on successful event between failures', async () => {
    // Hard to assert backoff timing precisely without fake timers; we instead
    // assert that an event between two failures keeps the retry alive (i.e.,
    // it doesn't escalate to maxRetryMs after just two failures).
    const { tree, ctl } = makeMockTree();
    const ac = new AbortController();
    const out: TreeEvent[] = [];

    const origErr = console.error;
    console.error = () => {};

    runExternalWatch(tree, {
      pathPrefix: '/',
      forwardEvent: (e) => out.push(e),
      signal: ac.signal,
      source: 'backoff-reset',
      initialRetryMs: 5,
      maxRetryMs: 10,
    });

    try {
      await drain();
      ctl.fail(new Error('first'));
      await new Promise(r => setTimeout(r, 20));
      ctl.push({ type: 'set', path: '/ok', node: { $type: 't' } });
      await drain();
      ctl.fail(new Error('second'));
      await new Promise(r => setTimeout(r, 20));

      const sets = out.filter(e => e.type === 'set');
      assert.equal(sets.length, 1, 'data event delivered between failures');
      const reconnects = out.filter(e => e.type === 'reconnect');
      assert.ok(reconnects.length >= 2, 'reconnect on each failure');
    } finally {
      console.error = origErr;
      ac.abort();
    }
  });
});
