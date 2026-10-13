import { parseNeedPattern } from '#comp/needs';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('parseNeedPattern', () => {
  it('sibling', () => {
    const spec = parseNeedPattern('payment');
    assert.deepEqual(spec, { kind: 'sibling', name: 'payment', key: 'payment' });
  });

  it('field-ref', () => {
    const spec = parseNeedPattern('@warehouseRef');
    assert.deepEqual(spec, { kind: 'field-ref', field: 'warehouseRef', key: 'warehouseRef' });
  });

  it('relative path', () => {
    const spec = parseNeedPattern('./config');
    assert.deepEqual(spec, { kind: 'path', path: './config', key: 'config' });
  });

  it('parent-relative path', () => {
    const spec = parseNeedPattern('../settings');
    assert.deepEqual(spec, { kind: 'path', path: '../settings', key: 'settings' });
  });

  it('absolute path', () => {
    const spec = parseNeedPattern('/sys/config');
    assert.deepEqual(spec, { kind: 'path', path: '/sys/config', key: 'config' });
  });

  it('children pattern', () => {
    const spec = parseNeedPattern('./items/*');
    assert.deepEqual(spec, { kind: 'children', path: './items', key: 'items' });
  });
});
