import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canonicalReadPlan, planHash } from './plan-hash';

describe('planHash (core-hp7)', () => {
  it('equal plans hash equal regardless of where-key construction order', () => {
    const a = planHash({ source: '/orders', viewWhere: { status: 'new', kind: 'a' } });
    const b = planHash({ source: '/orders', viewWhere: { kind: 'a', status: 'new' } });
    assert.equal(a, b);
  });

  it('different callerWhere → different hash', () => {
    const a = planHash({ source: '/orders', callerWhere: { status: 'new' } });
    const b = planHash({ source: '/orders', callerWhere: { status: 'open' } });
    assert.notEqual(a, b);
  });

  it('different source → different hash', () => {
    assert.notEqual(planHash({ source: '/a' }), planHash({ source: '/b' }));
  });

  it('viewWhere and callerWhere are distinct identity slots', () => {
    const asView = planHash({ source: '/x', viewWhere: { s: 1 } });
    const asCaller = planHash({ source: '/x', callerWhere: { s: 1 } });
    assert.notEqual(asView, asCaller, 'trusted vs untrusted predicate must not alias');
  });

  it('canonical form excludes non-identity metadata (viewPath stays out)', () => {
    // A future ReadPlan may carry request metadata — identity picks fields
    // explicitly, so extras never leak into the hash.
    const plain = { source: '/x' };
    const decorated = { source: '/x', viewPath: '/views/open', mountDeps: ['/views/open'] };
    assert.deepEqual(canonicalReadPlan(decorated), canonicalReadPlan(plain));
    assert.equal(planHash(decorated), planHash(plain));
  });

  it('nested where objects canonicalize deep', () => {
    const a = planHash({ source: '/x', callerWhere: { $and: [{ a: 1, b: 2 }] } });
    const b = planHash({ source: '/x', callerWhere: { $and: [{ b: 2, a: 1 }] } });
    assert.equal(a, b);
  });
});
