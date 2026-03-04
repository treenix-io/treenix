// Tests for the UIX lazy loading pipeline:
// onResolveMiss → async fetch → register → bump() → listener notified
//
// The bug this covers: render-phase onResolveMiss could fire before
// useSyncExternalStore subscription was active, causing bump() to be missed.
// Fix: Render also calls resolve() from useEffect (post-commit) as a safety net.

import { getRegistryVersion, onResolveMiss, register, resolve, subscribeRegistry, unregister } from '#core';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { compileComponent, invalidateCache } from './compile';

// ── Helpers ──────────────────────────────────────────────────────────────────

function clearType(type: string, context: string) {
  unregister(type, context);
}

// ── Registry miss mechanism ───────────────────────────────────────────────────

describe('onResolveMiss', () => {
  afterEach(() => {
    // Clean up miss resolver
    onResolveMiss('test-ctx', () => {});
  });

  it('fires when type has no exact match', () => {
    const missed: string[] = [];
    onResolveMiss('test-ctx', (type) => missed.push(type));

    resolve('not.registered', 'test-ctx');
    assert.deepEqual(missed, ['not.registered']);
  });

  it('does NOT fire when type is exactly registered', () => {
    const missed: string[] = [];
    onResolveMiss('test-ctx', (type) => missed.push(type));

    register('found.type', 'test-ctx', () => 'handler');
    resolve('found.type', 'test-ctx');
    assert.deepEqual(missed, [], 'should not fire miss when exact match exists');

    unregister('found.type', 'test-ctx');
  });

  it('does NOT fire with _notifyMiss=false', () => {
    const missed: string[] = [];
    onResolveMiss('test-ctx', (type) => missed.push(type));

    resolve('not.registered', 'test-ctx', false);
    assert.deepEqual(missed, [], 'should not fire when notifyMiss=false');
  });
});

// ── subscribeRegistry + bump() pipeline ──────────────────────────────────────

describe('registry subscription', () => {
  it('listener fires when register is called', () => {
    let fired = 0;
    const unsub = subscribeRegistry(() => fired++);

    register('sub.test', 'react', () => null as any);
    assert.ok(fired > 0, 'listener should fire after register');

    unregister('sub.test', 'react');
    unsub();
  });

  it('getRegistryVersion increments on register', () => {
    const before = getRegistryVersion();
    register('ver.test', 'react', () => null as any);
    const after = getRegistryVersion();
    assert.ok(after > before, `version should increase: ${before} → ${after}`);
    unregister('ver.test', 'react');
  });

  it('multiple listeners all notified on bump', () => {
    const counts = [0, 0, 0];
    const unsubs = counts.map((_, i) => subscribeRegistry(() => counts[i]++));

    register('multi.test', 'react', () => null as any);

    assert.ok(counts.every(c => c > 0), `all listeners should fire: ${counts}`);

    unregister('multi.test', 'react');
    unsubs.forEach(u => u());
  });

  it('listener NOT fired after unsubscribe', () => {
    let fired = 0;
    const unsub = subscribeRegistry(() => fired++);
    unsub();

    register('unsub.test', 'react', () => null as any);
    assert.equal(fired, 0, 'unsubscribed listener should not fire');
    unregister('unsub.test', 'react');
  });
});

// ── Async miss → register → listener flow ────────────────────────────────────

describe('async lazy load flow', () => {
  it('register after async delay notifies listener', async () => {
    const type = 'async.lazy.test';
    let notified = false;
    const unsub = subscribeRegistry(() => { notified = true; });

    // Confirm not registered yet (exact lookup, no fallback)
    assert.equal(resolve(type, 'react', false), null, 'should not be registered yet');

    // Simulate async completion (e.g., fetch + compile)
    await new Promise<void>((res) => {
      setTimeout(() => {
        register(type, 'react', () => null as any);
        res();
      }, 0);
    });

    assert.ok(notified, 'listener should have been notified after register');
    assert.ok(resolve(type, 'react', false) !== null, 'should be resolvable after registration');

    unregister(type, 'react');
    unsub();
  });

  it('resolve finds handler after async registration', async () => {
    const type = 'async.found.test';
    const handler = () => null as any;

    assert.equal(resolve(type, 'react', false), null, 'should not be registered yet');

    await new Promise<void>((res) => setTimeout(() => {
      register(type, 'react', handler as any);
      res();
    }, 0));

    // After registration, exact resolve (no fallback) should find the handler
    assert.equal(resolve(type, 'react', false), handler, 'exact handler should be returned');

    unregister(type, 'react');
  });
});

