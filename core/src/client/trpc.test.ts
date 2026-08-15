// ThrottledEventSource — reconnect backoff for SSE.
// Regression: with a dead server, native EventSource hammered a refused
// connect every ~1s forever (console flood at /t/mnt, 2026-08-14).

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { ThrottledEventSource } from './trpc';

class FakeES {
  static instances: FakeES[] = [];

  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 2;
  readyState = 0;

  private ls = new Map<string, Set<(e: unknown) => void>>();

  constructor(public url: string, public init?: EventSourceInit) {
    FakeES.instances.push(this);
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
}

describe('ThrottledEventSource', () => {
  const g = globalThis as { EventSource?: unknown };
  const originalES = g.EventSource;

  function install() { g.EventSource = FakeES; }

  afterEach(() => {
    FakeES.instances = [];
    if (originalES === undefined) delete g.EventSource;
    else g.EventSource = originalES;
  });

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
