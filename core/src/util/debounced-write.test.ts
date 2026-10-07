import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { debouncedWrite } from './debounced-write';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('debouncedWrite', () => {
  it('debounces rapid triggers into one write', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const written = deferred();
    let writes = 0;
    const dw = debouncedWrite(async () => { writes++; written.resolve(); }, 50, 'test');

    dw.trigger();
    dw.trigger();
    dw.trigger();
    t.mock.timers.tick(50);
    await written.promise;

    assert.equal(writes, 1);
  });

  it('coalesces triggers while a write is in flight', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const started = deferred();
    const finish = deferred();
    let writes = 0;
    const dw = debouncedWrite(async () => { writes++; started.resolve(); await finish.promise; }, 20, 'test');

    dw.trigger();
    t.mock.timers.tick(20);
    await started.promise;
    dw.trigger();
    finish.resolve();
    await dw.flush();

    assert.equal(writes, 1);
  });

  it('flush rejects with the write failure', async (t) => {
    t.mock.method(console, 'error', () => {});
    const failure = new Error('write failed');
    const dw = debouncedWrite(async () => { throw failure; }, 10, 'test');

    await assert.rejects(dw.flush(), (error) => error === failure);
  });

  it('flush waits for an in-flight write and rejects with its failure', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    t.mock.method(console, 'error', () => {});
    const started = deferred();
    const finish = deferred();
    const failure = new Error('write failed');
    const dw = debouncedWrite(async () => { started.resolve(); await finish.promise; }, 20, 'test');

    dw.trigger();
    t.mock.timers.tick(20);
    await started.promise;
    const rejected = assert.rejects(dw.flush(), (error) => error === failure);
    finish.reject(failure);
    await rejected;
  });

  it('cancel prevents a pending write', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let writes = 0;
    const dw = debouncedWrite(async () => { writes++; }, 50, 'test');

    dw.trigger();
    dw.cancel();
    t.mock.timers.tick(50);
    await Promise.resolve();

    assert.equal(writes, 0);
  });

  it('flush executes the pending write immediately', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let writes = 0;
    const dw = debouncedWrite(async () => { writes++; }, 5_000, 'test');

    dw.trigger();
    await dw.flush();
    t.mock.timers.tick(5_000);
    await Promise.resolve();

    assert.equal(writes, 1);
  });

  it('flush writes the final state when no timer is pending', async () => {
    let writes = 0;
    const dw = debouncedWrite(async () => { writes++; }, 50, 'test');

    await dw.flush();

    assert.equal(writes, 1);
  });

  it('trigger after cancel schedules a write', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const written = deferred();
    let writes = 0;
    const dw = debouncedWrite(async () => { writes++; written.resolve(); }, 30, 'test');

    dw.trigger();
    dw.cancel();
    dw.trigger();
    t.mock.timers.tick(30);
    await written.promise;

    assert.equal(writes, 1);
  });
});
