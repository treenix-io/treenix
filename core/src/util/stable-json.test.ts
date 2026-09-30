import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { stableJson } from './stable-json';

describe('stableJson', () => {
  it('orders keys by code unit, independent of locale collation', () => {
    assert.equal(stableJson({ a: 1, B: 2, _: 3, Z: { y: 1, X: 2 } }), '{"B":2,"Z":{"X":2,"y":1},"_":3,"a":1}');
  });

  it('keys a collation ranks equal still order by content, not construction', () => {
    const composed = String.fromCharCode(0xe9);
    const decomposed = 'e' + String.fromCharCode(0x301);
    assert.equal(
      stableJson({ [composed]: 1, [decomposed]: 2 }),
      stableJson({ [decomposed]: 2, [composed]: 1 }),
    );
  });

  it('equal values built in different key orders stringify identically at every level', () => {
    assert.equal(
      stableJson({ q: { $or: [{ b: 1, a: 2 }] }, depth: 1 }),
      stableJson({ depth: 1, q: { $or: [{ a: 2, b: 1 }] } }),
    );
  });
});
