import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { it } from 'node:test';
import { MessageChannel, Worker } from 'node:worker_threads';
import { KernelError } from '@treenx/core/errors';
import { WhisperRecognizer } from './native-recognizer';

const settings = { audioDir: '.', model: 'fixture', language: 'en' };
function scope(controller = new AbortController()) {
  return { signal: controller.signal, assertActive: () => controller.signal.throwIfAborted() };
}
function fixture() {
  const gate = new Int32Array(new SharedArrayBuffer(8));
  const started = new EventEmitter();
  const recognizer = new WhisperRecognizer(() => {
    const channel = new MessageChannel();
    channel.port1.on('message', () => started.emit('message'));
    channel.port1.unref();
    const worker = new Worker(new URL('./fixtures/recognizer.mjs', import.meta.url), {
      workerData: { gate: gate.buffer, started: channel.port2 },
      transferList: [channel.port2],
    });
    worker.once('exit', () => channel.port1.close());
    return worker;
  });
  return { recognizer, gate, started, close: () => recognizer.close() };
}

it(
  'recognition preserves queued results and continues after a failed job',
  { timeout: 5000 },
  async (t) => {
    const { recognizer, close } = fixture();
    t.after(close);
    const first = recognizer.recognize({ wavPath: 'first', settings }, scope());
    const second = recognizer.recognize({ wavPath: 'second', settings }, scope());
    assert.deepEqual(
      (await Promise.all([first, second])).map((result) => result.content),
      ['first', 'second'],
    );
    await assert.rejects(
      recognizer.recognize({ wavPath: 'fail', settings }, scope()),
      (error) => error instanceof KernelError && error.code === 'UNAVAILABLE',
    );
    assert.equal(
      (await recognizer.recognize({ wavPath: 'next', settings }, scope())).content,
      'next',
    );
  },
);

it(
  'blocking inference leaves the caller responsive and cancellation permits the next job',
  { timeout: 5000 },
  async (t) => {
    const { recognizer, gate, started, close } = fixture();
    t.after(close);
    const controller = new AbortController();
    const pending = recognizer.recognize({ wavPath: 'hold', settings }, scope(controller));
    await once(started, 'message');
    assert.equal(Atomics.load(gate, 0), 1);
    controller.abort(new KernelError('CANCELLED', 'Caller cancelled'));
    await assert.rejects(
      pending,
      (error) => error instanceof KernelError && error.code === 'CANCELLED',
    );
    assert.equal(
      (await recognizer.recognize({ wavPath: 'next', settings }, scope())).content,
      'next',
    );
  },
);

it(
  'worker termination rejects its pending result and a later job can recover',
  { timeout: 5000 },
  async (t) => {
    const { recognizer, close } = fixture();
    t.after(close);
    await assert.rejects(
      recognizer.recognize({ wavPath: 'crash', settings }, scope()),
      (error) => error instanceof KernelError && error.code === 'UNAVAILABLE',
    );
    assert.equal(
      (await recognizer.recognize({ wavPath: 'next', settings }, scope())).content,
      'next',
    );
  },
);
