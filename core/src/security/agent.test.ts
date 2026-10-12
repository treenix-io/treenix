import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hashAgentKey, timingSafeCompare } from './agent';

describe('hashAgentKey', () => {
  it('produces consistent SHA-256 hex', () => {
    const h1 = hashAgentKey('test-secret');
    const h2 = hashAgentKey('test-secret');
    assert.equal(h1, h2);
    assert.equal(h1.length, 64); // SHA-256 = 32 bytes = 64 hex chars
  });

  it('different keys produce different hashes', () => {
    assert.notEqual(hashAgentKey('key-a'), hashAgentKey('key-b'));
  });
});

describe('timingSafeCompare', () => {
  it('returns true for matching hashes', () => {
    const h = hashAgentKey('secret');
    assert.equal(timingSafeCompare(h, h), true);
  });

  it('returns false for different hashes', () => {
    assert.equal(timingSafeCompare(hashAgentKey('a'), hashAgentKey('b')), false);
  });

  it('returns false for different lengths', () => {
    assert.equal(timingSafeCompare('aa', 'bbbb'), false);
  });

  it('R5-AGENT-1: returns false for undefined / non-string / empty inputs', () => {
    const h = hashAgentKey('secret');
    assert.equal(timingSafeCompare(undefined, h), false);
    assert.equal(timingSafeCompare(h, undefined), false);
    assert.equal(timingSafeCompare(null, null), false);
    assert.equal(timingSafeCompare(42, h), false);
    assert.equal(timingSafeCompare('', ''), false);
    assert.equal(timingSafeCompare(h, ''), false);
  });
});