// ── inflight dedup pattern ────────────────────────────────────────────────────

describe('inflight dedup', () => {
  it('prevents duplicate async calls while in-flight', async () => {
    const inflight = new Set<string>();
    let callCount = 0;

    // Simulate onResolveMiss handler with inflight dedup
    function missHandler(type: string) {
      if (inflight.has(type)) return;
      inflight.add(type);
      callCount++;

      // Simulate async fetch
      Promise.resolve().then(() => {
        inflight.delete(type);
      });
    }

    onResolveMiss('dedup-ctx', missHandler);

    // Fire three times before async resolves
    resolve('dedup.type', 'dedup-ctx');
    resolve('dedup.type', 'dedup-ctx');
    resolve('dedup.type', 'dedup-ctx');

    assert.equal(callCount, 1, 'only one fetch should start despite multiple misses');

    // Wait for inflight to clear
    await new Promise(r => setTimeout(r, 10));
    assert.ok(!inflight.has('dedup.type'), 'inflight should be cleared after completion');

    // Now a new miss CAN start a new fetch
    resolve('dedup.type', 'dedup-ctx');
    assert.equal(callCount, 2, 'retry should be possible after inflight cleared');

    onResolveMiss('dedup-ctx', () => {});
  });

  it('allows retry after failure (vs permanent attempted set)', async () => {
    const inflight = new Set<string>();
    let attempts = 0;

    function missHandler(type: string) {
      if (inflight.has(type)) return;
      inflight.add(type);
      attempts++;
      // Simulate failure: clear inflight (no register, no bump)
      Promise.resolve().then(() => inflight.delete(type));
    }

    onResolveMiss('retry-ctx', missHandler);

    resolve('retry.type', 'retry-ctx');
    assert.equal(attempts, 1);

    await new Promise(r => setTimeout(r, 10)); // wait for inflight clear

    resolve('retry.type', 'retry-ctx');
    assert.equal(attempts, 2, 'retry should be possible after failed fetch');

    onResolveMiss('retry-ctx', () => {});
  });
});

// ── compileComponent → register → bump pipeline ──────────────────────────────

describe('compileComponent triggers registration', () => {
  beforeEach(() => invalidateCache());

  it('compileComponent bumps registry version', () => {
    const before = getRegistryVersion();
    const code = `export default function L({ value }) { return <span>{value.x}</span>; }`;
    compileComponent('test.bump.comp', code);
    assert.ok(getRegistryVersion() > before, 'version should increment after compile');
    clearType('test.bump.comp', 'react');
  });

  it('compileComponent notifies all subscribers', () => {
    let fired = 0;
    const unsub = subscribeRegistry(() => fired++);

    const code = `export default function N({ value }) { return <div />; }`;
    compileComponent('test.notify.comp', code);

    assert.ok(fired > 0, 'subscribers should be notified after compile+register');
    clearType('test.notify.comp', 'react');
    unsub();
  });

  it('full pipeline: miss → compile → resolve → render', () => {
    const type = 'test.full.pipe';
    const missed: string[] = [];
    onResolveMiss('react', (t) => missed.push(t));

    // Step 1: resolve misses
    const fallback = resolve(type, 'react');
    assert.ok(missed.includes(type), 'onResolveMiss should fire');

    // Step 2: async load completes — compile registers
    const code = `export default function P({ value }) { return <p>{value.msg}</p>; }`;
    compileComponent(type, code);

    // Step 3: now resolve finds it
    const handler = resolve(type, 'react', false);
    assert.ok(handler, 'handler should be registered after compileComponent');

    // Step 4: renders correctly
    const html = renderToString(React.createElement(handler as any, { value: { msg: 'hello' } }));
    assert.ok(html.includes('hello'), `Should render. Got: ${html}`);

    clearType(type, 'react');
    // restore default miss handler (noop)
    onResolveMiss('react', () => {});
  });
});
