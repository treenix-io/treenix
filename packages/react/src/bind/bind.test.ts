import type { NodeData } from '@treenx/core';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { clearComputed, getComputed, setComputed, subscribeComputed } from './computed';
import { evaluateRef, extractArgPaths, hasOnce, isCollectionRef } from './eval';
import { isRefArg, parseMapExpr } from './parse';

// ── Parser ──

describe('parseMapExpr', () => {
  it('parses pipe with field chain', () => {
    const expr = parseMapExpr('last().value | div(5)');
    assert.deepEqual(expr.steps, [
      { type: 'pipe', name: 'last', args: [] },
      { type: 'field', name: 'value' },
      { type: 'pipe', name: 'div', args: [5] },
    ]);
  });

  it('parses bare pipe (no parens)', () => {
    const expr = parseMapExpr('round');
    assert.deepEqual(expr.steps, [
      { type: 'pipe', name: 'round', args: [] },
    ]);
  });

  it('parses multiple args', () => {
    const expr = parseMapExpr('clamp(0, 10)');
    assert.deepEqual(expr.steps, [
      { type: 'pipe', name: 'clamp', args: [0, 10] },
    ]);
  });

  it('parses field-only chain', () => {
    const expr = parseMapExpr('.status');
    assert.deepEqual(expr.steps, [
      { type: 'field', name: 'status' },
    ]);
  });

  it('parses complex chain', () => {
    const expr = parseMapExpr('last().value | sub(20) | abs | div(10)');
    assert.deepEqual(expr.steps, [
      { type: 'pipe', name: 'last', args: [] },
      { type: 'field', name: 'value' },
      { type: 'pipe', name: 'sub', args: [20] },
      { type: 'pipe', name: 'abs', args: [] },
      { type: 'pipe', name: 'div', args: [10] },
    ]);
  });

  it('parses map pipe', () => {
    const expr = parseMapExpr('map(value) | avg');
    assert.deepEqual(expr.steps, [
      { type: 'pipe', name: 'map', args: ['value'] },
      { type: 'pipe', name: 'avg', args: [] },
    ]);
  });

  it('parses #field as step (self lookup)', () => {
    const expr = parseMapExpr('#width | mul(#height)');
    assert.deepEqual(expr.steps, [
      { type: 'field', name: 'width' },
      { type: 'pipe', name: 'mul', args: [{ $ref: '.', fields: ['height'] }] },
    ]);
  });

  it('parses #/path.field ref arg', () => {
    const expr = parseMapExpr('#price | mul(#/config/tax.rate)');
    const mulStep = expr.steps[1];
    assert.equal(mulStep.type, 'pipe');
    if (mulStep.type === 'pipe') {
      assert.equal(isRefArg(mulStep.args[0]), true);
      assert.deepEqual(mulStep.args[0], { $ref: '/config/tax', fields: ['rate'] });
    }
  });

  it('parses #/path without field (whole node)', () => {
    const expr = parseMapExpr('count(#/sensors)');
    const step = expr.steps[0];
    if (step.type === 'pipe') {
      assert.deepEqual(step.args[0], { $ref: '/sensors', fields: [] });
    }
  });

  it('parses #/path.deep.field', () => {
    const expr = parseMapExpr('mul(#/config.tax.rate)');
    const step = expr.steps[0];
    if (step.type === 'pipe') {
      assert.deepEqual(step.args[0], { $ref: '/config', fields: ['tax', 'rate'] });
    }
  });
});

// ── Evaluator ──

describe('evaluateRef', () => {
  const config = { $path: '/config', $type: 'config', factor: 5, tax: { rate: 0.2 } } as NodeData;

  const sensors = [
    { $path: '/s/1', $type: 'reading', value: 10, seq: 0 },
    { $path: '/s/2', $type: 'reading', value: 20, seq: 1 },
    { $path: '/s/3', $type: 'reading', value: 30, seq: 2 },
  ] as NodeData[];

  const selfNode = { $path: '/obj', $type: 't3d.object', width: 4, height: 3, price: 100 } as NodeData;

  const allNodes = [...sensors, config, selfNode];

  const ctx = {
    getNode: (p: string) => allNodes.find(s => s.$path === p),
    getChildren: (p: string) => p === '/s' ? sensors : [],
  };

  it('resolves plain ref (no $map)', () => {
    const result = evaluateRef({ $ref: '/s/2' }, ctx);
    assert.equal((result as NodeData)?.value, 20);
  });

  it('resolves last().value | div(5)', () => {
    const result = evaluateRef({ $ref: '/s', $map: 'last().value | div(5)' }, ctx);
    assert.equal(result, 6); // 30 / 5
  });

  it('resolves first().value', () => {
    const result = evaluateRef({ $ref: '/s', $map: 'first().value' }, ctx);
    assert.equal(result, 10);
  });

  it('resolves count()', () => {
    const result = evaluateRef({ $ref: '/s', $map: 'count()' }, ctx);
    assert.equal(result, 3);
  });

  it('resolves map + avg', () => {
    const result = evaluateRef({ $ref: '/s', $map: 'map(value) | avg' }, ctx);
    assert.equal(result, 20); // (10+20+30)/3
  });

  it('resolves map + sum', () => {
    const result = evaluateRef({ $ref: '/s', $map: 'map(value) | sum' }, ctx);
    assert.equal(result, 60);
  });

  it('resolves scalar chain', () => {
    const result = evaluateRef({ $ref: '/s', $map: 'last().value | sub(20) | abs | div(2)' }, ctx);
    assert.equal(result, 5); // |30-20| / 2
  });

  it('resolves clamp', () => {
    const result = evaluateRef({ $ref: '/s', $map: 'last().value | clamp(0, 25)' }, ctx);
    assert.equal(result, 25); // 30 clamped to 25
  });

  it('resolves single node field access (no collection)', () => {
    const result = evaluateRef({ $ref: '/s/1', $map: '.value | mul(3)' }, ctx);
    assert.equal(result, 30); // 10 * 3
  });

  it('returns undefined for empty children', () => {
    const result = evaluateRef({ $ref: '/empty', $map: 'last().value' }, ctx);
    assert.equal(result, undefined);
  });

  // ── Self-ref + #-args ──

  it('resolves #field self lookup', () => {
    const result = evaluateRef({ $ref: '/obj', $map: '#width | mul(#height)' }, ctx);
    assert.equal(result, 12); // 4 * 3
  });

  it('resolves cross-ref #/path.field arg', () => {
    const result = evaluateRef({ $ref: '/obj', $map: '#price | mul(#/config.tax.rate)' }, ctx);
    assert.equal(result, 20); // 100 * 0.2
  });

  it('resolves external source + self arg via #', () => {
    const result = evaluateRef({ $ref: '/s', $map: 'last().value | div(#/config.factor)' }, ctx);
    assert.equal(result, 6); // 30 / 5
  });

  it('returns NaN for missing #ref node (loud failure)', () => {
    const result = evaluateRef({ $ref: '/obj', $map: '#width | mul(#/missing.value)' }, ctx);
    assert.equal(Number.isNaN(result), true); // 4 * undefined = NaN
  });
});

