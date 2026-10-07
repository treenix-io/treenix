import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { safeInterval, safeTimeout } from './safe-timers';

describe('safeInterval', () => {
  it('propagates the callback failure', async (t) => {
    const handle = setTimeout(() => {}, 60_000);
    clearTimeout(handle);
    const scheduled = t.mock.method(globalThis, 'setInterval', () => handle);
    t.mock.method(console, 'error', () => {});
    const failure = new Error('write failed');

    assert.equal(safeInterval(async () => { throw failure; }, 10, 'test'), handle);
    const callback = scheduled.mock.calls[0].arguments[0];
    assert.ok(callback);
    await assert.rejects(async () => callback(), (error) => error === failure);
  });

  it('runs each scheduled callback', async (t) => {
    const handle = setTimeout(() => {}, 60_000);
    clearTimeout(handle);
    const scheduled = t.mock.method(globalThis, 'setInterval', () => handle);
    let count = 0;

    safeInterval(async () => { count++; }, 10, 'test');
    const callback = scheduled.mock.calls[0].arguments[0];
    assert.ok(callback);
    await callback();
    await callback();

    assert.equal(count, 2);
  });
});

describe('safeTimeout', () => {
  it('propagates the callback failure', async (t) => {
    const handle = setTimeout(() => {}, 60_000);
    clearTimeout(handle);
    const scheduled = t.mock.method(globalThis, 'setTimeout', () => handle);
    t.mock.method(console, 'error', () => {});
    const failure = new Error('write failed');

    assert.equal(safeTimeout(async () => { throw failure; }, 10, 'test'), handle);
    const callback = scheduled.mock.calls[0].arguments[0];
    assert.ok(callback);
    await assert.rejects(async () => callback(), (error) => error === failure);
  });

  it('runs the scheduled callback', async (t) => {
    const handle = setTimeout(() => {}, 60_000);
    clearTimeout(handle);
    const scheduled = t.mock.method(globalThis, 'setTimeout', () => handle);
    let ran = false;

    safeTimeout(async () => { ran = true; }, 10, 'test');
    const callback = scheduled.mock.calls[0].arguments[0];
    assert.ok(callback);
    await callback();

    assert.equal(ran, true);
  });
});
