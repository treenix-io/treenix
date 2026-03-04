import { resolve } from '#core';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import './index';

// Text binding registers on import, but clearRegistry would wipe them.
// So we test after import, without clearing.

describe('Text binding', () => {
  it('string renders value', () => {
    const h = resolve('string', 'text');
    assert.ok(h);
    assert.equal(h({ value: 'hello' }), 'hello');
    assert.equal(h({ value: 42 }), '42');
    assert.equal(h({}), '');
  });

  it('number renders value', () => {
    const h = resolve('number', 'text');
    assert.ok(h);
    assert.equal(h({ value: 3.14 }), '3.14');
    assert.equal(h({}), '0');
  });

  it('boolean renders yes/no', () => {
    const h = resolve('boolean', 'text');
    assert.ok(h);
    assert.equal(h({ value: true }), 'yes');
    assert.equal(h({ value: false }), 'no');
  });
});
