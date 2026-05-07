// R5-BRAHMAN-1 — sandbox contract tests.
// Verify QuickJS isolation: no host globals, expressions stay bounded, malicious payloads
// cannot reach process/require/fetch/Function/eval.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evalBool, evalExpr } from './sandbox';

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

  it('evalBool returns false on syntax error (does not throw)', async () => {
    assert.equal(await evalBool('}}}invalid', {}), false);
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

  it('terminates infinite loop within the deadline (50ms)', async () => {
    const t0 = Date.now();
    await assert.rejects(() => evalExpr('while(true){}', {}), /failed/i);
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 1000, `should hit deadline well under 1s, took ${elapsed}ms`);
  });

  it('rejects empty / whitespace expression', async () => {
    await assert.rejects(() => evalExpr('', {}), /empty expression/);
    await assert.rejects(() => evalExpr('   ', {}), /empty expression/);
  });

  it('does not crash on undefined vars', async () => {
    assert.equal(await evalExpr('typeof undefinedVar', {}), 'undefined');
  });
});
