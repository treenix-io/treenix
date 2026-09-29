import assert from 'node:assert';
import { describe, it } from 'node:test';
import { KernelError } from '#errors';
import { createPathLock } from './path-lock';

const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// Let queued lock callbacks (prev.then chains) start without wall-clock waits.
const drainMicrotasks = async (n = 10) => {
  for (let i = 0; i < n; i++) await new Promise<void>(r => queueMicrotask(r));
};

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

  it('subtree span excludes a concurrent acquire under the prefix; unrelated paths run free (core-anz4.5)', async () => {
    const lock = createPathLock();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });

    const span = lock.subtree('/a', async () => {
      order.push('span-start');
      await gate;
      order.push('span-end');
    });
    await drainMicrotasks(); // span registered and running

    const under = lock('/a/x', async () => { order.push('under'); });
    await lock('/b', async () => { order.push('outside'); });

    release();
    await Promise.all([span, under]);
    assert.deepStrictEqual(order, ['span-start', 'outside', 'span-end', 'under']);
  });

  it('subtree drains an in-flight holder below the prefix before running', async () => {
    const lock = createPathLock();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });

    const holder = lock('/a/x', async () => { order.push('holder-start'); await gate; order.push('holder-end'); });
    await drainMicrotasks();
    const span = lock.subtree('/a', async () => { order.push('span'); });
    await drainMicrotasks();
    assert.deepStrictEqual(order, ['holder-start'], 'span parked on the in-flight holder');

    release();
    await Promise.all([holder, span]);
    assert.deepStrictEqual(order, ['holder-start', 'holder-end', 'span']);
  });

  it('a chain holding a lock inside a foreign span CONFLICTs on a further acquire under it — the would-be cycle edge', async () => {
    const lock = createPathLock();
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });

    const holder = lock('/a/b', async () => {
      await gate;
      // subtree('/a') is draining our tail; parking on its gate while holding
      // /a/b would close a wait cycle — the ordered-wait rule rejects instead.
      await assert.rejects(
        lock('/a/c', async () => {}),
        (e: unknown) => e instanceof KernelError && e.code === 'CONFLICT',
      );
    });
    await drainMicrotasks();
    const span = lock.subtree('/a', async () => 'span-ran');
    await drainMicrotasks();

    release();
    const [, ran] = await Promise.all([holder, span]);
    assert.strictEqual(ran, 'span-ran');
  });

  it('the span owner acquires nested locks under its own prefix inline', async () => {
    const lock = createPathLock();
    const result = await lock.subtree('/a', async () =>
      lock('/a/b', async () => lock('/a', async () => 'deep')),
    );
    assert.strictEqual(result, 'deep');
  });

  it('overlapping spans serialize; the prefix deregisters at span end', async () => {
    const lock = createPathLock();
    const order: string[] = [];
    const s1 = lock.subtree('/a', async () => { order.push('s1'); });
    const s2 = lock.subtree('/a', async () => { order.push('s2'); });
    await Promise.all([s1, s2]);
    await lock('/a/x', async () => { order.push('x'); });
    assert.deepStrictEqual(order, ['s1', 's2', 'x']);
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
