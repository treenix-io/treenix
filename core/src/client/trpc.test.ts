// ThrottledEventSource — reconnect backoff for SSE.
// Regression: with a dead server, native EventSource hammered a refused
// connect every ~1s forever (console flood at /t/mnt, 2026-08-14).
// createTrpcTransport watchPath — the event lane opens before the watch registers, and its failures reach watchPath.

import { TRPCClientError } from '@trpc/client';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import type { TreenixClient } from './index';
import { createTrpcTransport, ThrottledEventSource } from './trpc';

class FakeES {
  static instances: FakeES[] = [];
  static waiters: ((es: FakeES) => void)[] = [];

  /** The next EventSource the code under test creates. */
  static next(): Promise<FakeES> {
    return new Promise((resolve) => FakeES.waiters.push(resolve));
  }

  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 2;
  readyState = 0;

  private ls = new Map<string, Set<(e: unknown) => void>>();

  constructor(public url: string, public init?: EventSourceInit) {
    FakeES.instances.push(this);
    for (const resolve of FakeES.waiters.splice(0)) resolve(this);
  }

  addEventListener(type: string, cb: (e: unknown) => void) {
    let set = this.ls.get(type);
    if (!set) this.ls.set(type, set = new Set());
    set.add(cb);
  }

  removeEventListener(type: string, cb: (e: unknown) => void) {
    this.ls.get(type)?.delete(cb);
  }

  close() { this.readyState = this.CLOSED; }

  emit(type: string, event: unknown = {}) {
    this.ls.get(type)?.forEach((cb) => cb(event));
  }

  open() { this.readyState = this.OPEN; this.emit('open'); }
  failNetwork() { this.readyState = this.CONNECTING; this.emit('error'); }
  failFatal() { this.readyState = this.CLOSED; this.emit('error'); }

  /** One server event on the lane, as tRPC's SSE consumer reads it. */
  message(data: unknown) { this.emit('message', { data: JSON.stringify(data) }); }
}

const g = globalThis as { EventSource?: unknown };
const originalES = g.EventSource;

function install() { g.EventSource = FakeES; }

function restore() {
  FakeES.instances = [];
  FakeES.waiters = [];
  if (originalES === undefined) delete g.EventSource;
  else g.EventSource = originalES;
}

describe('ThrottledEventSource', () => {
  afterEach(restore);

  it('throttles reconnects with growing backoff on network failure', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    install();

    const es = new ThrottledEventSource('http://x/trpc/');
    assert.equal(FakeES.instances.length, 1);

    FakeES.instances[0].failNetwork();
    assert.equal(FakeES.instances.length, 1); // no immediate retry

    t.mock.timers.tick(2000); // 1st delay ∈ [750, 1250]
    assert.equal(FakeES.instances.length, 2);

    FakeES.instances[1].failNetwork();
    t.mock.timers.tick(1000); // 2nd delay ∈ [1500, 2500] — throttled, not yet
    assert.equal(FakeES.instances.length, 2);

    t.mock.timers.tick(4000);
    assert.equal(FakeES.instances.length, 3);

    es.close();
  });

  it('re-attaches listeners on the recreated connection', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    install();

    const es = new ThrottledEventSource('http://x/trpc/');
    const got: unknown[] = [];
    es.addEventListener('message', (e) => got.push(e));

    FakeES.instances[0].failNetwork();
    t.mock.timers.tick(2000);

    FakeES.instances[1].open();
    FakeES.instances[1].emit('message', { data: '1' });

    assert.equal(got.length, 1);
    assert.equal(es.readyState, es.OPEN);
    es.close();
  });

  it('resets backoff after a successful open', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    install();

    const es = new ThrottledEventSource('http://x/trpc/');
    FakeES.instances[0].failNetwork();
    t.mock.timers.tick(2000);

    FakeES.instances[1].open();
    FakeES.instances[1].failNetwork();

    // reset → delay ∈ [750, 1250]; without reset ∈ [1500, 2500]
    t.mock.timers.tick(1300);
    assert.equal(FakeES.instances.length, 3);
    es.close();
  });

  it('does not retry HTTP-level rejections', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    install();

    const es = new ThrottledEventSource('http://x/trpc/');
    FakeES.instances[0].failFatal();

    assert.equal(es.readyState, es.CLOSED);
    t.mock.timers.tick(120_000);
    assert.equal(FakeES.instances.length, 1);
  });

  it('close() cancels a pending reconnect', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    install();

    const es = new ThrottledEventSource('http://x/trpc/');
    FakeES.instances[0].failNetwork();
    es.close();

    t.mock.timers.tick(120_000);
    assert.equal(FakeES.instances.length, 1);
    assert.equal(es.readyState, es.CLOSED);
  });
});

