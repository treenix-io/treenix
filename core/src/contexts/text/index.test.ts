import { normalizeType } from '#core/component';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { clientModules } from './index';

function ownedText(type: string) {
  const entry = clientModules[0].open.find(entry => entry.type === normalizeType(type) && entry.context === 'text');
  assert.ok(entry);
  return entry.handler;
}

describe('Text binding', () => {
  it('string renders value', () => {
    const h = ownedText('string');
    assert.ok(h);
    assert.equal(h({ value: 'hello' }), 'hello');
    assert.equal(h({ value: 42 }), '42');
    assert.equal(h({}), '');
  });

  it('number renders value', () => {
    const h = ownedText('number');
    assert.ok(h);
    assert.equal(h({ value: 3.14 }), '3.14');
    assert.equal(h({}), '0');
  });

  it('boolean renders yes/no', () => {
    const h = ownedText('boolean');
    assert.ok(h);
    assert.equal(h({ value: true }), 'yes');
    assert.equal(h({ value: false }), 'no');
  });
});