// ── isCollectionRef ──

describe('isCollectionRef', () => {
  it('true for last()', () => {
    assert.equal(isCollectionRef({ $ref: '/s', $map: 'last().value' }), true);
  });

  it('true for count()', () => {
    assert.equal(isCollectionRef({ $ref: '/s', $map: 'count()' }), true);
  });

  it('false for field access', () => {
    assert.equal(isCollectionRef({ $ref: '/s/1', $map: '.value' }), false);
  });

  it('false for #field self access', () => {
    assert.equal(isCollectionRef({ $ref: '.', $map: '#width' }), false);
  });

  it('false for no $map', () => {
    assert.equal(isCollectionRef({ $ref: '/s/1' }), false);
  });
});

// ── extractArgPaths ──

describe('extractArgPaths', () => {
  it('returns external paths from #/path args', () => {
    const paths = extractArgPaths({ $ref: '/obj', $map: '#price | mul(#/config.rate) | add(#/bonus.value)' });
    assert.deepEqual(paths, ['/config', '/bonus']);
  });

  it('skips # self refs', () => {
    const paths = extractArgPaths({ $ref: '.', $map: '#width | mul(#height)' });
    assert.deepEqual(paths, []);
  });

  it('returns empty for no $map', () => {
    assert.deepEqual(extractArgPaths({ $ref: '/x' }), []);
  });
});

// ── hasOnce ──

describe('hasOnce', () => {
  it('true when once in pipe chain', () => {
    assert.equal(hasOnce({ $ref: '/s', $map: 'last().value | div(5) | once' }), true);
  });

  it('true when once is only step', () => {
    assert.equal(hasOnce({ $ref: '/s', $map: 'once' }), true);
  });

  it('false for normal pipes', () => {
    assert.equal(hasOnce({ $ref: '/s', $map: 'last().value | div(5)' }), false);
  });

  it('false for no $map', () => {
    assert.equal(hasOnce({ $ref: '/s' }), false);
  });
});

// ── once pipe (identity) ──

describe('once pipe in evaluation', () => {
  const nodes = [
    { $path: '/s/1', $type: 'r', value: 10 },
    { $path: '/s/2', $type: 'r', value: 20 },
  ] as NodeData[];

  const ctx = {
    getNode: (p: string) => nodes.find(n => n.$path === p),
    getChildren: (p: string) => p === '/s' ? nodes : [],
  };

  it('once does not alter the computed value', () => {
    const withOnce = evaluateRef({ $ref: '/s', $map: 'last().value | div(5) | once' }, ctx);
    const without = evaluateRef({ $ref: '/s', $map: 'last().value | div(5)' }, ctx);
    assert.equal(withOnce, without);
    assert.equal(withOnce, 4); // 20 / 5
  });
});

// ── Computed store ──

describe('computed store', () => {
  it('set + get', () => {
    setComputed('/test', 'sy', 42);
    const c = getComputed('/test');
    assert.equal(c?.sy, 42);
    clearComputed('/test');
  });

  it('fires subscriber on change', () => {
    let fired = 0;
    const unsub = subscribeComputed('/test2', () => { fired++; });
    setComputed('/test2', 'px', 1);
    assert.equal(fired, 1);
    setComputed('/test2', 'px', 2);
    assert.equal(fired, 2);
    // No-op same value
    setComputed('/test2', 'px', 2);
    assert.equal(fired, 2);
    unsub();
    clearComputed('/test2');
  });

  it('returns new object reference on change (useSyncExternalStore compat)', () => {
    setComputed('/ref-test', 'a', 1);
    const snap1 = getComputed('/ref-test');
    setComputed('/ref-test', 'a', 2);
    const snap2 = getComputed('/ref-test');
    // Must be different references — Object.is must see the change
    assert.notEqual(snap1, snap2);
    assert.equal(snap2?.a, 2);
    // Old snapshot retains old value (immutable)
    assert.equal(snap1?.a, 1);
    clearComputed('/ref-test');
  });

  it('unsubscribe stops notifications', () => {
    let fired = 0;
    const unsub = subscribeComputed('/test3', () => { fired++; });
    unsub();
    setComputed('/test3', 'sy', 99);
    assert.equal(fired, 0);
    clearComputed('/test3');
  });
});