describe('createTrpcTransport watchPath', () => {
  afterEach(restore);

  /** Answers every batched query with the node at its requested path and every mutation with null; records each
   *  request URL. A batch naming a path in `failing` fails at the network. */
  function fakeFetch(requests: string[], failing = new Set<string>()) {
    return async (input: string, init?: { body?: string }) => {
      requests.push(input);
      const batch: Record<string, { path?: string }> = JSON.parse(init?.body ?? new URL(input).searchParams.get('input') ?? '{}');
      if (Object.values(batch).some(({ path }) => path !== undefined && failing.has(path))) throw new TypeError('fetch failed');

      const results = Object.values(batch).map(({ path }) => ({ result: { data: path === undefined ? null : { $path: path, $type: 'dir' } } }));
      return new Response(JSON.stringify(results), { headers: { 'content-type': 'application/json' } });
    };
  }

  const verdict = (epoch: string) => ({ type: 'reconnect', preserved: false, seq: 0, epoch });

  const isTrpcError = (e: unknown) => e instanceof TRPCClientError;

  /** A watchPath that opens a new lane: the lane delivers its verdict and the watch registers. */
  async function firstWatch(client: TreenixClient, path: string, onEvent: (e: unknown) => void = () => {}) {
    const opened = FakeES.next();
    const watched = client.watchPath(path, onEvent);
    const es = await opened;
    es.open();
    es.message(verdict('e1'));
    return { es, handle: await watched };
  }

  it('registers the watch only after the event lane delivered its first event', async (t) => {
    install();
    const requests: string[] = [];
    const client = createTrpcTransport({ url: 'http://x', fetch: fakeFetch(requests) });
    t.after(() => client.destroy());

    const opened = FakeES.next();
    const watched = client.watchPath('/a', () => {});
    const es = await opened;
    assert.deepEqual(requests, []);

    es.open();
    es.message(verdict('e1'));
    const { node } = await watched;
    assert.equal(node.$path, '/a');
    assert.equal(requests.length, 1);
  });

  it('a path-less event on the lane reaches every watchPath consumer', { timeout: 5_000 }, async (t) => {
    install();
    const client = createTrpcTransport({ url: 'http://x', fetch: fakeFetch([]) });
    t.after(() => client.destroy());

    const opened = FakeES.next();
    const seen = new Map<string, unknown[]>([['/a', []], ['/b', []]]);
    let bothSaw!: () => void;
    const delivered = new Promise<void>((resolve) => { bothSaw = resolve; });
    const consumer = (path: string) => (e: unknown) => {
      seen.get(path)!.push(e);
      if ([...seen.values()].every((events) => events.length > 0)) bothSaw();
    };

    const watchedA = client.watchPath('/a', consumer('/a'));
    const es = await opened;
    es.open();
    es.message(verdict('e1'));
    await watchedA;
    await client.watchPath('/b', consumer('/b'));

    es.message(verdict('e2'));
    await delivered;
    assert.deepEqual(seen.get('/a'), [verdict('e2')]);
    assert.deepEqual(seen.get('/b'), [verdict('e2')]);
  });

  it('the lane stays open for a watchPath in flight when the last registered consumer leaves', { timeout: 5_000 }, async (t) => {
    install();
    const client = createTrpcTransport({ url: 'http://x', fetch: fakeFetch([]) });
    t.after(() => client.destroy());

    const { es, handle } = await firstWatch(client, '/a');
    let deliver!: (e: unknown) => void;
    const reached = new Promise<unknown>((resolve) => { deliver = resolve; });
    const watchedB = client.watchPath('/b', (e) => deliver(e));
    handle.unsubscribe();
    assert.equal(es.readyState, es.OPEN);

    await watchedB;
    const event = { type: 'set', path: '/b', node: { $type: 'dir' } };
    es.message(event);
    assert.deepEqual(await reached, event);
  });

  it('a lane refused before its verdict fails watchPath, and the next watchPath opens a new lane', { timeout: 5_000 }, async (t) => {
    install();
    t.mock.method(console, 'error', () => {});
    const client = createTrpcTransport({ url: 'http://x', fetch: fakeFetch([]) });
    t.after(() => client.destroy());

    const opened = FakeES.next();
    const watched = client.watchPath('/a', () => {});
    (await opened).failFatal();
    await assert.rejects(watched, isTrpcError);

    const { handle } = await firstWatch(client, '/a');
    assert.equal(FakeES.instances.length, 2);
    assert.equal(handle.node.$path, '/a');
  });

  it('a network failure before the verdict fails watchPath and stops the lane retrying', { timeout: 5_000 }, async (t) => {
    install();
    t.mock.method(console, 'error', () => {});
    const client = createTrpcTransport({ url: 'http://x', fetch: fakeFetch([]) });
    t.after(() => client.destroy());

    const opened = FakeES.next();
    const watched = client.watchPath('/a', () => {});
    const es = await opened;
    t.mock.timers.enable({ apis: ['setTimeout'] });
    es.failNetwork();
    await assert.rejects(watched, isTrpcError);

    t.mock.timers.tick(120_000);
    assert.equal(FakeES.instances.length, 1);
    t.mock.timers.reset();

    const { handle } = await firstWatch(client, '/a');
    assert.equal(FakeES.instances.length, 2);
    assert.equal(handle.node.$path, '/a');
  });

  it('a watchPath whose read fails closes the lane nothing else uses', { timeout: 5_000 }, async (t) => {
    install();
    const client = createTrpcTransport({ url: 'http://x', fetch: fakeFetch([], new Set(['/a'])) });
    t.after(() => client.destroy());

    const opened = FakeES.next();
    const watched = client.watchPath('/a', () => {});
    const es = await opened;
    es.open();
    es.message(verdict('e1'));
    await assert.rejects(watched, isTrpcError);
    assert.equal(es.readyState, es.CLOSED);
  });
});
