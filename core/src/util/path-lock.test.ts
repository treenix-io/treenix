import assert from 'node:assert';
import { describe, it } from 'node:test';
import { createPathLock } from './path-lock';

const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

describe('createPathLock', () => {

  it('serializes concurrent ops on same path', async () => {
    const lock = createPathLock();
    const order: string[] = [];

    const a = lock('/x', async () => {
      order.push('a-start');
      await delay(50);
      order.push('a-end');
      return 'a';
    });

    const b = lock('/x', async () => {
      order.push('b-start');
      await delay(10);
      order.push('b-end');
      return 'b';
    });

    const [ra, rb] = await Promise.all([a, b]);
    assert.strictEqual(ra, 'a');
    assert.strictEqual(rb, 'b');
    assert.deepStrictEqual(order, ['a-start', 'a-end', 'b-start', 'b-end']);
  });

  it('runs different paths in parallel', async () => {
    const lock = createPathLock();
    const order: string[] = [];

    const a = lock('/a', async () => {
      order.push('a-start');
      await delay(50);
      order.push('a-end');
    });

    const b = lock('/b', async () => {
      order.push('b-start');
      await delay(50);
      order.push('b-end');
    });

    await Promise.all([a, b]);
    assert.strictEqual(order[0], 'a-start');
    assert.strictEqual(order[1], 'b-start');
  });

  it('releases lock on error — next op proceeds', async () => {
    const lock = createPathLock();
    const results: string[] = [];

    await lock('/x', async () => { throw new Error('fail'); }).catch(() => {});
    results.push(await lock('/x', async () => 'ok'));

    assert.deepStrictEqual(results, ['ok']);
  });

  it('three ops on same path — strict FIFO', async () => {
    const lock = createPathLock();
    const order: number[] = [];

    const ops = [1, 2, 3].map(i =>
      lock('/x', async () => { order.push(i); await delay(10); }),
    );

    await Promise.all(ops);
    assert.deepStrictEqual(order, [1, 2, 3]);
  });

  it('reentrant on same path within one chain — no self-deadlock (core-0fa)', async () => {
    const lock = createPathLock();
    // Nested same-path acquire in the SAME chain must run inline, not await the
    // outer's gate (which only releases after fn returns → classic deadlock).
    const run = lock('/x', async () => {
      const inner = await lock('/x', async () => 'inner');
      return `outer:${inner}`;
    });
    const guarded = await Promise.race([run, delay(1000).then(() => 'TIMEOUT')]);
    assert.strictEqual(guarded, 'outer:inner', 'nested same-path lock resolved without deadlock');
  });

  it('nested acquire of a different path within a held chain (core-0fa)', async () => {
    const lock = createPathLock();
    const order: string[] = [];
    const result = await lock('/a', async () => {
      order.push('a');
      const r = await lock('/b', async () => { order.push('b'); return 'b-done'; });
      order.push('a-after');
      return r;
    });
    assert.strictEqual(result, 'b-done');
    assert.deepStrictEqual(order, ['a', 'b', 'a-after']);
  });

  it('reentrancy does NOT bypass serialization across distinct chains', async () => {
    const lock = createPathLock();
    const order: string[] = [];
    // Two independent top-level chains on /x still serialize FIFO.
    const a = lock('/x', async () => { order.push('a-start'); await delay(30); order.push('a-end'); });
    const b = lock('/x', async () => { order.push('b-start'); await delay(5); order.push('b-end'); });
    await Promise.all([a, b]);
    assert.deepStrictEqual(order, ['a-start', 'a-end', 'b-start', 'b-end']);
  });

  it('independent lock instances dont interfere', async () => {
    const lockA = createPathLock();
    const lockB = createPathLock();
    const order: string[] = [];

    const a = lockA('/x', async () => {
      order.push('a-start');
      await delay(50);
      order.push('a-end');
    });

    const b = lockB('/x', async () => {
      order.push('b-start');
      await delay(10);
      order.push('b-end');
    });

    await Promise.all([a, b]);
    // Different instances → parallel even on same path
    assert.strictEqual(order[0], 'a-start');
    assert.strictEqual(order[1], 'b-start');
  });
});
