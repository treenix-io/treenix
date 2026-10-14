import assert from 'node:assert/strict';
import { it } from 'node:test';
import { KernelError } from '#errors';
import { admitForeignFrames } from '#kernel/authority/frame-admission';
import { DEFAULT_LIMITS, type Connection, type Frame } from '#kernel/types';

const code = (expected: KernelError['code']) => (error: unknown) =>
  error instanceof KernelError && error.code === expected;

it('charges retained foreign positions across subscription owners and releases their exact metadata', async () => {
  const foreign = 'foreign:'.repeat(8);
  const at = [
    { instance: 'native', epoch: 1, seq: 1 },
    { instance: foreign, epoch: 1, seq: 1 },
  ];
  const snap = (sub: string): Frame => ({
    t: 'snap',
    sub,
    gen: 1,
    list: [],
    copies: [],
    covered: [],
    at,
    foreign: [foreign],
    ownership: { fixed: [], roots: [] },
  });
  const connection: Connection = {
    send() {},
    frames: {
      async *[Symbol.asyncIterator]() {
        yield snap('sub:1');
        yield snap('sub:2');
      },
    },
  };
  const bounded = admitForeignFrames(
    connection,
    () => ({ ...DEFAULT_LIMITS, laneCoverageBytes: 256 }),
    () => undefined,
  );
  bounded.send({ t: 'sub', sub: 'sub:1', selector: { node: '/one' } });
  bounded.send({ t: 'sub', sub: 'sub:2', selector: { node: '/two' } });
  const frames = bounded.frames[Symbol.asyncIterator]();
  assert.equal((await frames.next()).value?.t, 'snap');
  await assert.rejects(frames.next(), code('BUDGET'));

  const released = admitForeignFrames(
    connection,
    () => ({ ...DEFAULT_LIMITS, laneCoverageBytes: 256 }),
    () => undefined,
  );
  released.send({ t: 'sub', sub: 'sub:1', selector: { node: '/one' } });
  released.send({ t: 'sub', sub: 'sub:2', selector: { node: '/two' } });
  const retry = released.frames[Symbol.asyncIterator]();
  assert.equal((await retry.next()).value?.t, 'snap');
  released.send({ t: 'unsub', sub: 'sub:1' });
  assert.equal((await retry.next()).value?.t, 'snap');
});

it('rejects unsolicited native position spaces before the foreign cache retains them', async () => {
  const connection: Connection = {
    send() {},
    frames: {
      async *[Symbol.asyncIterator]() {
        yield { t: 'pos', pos: { instance: 'native', epoch: 1, seq: 1 }, changes: [] };
        yield { t: 'pos', pos: { instance: 'unsolicited', epoch: 1, seq: 1 }, changes: [] };
      },
    },
  };
  const bounded = admitForeignFrames(
    connection,
    () => DEFAULT_LIMITS,
    () => undefined,
  );
  const frames = bounded.frames[Symbol.asyncIterator]();
  assert.equal((await frames.next()).value?.t, 'pos');
  await assert.rejects(frames.next(), code('INVALID'));
});

it('bounds foreign request position metadata and releases it on terminal refusal', async () => {
  const position = (instance: string): Frame => ({
    t: 'pos',
    pos: { instance, epoch: 1, seq: 1 },
    producer: { req: 'req:1' },
    changes: [],
  });
  const connection: Connection = {
    send() {},
    frames: {
      async *[Symbol.asyncIterator]() {
        yield position('one'.repeat(24));
        yield position('two'.repeat(24));
      },
    },
  };
  const bounded = admitForeignFrames(
    connection,
    () => ({ ...DEFAULT_LIMITS, laneCoverageBytes: 180 }),
    () => undefined,
  );
  bounded.send({ t: 'read', req: 'req:1', selector: { node: '/one' } });
  const frames = bounded.frames[Symbol.asyncIterator]();
  assert.equal((await frames.next()).value?.t, 'pos');
  await assert.rejects(frames.next(), code('BUDGET'));
  const terminal: Connection = {
    send() {},
    frames: {
      async *[Symbol.asyncIterator]() {
        yield position('one'.repeat(24));
        yield { t: 'fail', req: 'req:1', error: new KernelError('CANCELLED', 'Request ended') };
        yield {
          t: 'snap',
          sub: 'sub:1',
          gen: 1,
          list: [],
          copies: [],
          at: [{ instance: 'native', epoch: 1, seq: 1 }],
        };
      },
    },
  };
  const released = admitForeignFrames(
    terminal,
    () => ({ ...DEFAULT_LIMITS, laneCoverageBytes: 180 }),
    () => undefined,
  );
  released.send({ t: 'read', req: 'req:1', selector: { node: '/one' } });
  released.send({ t: 'sub', sub: 'sub:1', selector: { node: '/one' } });
  const completed = released.frames[Symbol.asyncIterator]();
  assert.equal((await completed.next()).value?.t, 'pos');
  assert.equal((await completed.next()).value?.t, 'fail');
  assert.equal((await completed.next()).value?.t, 'snap');
});
