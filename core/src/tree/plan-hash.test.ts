import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { KernelError } from '#errors';
import { canonicalReadPlan, decodeReadCursor, encodeReadCursor, planHash } from './plan-hash';

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

  it('depth is part of plan identity; default aliases explicit 1 (core-0bl)', () => {
    assert.equal(planHash({ source: '/x' }), planHash({ source: '/x', depth: 1 }));
    assert.notEqual(planHash({ source: '/x' }), planHash({ source: '/x', depth: 2 }));
    assert.notEqual(planHash({ source: '/x', depth: 2 }), planHash({ source: '/x', depth: -1 }));
  });
});

describe('ReadCursor (core-8an)', () => {
  const hash = planHash({ source: '/x' });

  it('round-trips storage cursors containing delimiters and unicode', () => {
    for (const sc of ['/x/a', 'a.b.c', 'страница•2', '{"k":1}', '']) {
      assert.equal(decodeReadCursor(encodeReadCursor(hash, sc), hash), sc);
    }
  });

  it('rejects a cursor minted under a different plan hash', () => {
    const other = planHash({ source: '/y' });
    assert.throws(
      () => decodeReadCursor(encodeReadCursor(other, '/y/a'), hash),
      (e: unknown) => e instanceof KernelError && e.code === 'INVALID',
    );
  });

  it('rejects malformed cursors', () => {
    for (const bad of ['', '/raw/path', `${hash}.not!base64url`, `${hash}.a.b`]) {
      assert.throws(
        () => decodeReadCursor(bad, hash),
        (e: unknown) => e instanceof KernelError && e.code === 'INVALID',
        `cursor ${JSON.stringify(bad)} must be rejected`,
      );
    }
  });
});
