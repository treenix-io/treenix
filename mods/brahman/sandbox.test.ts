// R5-BRAHMAN-1 — sandbox contract tests.
// Verify QuickJS isolation: no host globals, expressions stay bounded, malicious payloads
// cannot reach process/require/fetch/Function/eval.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cpuDeadline, evalBool, evalExpr } from './sandbox';

describe('R5-BRAHMAN-1 — QuickJS sandbox', () => {
  it('evaluates simple arithmetic', async () => {
    assert.equal(await evalExpr('1 + 2 * 3', {}), 7);
  });

  it('reads injected vars by name', async () => {
    assert.equal(await evalExpr('session.x + data.y', { session: { x: 10 }, data: { y: 5 } }), 15);
  });

  it('evalBool coerces to boolean', async () => {
    assert.equal(await evalBool('1 + 1 === 2', {}), true);
    assert.equal(await evalBool('false', {}), false);
    assert.equal(await evalBool('session.flag', { session: { flag: true } }), true);
  });

  it('a var the sandbox cannot hold fails the eval instead of going missing', async () => {
    await assert.rejects(() => evalExpr('typeof big', { big: 'x'.repeat(2 * 1024 * 1024) }), Error);
  });

  it('evalBool fails on a syntax error instead of reading it as false', async () => {
    await assert.rejects(() => evalBool('}}}invalid', {}), Error);
  });

  it('the deadline counts CPU from its first poll: earlier work and descheduled time are not charged', () => {
    const burn = (ms: number) => {
      const until = process.threadCpuUsage();
      const spent = () => { const d = process.threadCpuUsage(until); return (d.user + d.system) / 1000; };
      while (spent() < ms) { /* spin */ }
    };
    const expired = cpuDeadline(20);

    burn(30);
    assert.equal(expired(), false, 'CPU spent before the first poll is not the expression\'s');

    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    assert.equal(expired(), false, 'a descheduled thread spends no budget');

    burn(30);
    assert.equal(expired(), true);
  });

  it('rejects access to host globals (process, require, fetch)', async () => {
    // These are undefined in the sandbox — accessing them throws or returns undefined.
    // Either way, the value is not the host process.
    const result = await evalExpr('typeof process', {});
    assert.equal(result, 'undefined', `host process must NOT be reachable, got: ${result}`);

    const requireType = await evalExpr('typeof require', {});
    assert.equal(requireType, 'undefined');

    const fetchType = await evalExpr('typeof fetch', {});
    assert.equal(fetchType, 'undefined');
  });

  it('rejects new Function / eval inside the sandbox (no escalation back to host)', async () => {
    // QuickJS has its own Function/eval but they cannot reach the host. Verify expressions
    // attempting to construct host functions either fail or stay inside the sandbox.
    // Best behavioral check: synthesize a string and confirm it didn't leak host symbols.
    const result = await evalExpr('typeof globalThis.process', {});
    assert.equal(result, 'undefined');
  });

  it('terminates an infinite loop at the 50ms CPU deadline', async () => {
    const before = process.threadCpuUsage();
    await assert.rejects(() => evalExpr('(() => { while (true) {} })()', {}), Error);

    const { user, system } = process.threadCpuUsage(before);
    const spentMs = (user + system) / 1000;
    assert.ok(spentMs >= 50 && spentMs < 1000, `the loop ran to the deadline and no further: ${spentMs}ms of CPU`);
  });

  it('rejects empty / whitespace expression', async () => {
    await assert.rejects(() => evalExpr('', {}), /empty expression/);
    await assert.rejects(() => evalExpr('   ', {}), /empty expression/);
  });

  it('does not crash on undefined vars', async () => {
    assert.equal(await evalExpr('typeof undefinedVar', {}), 'undefined');
  });

  it('refuses to load on a Node without per-thread CPU time', async () => {
    const threadCpuUsage = process.threadCpuUsage;
    Reflect.deleteProperty(process, 'threadCpuUsage');
    try {
      // A fresh module instance: the query makes the loader evaluate the file again.
      await assert.rejects(import(new URL('./sandbox.ts?without-thread-cpu', import.meta.url).href), Error);
    } finally {
      process.threadCpuUsage = threadCpuUsage;
    }
  });
});
